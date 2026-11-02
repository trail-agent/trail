// Anthropic Messages protocol over raw HTTP: prompt caching on the stable prefix and the tail,
// assistant content replayed exactly as received (thinking blocks must not be edited).

import type { AssistantMessage, Message, StopReason, ToolCall } from "@trail-agent/protocol"
import { emptyUsage, errorMessage, postWithRetry, readSse } from "./http.ts"
import type { HttpRequest, LlmEvent, LlmRequest, ModelConfig, Provider } from "./types.ts"

const API_VERSION = "2026-10-21"
const FALLBACK_BETA = "server-side-fallback-2026-07-01"
const CACHE = { type: "ephemeral" } as const
const PROTOCOL = "anthropic"

export function createAnthropicProvider(config: ModelConfig): Provider {
  return {
    config,
    prepare: (request) => prepare(config, request),
    stream: (http, signal) => stream(http, signal),
  }
}

type Block = Record<string, unknown>
interface WireMessage {
  role: "user" | "assistant"
  content: Block[]
}

function prepare(config: ModelConfig, request: LlmRequest): HttpRequest {
  const options = config.anthropic ?? {}
  const messages = toWire(request.messages)
  // Three of the four allowed breakpoints: tools, system, and the conversation tail.
  const lastBlock = messages.at(-1)?.content.at(-1)
  if (lastBlock) lastBlock.cache_control = CACHE
  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: request.maxTokens ?? config.maxOutput,
    system: [{ type: "text", text: request.system, cache_control: CACHE }],
    messages,
    stream: true,
  }
  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool, index) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
      // Large inputs (file contents) stream as generated; arguments are schema-validated before any tool runs.
      eager_input_streaming: true,
      ...(index === request.tools.length - 1 ? { cache_control: CACHE } : {}),
    }))
  }
  if (options.thinkingDisplay) body.thinking = { type: "adaptive", display: options.thinkingDisplay }
  if (options.effort) body.output_config = { effort: options.effort }
  if (options.fallbacks) body.fallbacks = options.fallbacks
  return {
    url: `${config.baseUrl.replace(/\/+$/, "")}/v1/messages`,
    headers: {
      "anthropic-version": options.version ?? API_VERSION,
      ...(options.fallbacks ? { "anthropic-beta": FALLBACK_BETA } : {}),
      ...(config.apiKey ? { "x-api-key": config.apiKey } : {}),
      ...config.headers,
    },
    body,
  }
}

/** Convert to Anthropic's alternating roles; tool results travel inside user messages. */
function toWire(messages: Message[]): WireMessage[] {
  const wire: WireMessage[] = []
  const push = (role: WireMessage["role"], blocks: Block[]) => {
    const last = wire.at(-1)
    if (last && last.role === role) last.content.push(...blocks)
    else wire.push({ role, content: blocks })
  }
  for (const message of messages) {
    if (message.role === "user") push("user", [{ type: "text", text: message.text }])
    else if (message.role === "tool") {
      push("user", [{ type: "tool_result", tool_use_id: message.callId, content: message.content, is_error: message.isError }])
    } else if (message.raw?.protocol === PROTOCOL && message.raw.content.length > 0) {
      // Cloned so the cache breakpoint added in prepare() never leaks into the stored message.
      push("assistant", structuredClone(message.raw.content) as Block[])
    } else {
      const blocks: Block[] = []
      if (message.text) blocks.push({ type: "text", text: message.text })
      for (const call of message.toolCalls) blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.args })
      if (blocks.length === 0) blocks.push({ type: "text", text: "(empty)" })
      push("assistant", blocks)
    }
  }
  return wire
}

interface WireEvent {
  type: string
  index?: number
  message?: { usage?: WireUsage }
  content_block?: Block
  delta?: {
    type?: string
    text?: string
    partial_json?: string
    thinking?: string
    signature?: string
    stop_reason?: string
    stop_details?: { category?: string | null; explanation?: string } | null
  }
  usage?: WireUsage
  error?: { message?: string }
}

interface WireUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

async function* stream(http: HttpRequest, signal?: AbortSignal): AsyncGenerator<LlmEvent> {
  const posted = await postWithRetry(http, signal)
  if (!posted.ok) {
    yield { type: "done", message: errorMessage(posted.error, posted.aborted) }
    return
  }
  const blocks = new Map<number, Block>()
  const partialJson = new Map<number, string>()
  let stopReason: string | undefined
  let refusal = ""
  const usage = emptyUsage()
  try {
    for await (const sse of readSse(posted.response.body!)) {
      const event = JSON.parse(sse.data) as WireEvent
      switch (event.type) {
        case "message_start":
          applyUsage(usage, event.message?.usage)
          break
        case "content_block_start": {
          if (!event.content_block || event.index === undefined) break
          const block = { ...event.content_block }
          blocks.set(event.index, block)
          if (block.type === "tool_use") {
            partialJson.set(event.index, "")
            yield { type: "tool_call_start", id: String(block.id), name: String(block.name) }
          }
          break
        }
        case "content_block_delta": {
          const block = event.index === undefined ? undefined : blocks.get(event.index)
          const delta = event.delta
          if (!block || !delta) break
          if (delta.type === "text_delta" && delta.text) {
            block.text = String(block.text ?? "") + delta.text
            yield { type: "text_delta", text: delta.text }
          } else if (delta.type === "thinking_delta" && delta.thinking) {
            block.thinking = String(block.thinking ?? "") + delta.thinking
            yield { type: "thinking_delta", text: delta.thinking }
          } else if (delta.type === "signature_delta" && delta.signature) {
            block.signature = String(block.signature ?? "") + delta.signature
          } else if (delta.type === "input_json_delta" && delta.partial_json !== undefined) {
            partialJson.set(event.index!, (partialJson.get(event.index!) ?? "") + delta.partial_json)
          }
          break
        }
        case "message_delta":
          if (event.delta?.stop_reason) stopReason = event.delta.stop_reason
          if (event.delta?.stop_details) {
            refusal = [event.delta.stop_details.category, event.delta.stop_details.explanation].filter(Boolean).join(": ")
          }
          applyUsage(usage, event.usage)
          break
        case "error":
          throw new Error(event.error?.message ?? "provider error")
      }
    }
  } catch (error) {
    const aborted = signal?.aborted ?? false
    yield { type: "done", message: { ...errorMessage(aborted ? "aborted" : String(error), aborted), usage } }
    return
  }

  const ordered = [...blocks.entries()].sort(([a], [b]) => a - b)
  const toolCalls: ToolCall[] = []
  for (const [index, block] of ordered) {
    if (block.type !== "tool_use") continue
    const json = partialJson.get(index) ?? ""
    // Eager streaming skips server-side validation, so malformed JSON is passed on for the tool layer to reject.
    let input: unknown = {}
    try {
      input = json.trim() === "" ? {} : JSON.parse(json)
    } catch {
      input = { __invalid_json__: json }
    }
    block.input = input
    toolCalls.push({ id: String(block.id), name: String(block.name), args: input })
  }
  const content = ordered.map(([, block]) => block)
  const text = content.filter((b) => b.type === "text").map((b) => String(b.text)).join("")
  const thinking = content.filter((b) => b.type === "thinking" && b.thinking).map((b) => String(b.thinking)).join("\n")
  const message: AssistantMessage = {
    role: "assistant",
    text,
    toolCalls,
    stopReason: mapStop(stopReason, toolCalls.length > 0),
    usage,
    raw: { protocol: PROTOCOL, content },
  }
  if (thinking) message.thinking = thinking
  if (stopReason === "refusal") message.errorMessage = `model declined the request${refusal ? ` (${refusal})` : ""}`
  yield { type: "done", message }
}

function applyUsage(target: ReturnType<typeof emptyUsage>, usage: WireUsage | undefined): void {
  if (!usage) return
  if (usage.input_tokens !== undefined) target.input = usage.input_tokens
  if (usage.output_tokens !== undefined) target.output = usage.output_tokens
  if (usage.cache_read_input_tokens !== undefined) target.cacheRead = usage.cache_read_input_tokens
  if (usage.cache_creation_input_tokens !== undefined) target.cacheWrite = usage.cache_creation_input_tokens
}

function mapStop(stop: string | undefined, hasToolCalls: boolean): StopReason {
  if (stop === "max_tokens") return "length"
  if (stop === "refusal") return "error"
  if (stop === "tool_use" || hasToolCalls) return "tool_use"
  return "stop"
}
