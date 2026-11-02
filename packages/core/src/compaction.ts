// Two-level context slimming: prune old tool outputs (no model call), then summarize older history.
// Both are recorded as compaction events; the context is rebuilt from the log afterwards.

import type { Provider } from "@trail-agent/llm"
import { computeCost } from "@trail-agent/llm"
import type { AssistantMessage, EventPayloads, EventType, Message, TrailEvent } from "@trail-agent/protocol"
import { buildContextWithSeqs, prunedPlaceholder, SUMMARY_OPEN } from "./view.ts"

export interface CompactionSettings {
  /** Share of the usable window at which old tool outputs are pruned. */
  pruneAt: number
  /** Share of the usable window at which older history is summarized. */
  summarizeAt: number
  /** Most recent tool results that are never pruned. */
  keepRecentToolResults: number
  /** Share of the usable window kept verbatim after a summary. */
  keepTail: number
}

export const DEFAULT_COMPACTION: CompactionSettings = { pruneAt: 0.6, summarizeAt: 0.8, keepRecentToolResults: 6, keepTail: 0.3 }

const PRUNE_MIN_CHARS = 400
const SUMMARY_INPUT_TOOL_CHARS = 2000

const SUMMARY_SYSTEM = "You write checkpoint summaries of a coding agent's work so that another agent can continue it without the original conversation."

const SUMMARY_REQUEST = `Summarize the conversation above so the work can continue without it. Use exactly these sections, with terse one-line bullets:

## Goal
## Constraints and decisions
(the user's requirements and choices; keep their exact wording where it matters)
## Workspace state
(per workspace alias: files changed, commits, deploys, restarted services, and what was only inspected)
## Evidence ledger
(evidence ids that matter and what each shows, e.g. "ev_12 staging: npm test exit 0 after the last change")
## Open items and next step

Keep exact paths, commands, error messages and evidence ids. If the conversation starts with an earlier ${SUMMARY_OPEN}, merge it in. Do not call tools; reply with the summary only.`

const OVERFLOW = /context.{0,20}(length|window|limit)|too long|maximum.{0,40}tokens|exceeds?.{0,30}(context|token)|token.{0,20}limit/i

export interface CompactorDeps {
  provider: Provider
  settings: CompactionSettings
  events(): TrailEvent[]
  log<K extends EventType>(type: K, payload: EventPayloads[K]): void
  putBlob(text: string): string
  /** Rough token count of the system prompt and tool definitions, used before any usage is known. */
  fixedTokens: number
}

export interface Compactor {
  /** prepareContext hook: compact when over a threshold, then remember where this request starts. */
  beforeRequest(context: Message[]): Promise<void>
  /** Feed the provider's reported prompt size of the latest response. */
  noteUsage(promptTokens: number): void
  /** recoverFromError hook: summarize after an over-long-context error. */
  recover(message: AssistantMessage, context: Message[]): Promise<boolean>
}

export function estimateTokens(messages: readonly Message[]): number {
  let chars = 0
  for (const m of messages) {
    if (m.role === "user") chars += m.text.length
    else if (m.role === "tool") chars += m.content.length + 20
    else chars += m.text.length + (m.thinking?.length ?? 0) + JSON.stringify(m.toolCalls).length
  }
  return Math.ceil(chars / 4)
}

export function createCompactor(deps: CompactorDeps): Compactor {
  const { provider, settings } = deps
  const budget = Math.max(provider.config.contextWindow - provider.config.maxOutput, provider.config.contextWindow / 2)
  let anchorTokens = 0
  let anchorCount = 0

  const estimate = (context: Message[]) =>
    anchorTokens > 0 ? anchorTokens + estimateTokens(context.slice(anchorCount)) : deps.fixedTokens + estimateTokens(context)

  const rebuild = (context: Message[]) => {
    context.splice(0, context.length, ...buildContextWithSeqs(deps.events()).messages)
    anchorTokens = 0
  }

  const prune = (context: Message[], tokensBefore: number): boolean => {
    const toolResults = context.filter((m): m is Extract<Message, { role: "tool" }> => m.role === "tool")
    const candidates = toolResults
      .slice(0, Math.max(0, toolResults.length - settings.keepRecentToolResults))
      .filter((m) => m.content.length > PRUNE_MIN_CHARS && !m.content.startsWith(`[${m.name} output removed`))
    if (candidates.length === 0) return false
    deps.log("compaction/applied", { kind: "prune", callIds: candidates.map((m) => m.callId), tokensBefore })
    rebuild(context)
    return true
  }

  const summarize = async (context: Message[], trigger: "threshold" | "overflow"): Promise<boolean> => {
    const { messages, seqs } = buildContextWithSeqs(deps.events())
    const cut = chooseCut(messages, settings.keepTail * budget)
    if (cut <= 0) return false
    const prefix = messages.slice(0, cut).map((m) =>
      m.role === "tool" && m.content.length > SUMMARY_INPUT_TOOL_CHARS ? { ...m, content: `${m.content.slice(0, SUMMARY_INPUT_TOOL_CHARS)}\n[…]` } : m,
    )
    const http = provider.prepare({ system: SUMMARY_SYSTEM, messages: [...prefix, { role: "user", text: SUMMARY_REQUEST }], tools: [] })
    const body = JSON.stringify(http.body)
    deps.log("llm/request", { model: provider.config.model, protocol: provider.config.protocol, url: http.url, bodyHash: deps.putBlob(body), bodyBytes: Buffer.byteLength(body), purpose: "compaction" })
    const started = performance.now()
    let reply: AssistantMessage | undefined
    for await (const event of provider.stream(http)) if (event.type === "done") reply = event.message
    if (!reply) return false
    deps.log("llm/response", { stopReason: reply.stopReason, durationMs: Math.round(performance.now() - started), error: reply.errorMessage })
    if (reply.usage) deps.log("llm/usage", { model: provider.config.model, usage: reply.usage, cost: computeCost(reply.usage, provider.config.price) })
    const summary = reply.text.trim()
    if (reply.stopReason === "error" || !summary) return false
    deps.log("compaction/applied", {
      kind: "summary",
      summary,
      throughSeq: Math.max(...seqs.slice(0, cut)),
      tokensBefore: estimate(context),
      trigger,
    })
    rebuild(context)
    return true
  }

  return {
    async beforeRequest(context) {
      let tokens = estimate(context)
      if (tokens >= settings.pruneAt * budget && prune(context, tokens)) tokens = estimate(context)
      if (tokens >= settings.summarizeAt * budget) await summarize(context, "threshold")
      anchorCount = context.length
    },
    noteUsage(promptTokens) {
      anchorTokens = promptTokens
    },
    async recover(message, context) {
      if (!OVERFLOW.test(message.errorMessage ?? "")) return false
      return summarize(context, "overflow")
    },
  }
}

/**
 * Index where the verbatim tail starts: the earliest user or assistant message whose tail fits `keepTokens`.
 * Starting at a user/assistant message never separates a tool result from its call.
 */
export function chooseCut(messages: readonly Message[], keepTokens: number): number {
  let best = -1
  for (let i = messages.length - 1; i > 0; i--) {
    if (messages[i]!.role === "tool") continue
    if (best === -1 || estimateTokens(messages.slice(i)) <= keepTokens) best = i
    else break
  }
  return best
}
