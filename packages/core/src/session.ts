// A session: binds workspaces and a model, runs turns through the agent loop, and logs every step as events.

import { randomUUID } from "node:crypto"
import { runAgent } from "@trail-agent/agent"
import { rejectionMessage, renderReport, validateClaims, type Validation } from "@trail-agent/evidence"
import { computeCost, type HttpRequest, type LlmEvent, type Provider } from "@trail-agent/llm"
import {
  eventsOfType,
  type AssistantMessage,
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
  TASK_TOOL_NAME,
  taskSpec,
  createFileTracker,
  validate,
  type ToolDefinition,
  type ToolRunResult,
} from "@trail-agent/tools"
import { createLocalOperations, type Operations } from "@trail-agent/workspace"
import { createCompactor, DEFAULT_COMPACTION, type CompactionSettings } from "./compaction.ts"
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

const SUBAGENT_MAX_STEPS = 40
const SUBAGENT_NOTE = `

<subagent>
You are a subagent working for another agent, not talking to the user. Do the investigation described in the prompt, then reply with a concise report of what you found, citing evidence ids. You cannot call complete or task. Do not change files unless the prompt asks you to.
</subagent>`

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
  /** Creates Operations for a workspace; the default supports local workspaces only. SSH needs secrets from the host app. */
  operations?(workspace: SessionWorkspace): Operations
  compaction?: Partial<CompactionSettings>
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
  /** Close remote connections. */
  close(): void
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
  const ops = new Map<string, Operations>(row.workspaces.map((w) => [w.alias, (deps.operations ?? localOperations)(w)]))
  const system = await systemPrompt(row.workspaces, row.primary, ops)
  const tracker = createFileTracker()
  const sessionAllowed = new Set<string>()
  const steering: Message[] = []
  const tools = new Map<string, ToolDefinition>(builtinTools.map((t) => [t.spec.name, t]))
  const childSpecs = builtinTools.map((t) => t.spec)
  const specs = [...childSpecs, completeSpec, taskSpec]

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
    close() {
      for (const o of ops.values()) (o as Operations & { close?(): void }).close?.()
    },
    steer(text) {
      steering.push({ role: "user", text })
    },
    async send(text, signal) {
      const turnStart = log(sessionId, "turn/start", {}).seq
      log(sessionId, "user/message", { text })
      const context = buildContext(store.events(sessionId))
      const pendingResults = new Map<string, { evidenceId?: string; fullOutputHash?: string }>()
      const compactor = createCompactor({
        provider,
        settings: { ...DEFAULT_COMPACTION, ...deps.compaction },
        events: () => store.events(sessionId),
        log: (type, payload) => void log(sessionId, type, payload),
        putBlob: (text) => store.putBlob(text),
        fixedTokens: Math.ceil((system.length + JSON.stringify(specs).length) / 4),
      })
      let rejections = 0
      let reminders = 0
      let completed: { report: string; validation: Validation; proofFailed: boolean } | undefined

      const logRequest = (http: HttpRequest) => {
        const body = JSON.stringify(http.body)
        log(sessionId, "llm/request", { model: provider.config.model, protocol: provider.config.protocol, url: http.url, bodyHash: store.putBlob(body), bodyBytes: Buffer.byteLength(body) })
      }
      const logResponse = (message: AssistantMessage, meta: { durationMs: number; firstTokenMs?: number }) => {
        log(sessionId, "llm/response", { stopReason: message.stopReason, durationMs: Math.round(meta.durationMs), firstTokenMs: meta.firstTokenMs === undefined ? undefined : Math.round(meta.firstTokenMs), error: message.errorMessage })
        if (message.usage) log(sessionId, "llm/usage", { model: provider.config.model, usage: message.usage, cost: computeCost(message.usage, provider.config.price) })
      }
      // User messages (prompts, steering, reminders) are logged where they are created, so only these two are logged here.
      const logMessage = (message: Message) => {
        if (message.role === "assistant") log(sessionId, "assistant/message", { message })
        else if (message.role === "tool") {
          const meta = pendingResults.get(message.callId) ?? {}
          log(sessionId, "tool/result", { callId: message.callId, name: message.name, content: message.content, isError: message.isError, ...meta })
        }
      }

      /** Run a subagent with its own context; its events are bracketed so they stay out of the parent's context. */
      const runSubagent = async (call: ToolCall, toolSignal?: AbortSignal): Promise<ToolRunResult> => {
        const problems = validate(taskSpec.parameters, call.args)
        if (problems.length > 0) return { content: `Invalid task call: ${problems.join("; ")}`, isError: true }
        const args = call.args as { description: string; prompt: string }
        log(sessionId, "subagent/start", { callId: call.id, description: args.description })
        const evidenceBefore = allEvidence().length
        const childContext: Message[] = [{ role: "user", text: args.prompt }]
        log(sessionId, "user/message", { text: args.prompt })
        const childTool = async (child: ToolCall, childSignal?: AbortSignal) => {
          log(sessionId, "tool/call", { callId: child.id, name: child.name, args: child.args })
          const result = tools.has(child.name) ? await runTool(child, childSignal) : { content: `${child.name} is not available to subagents.`, isError: true }
          return { message: { role: "tool" as const, callId: child.id, name: child.name, content: result.content, isError: result.isError ?? false } }
        }
        const outcome = await runAgent(
          childContext,
          {
            provider,
            system: system + SUBAGENT_NOTE,
            tools: childSpecs,
            maxSteps: SUBAGENT_MAX_STEPS,
            hooks: { onRequest: logRequest, onAssistantMessage: logResponse, onMessageAdded: logMessage, executeTool: childTool },
          },
          toolSignal,
        )
        log(sessionId, "subagent/end", { callId: call.id, reason: outcome.reason })
        const answer = [...childContext].reverse().find((m): m is AssistantMessage => m.role === "assistant" && m.text.trim() !== "")?.text.trim()
        const evidence = allEvidence().slice(evidenceBefore).map((e) => e.id)
        const stopped = outcome.reason === "no_tool_calls" ? "" : `\n[subagent stopped: ${outcome.reason}${outcome.error ? ` (${outcome.error})` : ""}]`
        return {
          content: `${answer ?? "(the subagent gave no answer)"}${stopped}${evidence.length > 0 ? `\n[subagent evidence: ${evidence.join(", ")}]` : ""}`,
          isError: outcome.reason === "error" || outcome.reason === "aborted",
        }
      }

      const executeTool = async (call: ToolCall, toolSignal?: AbortSignal) => {
        log(sessionId, "tool/call", { callId: call.id, name: call.name, args: call.args })
        const result: ToolRunResult & { terminate?: boolean } =
          call.name === COMPLETE_TOOL_NAME ? handleComplete(call) : call.name === TASK_TOOL_NAME ? await runSubagent(call, toolSignal) : await runTool(call, toolSignal)
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
        const target = tool.target?.(args) ?? {}
        const alias = target.workspace ?? (typeof args.workspace === "string" ? args.workspace : row.primary)
        const targetPath = target.path ?? (typeof args.path === "string" ? args.path : undefined)
        const workspace = row.workspaces.find((w) => w.alias === alias)
        const workspaceOps = ops.get(alias)
        if (!workspace || !workspaceOps) {
          return { content: `Unknown workspace "${alias}". Workspaces: ${row.workspaces.map((w) => w.alias).join(", ")}`, isError: true }
        }

        const command = tool.effect === "exec" && typeof args.command === "string" ? args.command : undefined
        const path = targetPath === undefined ? undefined : workspaceOps.resolve(targetPath)
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
            primaryWorkspace: row.primary,
            workspaceOps: (other) => ops.get(other),
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
            onRequest: logRequest,
            onStreamEvent: deps.onStream,
            onAssistantMessage(message, meta) {
              if (message.usage) compactor.noteUsage(message.usage.input + message.usage.cacheRead + message.usage.cacheWrite)
              logResponse(message, meta)
            },
            onMessageAdded: logMessage,
            executeTool,
            prepareContext: (ctx) => compactor.beforeRequest(ctx),
            recoverFromError: (message, ctx) => compactor.recover(message, ctx),
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

function localOperations(workspace: SessionWorkspace): Operations {
  if (workspace.workspace.kind === "local") return createLocalOperations(workspace.workspace.path)
  throw new Error(`Workspace "${workspace.alias}" is remote; the host app must provide SessionDeps.operations`)
}

/** Workspace facts and project instructions; an unreachable machine is described as such instead of failing the session. */
async function systemPrompt(workspaces: SessionWorkspace[], primary: string, ops: Map<string, Operations>): Promise<string> {
  const described = await Promise.all(
    workspaces.map(async (w) => {
      const o = ops.get(w.alias)!
      try {
        const info = await o.info()
        const instruction = await readInstructions(o)
        return { prompt: { alias: w.alias, primary: w.alias === primary, os: info.os, shell: info.shell, root: o.root, permission: w.permission, role: w.role }, instruction }
      } catch (error) {
        const os = `unreachable (${error instanceof Error ? error.message : String(error)})`
        return { prompt: { alias: w.alias, primary: w.alias === primary, os, shell: "unknown", root: o.root, permission: w.permission, role: w.role }, instruction: undefined }
      }
    }),
  )
  const instructions = described.flatMap((d, i) => (d.instruction ? [{ workspace: workspaces[i]!.alias, ...d.instruction }] : []))
  return buildSystemPrompt({ workspaces: described.map((d) => d.prompt), instructions, date: new Date().toLocaleDateString("sv-SE") })
}

async function readInstructions(o: Operations): Promise<{ file: string; content: string } | undefined> {
  for (const file of INSTRUCTION_FILES) {
    const path = o.resolve(file)
    if ((await o.stat(path)).isFile) return { file, content: (await o.readFile(path)).toString("utf8") }
  }
  return undefined
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
