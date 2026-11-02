// Stateless agent loop: request the model, run its tool calls, repeat. Storage, evidence and UI attach through hooks.

import type { LlmEvent, Provider } from "@trail-agent/llm"
import type { AssistantMessage, HttpRequestLike, Message, ToolCall, ToolResultMessage, ToolSpec, TurnEndReason } from "./types.ts"

export type { HttpRequestLike } from "./types.ts"

export interface ToolOutcome {
  message: ToolResultMessage
  /** Ends the run after this batch, e.g. an accepted `complete`. */
  terminate?: boolean
}

export interface ResponseMeta {
  durationMs: number
  firstTokenMs?: number
}

export interface AgentHooks {
  /** Called with the exact request before it is sent. */
  onRequest?(http: HttpRequestLike): void
  /** Streaming deltas for live display. */
  onStreamEvent?(event: LlmEvent): void
  onAssistantMessage?(message: AssistantMessage, meta: ResponseMeta): void
  executeTool(call: ToolCall, signal?: AbortSignal): Promise<ToolOutcome>
  /** Called when the model stops without tool calls; returned messages are added and the loop continues. */
  onNoToolCalls?(message: AssistantMessage): Promise<Message[]> | Message[]
  /** Messages the user sent while the agent was working; added before the next request. */
  takeSteering?(): Message[]
  /** Called for every message the loop adds to the context. */
  onMessageAdded?(message: Message): void
  /** Called before every request; may rewrite `context` in place, e.g. to compact it. */
  prepareContext?(context: Message[]): Promise<void>
  /** Called when a request fails; returning true retries the step (e.g. after compacting an over-long context). */
  recoverFromError?(message: AssistantMessage, context: Message[]): Promise<boolean>
}

export interface AgentConfig {
  provider: Provider
  system: string
  tools: ToolSpec[]
  maxSteps: number
  maxTokens?: number
  hooks: AgentHooks
}

export interface AgentResult {
  reason: TurnEndReason
  error?: string
}

const TRUNCATED_CALL =
  "Not executed: your response hit the output token limit, so these arguments may be incomplete. Retry with a smaller step, for example write a large file in parts."

/** Run until the model stops, a tool terminates the run, or a limit is hit. Mutates `context`. */
export async function runAgent(context: Message[], config: AgentConfig, signal?: AbortSignal): Promise<AgentResult> {
  const { hooks } = config
  const add = (message: Message) => {
    context.push(message)
    hooks.onMessageAdded?.(message)
  }
  let recovered = false
  for (let step = 0; ; step++) {
    for (const message of hooks.takeSteering?.() ?? []) add(message)
    if (signal?.aborted) return { reason: "aborted" }
    if (step >= config.maxSteps) return { reason: "max_steps" }
    await hooks.prepareContext?.(context)

    const http = config.provider.prepare({ system: config.system, messages: context, tools: config.tools, maxTokens: config.maxTokens })
    hooks.onRequest?.(http)
    const started = performance.now()
    let firstTokenMs: number | undefined
    let message: AssistantMessage | undefined
    for await (const event of config.provider.stream(http, signal)) {
      if (firstTokenMs === undefined && event.type !== "done") firstTokenMs = performance.now() - started
      if (event.type === "done") message = event.message
      else hooks.onStreamEvent?.(event)
    }
    if (!message) return { reason: "error", error: "provider ended without a final message" }
    hooks.onAssistantMessage?.(message, { durationMs: performance.now() - started, firstTokenMs })
    // One recovery per run: a failed request that the host can fix (over-long context) is retried, not recorded.
    if (message.stopReason === "error" && !recovered && hooks.recoverFromError && (await hooks.recoverFromError(message, context))) {
      recovered = true
      continue
    }
    add(message)

    if (message.stopReason === "aborted") return { reason: "aborted" }
    if (message.stopReason === "error") return { reason: "error", error: message.errorMessage }

    if (message.toolCalls.length === 0) {
      const injected = await hooks.onNoToolCalls?.(message) ?? []
      if (injected.length === 0) return { reason: "no_tool_calls" }
      for (const m of injected) add(m)
      continue
    }

    let terminate = false
    for (const call of message.toolCalls) {
      if (message.stopReason === "length") {
        add({ role: "tool", callId: call.id, name: call.name, content: TRUNCATED_CALL, isError: true })
        continue
      }
      if (signal?.aborted) {
        add({ role: "tool", callId: call.id, name: call.name, content: "Not executed: run aborted.", isError: true })
        continue
      }
      const outcome = await hooks.executeTool(call, signal)
      add(outcome.message)
      terminate ||= outcome.terminate === true
    }
    if (terminate) return { reason: "completed" }
  }
}
