// A session: binds workspaces and a model, runs turns through the agent loop, and logs every step as events.

import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { runAgent } from "@trail-agent/agent"
import { rejectionMessage, renderReport, validateClaims, type Validation } from "@trail-agent/evidence"
import { computeCost, type LlmEvent, type Provider } from "@trail-agent/llm"
import {
  eventsOfType,
  type Claim,
  type Evidence,
  type Message,
  type PermissionDecision,
  type SessionWorkspace,
  type ToolCall,
  type ToolResultMessage,
  type TrailEvent,
  type TurnEndReason,
} from "@trail-agent/protocol"
import {
  builtinTools,
  COMPLETE_TOOL_NAME,
  completeSpec,
  createFileTracker,
  validate,
  type ToolDefinition,
  type ToolRunResult,
} from "@trail-agent/tools"
import { createLocalOperations, type Operations } from "@trail-agent/workspace"
import { checkPermission } from "./permissions.ts"
import { buildSystemPrompt } from "./prompt.ts"
import type { EventStore } from "./store.ts"
import { buildContext } from "./view.ts"

const MAX_REJECTIONS = 3
const MAX_REMINDERS = 2
const MAX_OUTPUT_LINES = 2000
const MAX_OUTPUT_BYTES = 50 * 1024
const HEAD_LINES = 200
const TAIL_LINES = 100
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"]

const REMINDER =
  "You changed files but have not called complete. Verify the change (for example run the tests), then call complete with claims citing evidence ids. If something blocks you, say what it is."

export interface ApprovalRequest {
  tool: string
  workspace: string
  summary: string
  reason: string
}

export interface SessionDeps {
  store: EventStore
  provider: Provider
  approve(request: ApprovalRequest): Promise<PermissionDecision>
  maxSteps?: number
  onEvent?(event: TrailEvent): void
  onStream?(event: LlmEvent): void
  onToolOutput?(chunk: string): void
}

export interface TurnResult {
  reason: TurnEndReason
  error?: string
  report?: string
  validation?: Validation
}

export interface Session {
  readonly id: string
  readonly workspaces: SessionWorkspace[]
  send(text: string, signal?: AbortSignal): Promise<TurnResult>
  /** Queue a message for the running turn; it reaches the model before its next request. */
  steer(text: string): void
  events(): TrailEvent[]
}

export interface NewSession {
  workspaces: SessionWorkspace[]
  primary: string
  title: string
}

export async function createSession(deps: SessionDeps, init: NewSession): Promise<Session> {
  const id = randomUUID()
  deps.store.createSession({ id, createdAt: Date.now(), title: init.title, model: deps.provider.config.id, primary: init.primary, workspaces: init.workspaces })
  const event = deps.store.append(id, "session/created", { title: init.title, workspaces: init.workspaces, primary: init.primary, model: deps.provider.config.id })
  deps.onEvent?.(event)
  return openSession(deps, id)
}

export async function openSession(deps: SessionDeps, idOrPrefix: string): Promise<Session> {
  const row = deps.store.findSession(idOrPrefix)
  if (!row) throw new Error(`No session ${idOrPrefix}`)
  const sessionId = row.id
  const { store, provider } = deps
  const ops = new Map<string, Operations>(row.workspaces.map((w) => [w.alias, operationsFor(w)]))
  const system = await systemPrompt(row.workspaces, row.primary, ops)
  const tracker = createFileTracker()
  const sessionAllowed = new Set<string>()
  const steering: Message[] = []
  const tools = new Map<string, ToolDefinition>(builtinTools.map((t) => [t.spec.name, t]))
  const specs = [...builtinTools.map((t) => t.spec), completeSpec]

  const log: EventStore["append"] = (sid, type, payload) => {
    const event = store.append(sid, type, payload)
    deps.onEvent?.(event)
    return event
  }
  const allEvidence = (): Evidence[] => eventsOfType(store.events(sessionId), "evidence/recorded").map((e) => e.payload.evidence)

  return {
    id: sessionId,
    workspaces: row.workspaces,
    events: () => store.events(sessionId),
    steer(text) {
      steering.push({ role: "user", text })
    },
    async send(text, signal) {
      const turnStart = log(sessionId, "turn/start", {}).seq
      log(sessionId, "user/message", { text })
      const context = buildContext(store.events(sessionId))
      const pendingResults = new Map<string, { evidenceId?: string; fullOutputHash?: string }>()
      let rejections = 0
      let reminders = 0
      let completed: { report: string; validation: Validation; proofFailed: boolean } | undefined

      const executeTool = async (call: ToolCall, toolSignal?: AbortSignal) => {
        log(sessionId, "tool/call", { callId: call.id, name: call.name, args: call.args })
        const result: ToolRunResult & { terminate?: boolean } = call.name === COMPLETE_TOOL_NAME ? handleComplete(call) : await runTool(call, toolSignal)
        const message: ToolResultMessage = { role: "tool", callId: call.id, name: call.name, content: result.content, isError: result.isError ?? false }
        return { message, terminate: result.terminate }
      }

      const handleComplete = (call: ToolCall): ToolRunResult & { terminate?: boolean } => {
        const problems = validate(completeSpec.parameters, call.args)
        if (problems.length > 0) return { content: `Invalid complete call: ${problems.join("; ")}`, isError: true }
        const args = call.args as { summary: string; claims: Claim[] }
        log(sessionId, "complete/submitted", { callId: call.id, summary: args.summary, claims: args.claims })
        const validation = validateClaims({ claims: args.claims, evidence: allEvidence(), primaryWorkspace: row.primary })
        if (validation.accepted) {
          log(sessionId, "complete/accepted", { callId: call.id, warnings: validation.warnings })
          completed = { report: renderReport({ summary: args.summary, validation }), validation, proofFailed: false }
          return { content: "Accepted. The report has been shown to the user.", terminate: true }
        }
        const reasons = [...validation.checks.flatMap((c) => c.problems), ...validation.problems]
        log(sessionId, "complete/rejected", { callId: call.id, problems: reasons })
        rejections++
        if (rejections >= MAX_REJECTIONS) {
          completed = { report: renderReport({ summary: args.summary, validation, proofFailed: true }), validation, proofFailed: true }
          return { content: `${rejectionMessage(validation)}\nGiving up after ${MAX_REJECTIONS} rejected attempts.`, isError: true, terminate: true }
        }
        return { content: rejectionMessage(validation), isError: true }
      }

      const runTool = async (call: ToolCall, toolSignal?: AbortSignal): Promise<ToolRunResult> => {
        const tool = tools.get(call.name)
        if (!tool) return { content: `Unknown tool ${call.name}. Available: ${specs.map((s) => s.name).join(", ")}`, isError: true }
        const problems = validate(tool.spec.parameters, call.args)
        if (problems.length > 0) return { content: `Invalid arguments: ${problems.join("; ")}`, isError: true }
        const args = call.args as Record<string, unknown>
        const alias = typeof args.workspace === "string" ? args.workspace : row.primary
        const workspace = row.workspaces.find((w) => w.alias === alias)
        const workspaceOps = ops.get(alias)
        if (!workspace || !workspaceOps) {
          return { content: `Unknown workspace "${alias}". Workspaces: ${row.workspaces.map((w) => w.alias).join(", ")}`, isError: true }
        }

        const command = tool.effect === "exec" && typeof args.command === "string" ? args.command : undefined
        const path = typeof args.path === "string" ? workspaceOps.resolve(args.path) : undefined
        const allowKey = `${alias}:${tool.spec.name}`
        const permission = checkPermission({
          effect: tool.effect,
          level: workspace.permission,
          command,
          insideRoot: tool.effect === "write" && path ? workspaceOps.isInside(path) : undefined,
          sessionAllowed: sessionAllowed.has(allowKey),
        })
        if (permission.decision === "deny") return { content: `Permission denied in workspace "${alias}": ${permission.reason}.`, isError: true }
        if (permission.decision === "ask") {
          const summary = tool.describe(args)
          log(sessionId, "permission/asked", { callId: call.id, tool: tool.spec.name, workspace: alias, summary, reason: permission.reason })
          const decision = await deps.approve({ tool: tool.spec.name, workspace: alias, summary, reason: permission.reason })
          log(sessionId, "permission/answered", { callId: call.id, decision })
          if (decision === "deny") return { content: "The user denied this action. Do not retry it; ask the user how to proceed if it is needed.", isError: true }
          if (decision === "allow_session" && !permission.reason.startsWith("dangerous")) sessionAllowed.add(allowKey)
        }

        let result: ToolRunResult
        try {
          result = await tool.execute(args, {
            ops: workspaceOps,
            workspace: alias,
            tracker,
            signal: toolSignal,
            onOutput: deps.onToolOutput,
            readOutput: (evidenceId) => {
              const evidence = allEvidence().find((e) => e.id === evidenceId)
              return evidence?.outputHash ? store.getBlob(evidence.outputHash) : undefined
            },
          })
        } catch (error) {
          return { content: `Tool failed: ${error instanceof Error ? error.message : String(error)}`, isError: true }
        }
        return finishResult(call, alias, result)
      }

      /** Record evidence, store the full output, truncate what the model sees, and append the evidence line. */
      const finishResult = (call: ToolCall, alias: string, result: ToolRunResult): ToolRunResult => {
        const fullOutputHash = store.putBlob(result.content)
        let evidence: Evidence | undefined
        if (result.evidence) {
          const number = eventsOfType(store.events(sessionId), "evidence/recorded").length + 1
          evidence = { ...result.evidence, id: `ev_${number}`, workspace: alias, seq: store.nextSeq(sessionId), outputHash: fullOutputHash }
          log(sessionId, "evidence/recorded", { evidence })
        }
        const truncated = truncate(result.content, evidence?.id)
        pendingResults.set(call.id, { evidenceId: evidence?.id, fullOutputHash: truncated === result.content ? undefined : fullOutputHash })
        return { ...result, content: evidence ? `${truncated}\n${evidenceLine(evidence)}` : truncated }
      }

      const outcome = await runAgent(
        context,
        {
          provider,
          system,
          tools: specs,
          maxSteps: deps.maxSteps ?? 100,
          hooks: {
            onRequest(http) {
              const body = JSON.stringify(http.body)
              log(sessionId, "llm/request", { model: provider.config.model, protocol: provider.config.protocol, url: http.url, bodyHash: store.putBlob(body), bodyBytes: Buffer.byteLength(body) })
            },
            onStreamEvent: deps.onStream,
            onAssistantMessage(message, meta) {
              log(sessionId, "llm/response", { stopReason: message.stopReason, durationMs: Math.round(meta.durationMs), firstTokenMs: meta.firstTokenMs === undefined ? undefined : Math.round(meta.firstTokenMs), error: message.errorMessage })
              if (message.usage) log(sessionId, "llm/usage", { model: provider.config.model, usage: message.usage, cost: computeCost(message.usage, provider.config.price) })
            },
            // User messages (steering, reminders) are logged where they are created, so only these two are logged here.
            onMessageAdded(message) {
              if (message.role === "assistant") log(sessionId, "assistant/message", { message })
              else if (message.role === "tool") {
                const meta = pendingResults.get(message.callId) ?? {}
                log(sessionId, "tool/result", { callId: message.callId, name: message.name, content: message.content, isError: message.isError, ...meta })
              }
            },
            executeTool,
            takeSteering() {
              const queued = steering.splice(0)
              for (const message of queued) if (message.role === "user") log(sessionId, "user/message", { text: message.text })
              return queued.map((m) => ({ ...m }))
            },
            onNoToolCalls() {
              const changedFiles = allEvidence().some((e) => e.kind === "file_write" && e.seq > turnStart)
              if (!changedFiles || completed || reminders >= MAX_REMINDERS) return []
              reminders++
              log(sessionId, "reminder/added", { text: REMINDER })
              return [{ role: "user", text: REMINDER }]
            },
          },
        },
        signal,
      )
      const reason: TurnEndReason = completed?.proofFailed ? "proof_failed" : outcome.reason
      log(sessionId, "turn/end", { reason })
      return { reason, error: outcome.error, report: completed?.report, validation: completed?.validation }
    },
  }
}

function operationsFor(workspace: SessionWorkspace): Operations {
  if (workspace.workspace.kind === "local") return createLocalOperations(workspace.workspace.path)
  throw new Error(`SSH workspaces arrive in milestone M2 (workspace "${workspace.alias}")`)
}

async function systemPrompt(workspaces: SessionWorkspace[], primary: string, ops: Map<string, Operations>): Promise<string> {
  const prompted = await Promise.all(
    workspaces.map(async (w) => {
      const o = ops.get(w.alias)!
      const info = await o.info()
      return { alias: w.alias, primary: w.alias === primary, os: info.os, shell: info.shell, root: o.root, permission: w.permission, role: w.role }
    }),
  )
  const instructions: Array<{ workspace: string; file: string; content: string }> = []
  for (const w of workspaces) {
    if (w.workspace.kind !== "local") continue
    const file = INSTRUCTION_FILES.find((name) => existsSync(join(w.workspace.path, name)))
    if (file) instructions.push({ workspace: w.alias, file, content: readFileSync(join(w.workspace.path, file), "utf8") })
  }
  return buildSystemPrompt({ workspaces: prompted, instructions, date: new Date().toLocaleDateString("sv-SE") })
}

function evidenceLine(evidence: Evidence): string {
  const parts = [evidence.id, evidence.workspace]
  if (evidence.kind === "exec") parts.push(`exit ${evidence.exitCode}`, `${((evidence.durationMs ?? 0) / 1000).toFixed(1)}s`)
  else if (evidence.kind === "file_write") parts.push(`wrote ${evidence.path}`)
  else if (evidence.kind === "file_read") parts.push(`read ${evidence.path}`)
  return `[evidence: ${parts.join(" | ")}]`
}

/** Keep the head and tail of long output; the full text stays retrievable through read_output. */
export function truncate(content: string, evidenceId: string | undefined): string {
  const lines = content.split("\n")
  if (lines.length <= MAX_OUTPUT_LINES && Buffer.byteLength(content) <= MAX_OUTPUT_BYTES) return content
  const clip = (part: string[], bytes: number) => {
    const kept: string[] = []
    let used = 0
    for (const line of part) {
      used += Buffer.byteLength(line) + 1
      if (used > bytes) break
      kept.push(line)
    }
    return kept
  }
  const head = clip(lines.slice(0, HEAD_LINES), MAX_OUTPUT_BYTES / 2)
  const tail = clip(lines.slice(-TAIL_LINES).reverse(), MAX_OUTPUT_BYTES / 4).reverse()
  const omitted = lines.length - head.length - tail.length
  const hint = evidenceId ? `read_output("${evidenceId}", offset) shows the rest` : "narrow the request to see the rest"
  return `${head.join("\n")}\n[... ${omitted} lines omitted; ${hint} ...]\n${tail.join("\n")}`
}
