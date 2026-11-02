// OpenAI Chat Completions protocol, shared by OpenAI, DeepSeek, Qwen, Kimi, GLM, Ollama, vLLM, OpenRouter.

import type { AssistantMessage, Message, StopReason, ToolCall } from "@trail-agent/protocol"
import { emptyUsage, errorMessage, parseToolArgs, postWithRetry, readSse } from "./http.ts"
import type { HttpRequest, LlmEvent, LlmRequest, ModelConfig, Provider } from "./types.ts"

export function createOpenAICompatProvider(config: ModelConfig): Provider {
  return {
    config,
    prepare: (request) => prepare(config, request),
    stream: (http, signal) => stream(http, signal),
  }
}

function prepare(config: ModelConfig, request: LlmRequest): HttpRequest {
  const body: Record<string, unknown> = {
    model: config.model,
    messages: [{ role: "system", content: request.system }, ...request.messages.map((m) => toWire(m, config))],
    stream: true,
    stream_options: { include_usage: true },
    [config.compat?.maxTokensField ?? "max_tokens"]: request.maxTokens ?? config.maxOutput,
  }
  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }))
  }
  return {
    url: `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`,
    headers: { ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}), ...config.headers },
    body,
  }
}

function toWire(message: Message, config: ModelConfig): Record<string, unknown> {
  switch (message.role) {
    case "user":
      return { role: "user", content: message.text }
    case "tool":
      return { role: "tool", tool_call_id: message.callId, content: message.content }
    case "assistant": {
      const wire: Record<string, unknown> = { role: "assistant", content: message.text || null }
      if (message.toolCalls.length > 0) {
        wire.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        }))
      }
      if (config.compat?.sendReasoningContent && message.thinking) wire.reasoning_content = message.thinking
      return wire
    }
  }
}

interface WireChunk {
  choices?: Array<{
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      reasoning?: string | null
      tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
    prompt_cache_hit_tokens?: number
  }
  error?: { message?: string }
}

async function* stream(http: HttpRequest, signal?: AbortSignal): AsyncGenerator<LlmEvent> {
  const posted = await postWithRetry(http, signal)
  if (!posted.ok) {
    yield { type: "done", message: errorMessage(posted.error, posted.aborted) }
    return
  }
  let text = ""
  let thinking = ""
  let finish: string | undefined
  const usage = emptyUsage()
  const calls = new Map<number, { id: string; name: string; args: string }>()
  try {
    for await (const sse of readSse(posted.response.body!)) {
      if (sse.data === "[DONE]") break
      const chunk = JSON.parse(sse.data) as WireChunk
      if (chunk.error) throw new Error(chunk.error.message ?? "provider error")
      if (chunk.usage) {
        const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? chunk.usage.prompt_cache_hit_tokens ?? 0
        usage.cacheRead = cached
        usage.input = (chunk.usage.prompt_tokens ?? 0) - cached
        usage.output = chunk.usage.completion_tokens ?? 0
      }
      const choice = chunk.choices?.[0]
      if (!choice) continue
      const delta = choice.delta ?? {}
      const reasoning = delta.reasoning_content ?? delta.reasoning
      if (reasoning) {
        thinking += reasoning
        yield { type: "thinking_delta", text: reasoning }
      }
      if (delta.content) {
        text += delta.content
        yield { type: "text_delta", text: delta.content }
      }
      for (const part of delta.tool_calls ?? []) {
        let call = calls.get(part.index)
        if (!call) {
          call = { id: part.id ?? `call_${part.index}`, name: "", args: "" }
          calls.set(part.index, call)
        }
        if (part.function?.name) {
          call.name += part.function.name
          yield { type: "tool_call_start", id: call.id, name: call.name }
        }
        if (part.function?.arguments) call.args += part.function.arguments
      }
      if (choice.finish_reason) finish = choice.finish_reason
    }
  } catch (error) {
    const aborted = signal?.aborted ?? false
    yield { type: "done", message: { ...errorMessage(aborted ? "aborted" : String(error), aborted), text, usage } }
    return
  }
  const toolCalls: ToolCall[] = [...calls.values()].map((c) => ({ id: c.id, name: c.name, args: parseToolArgs(c.args) }))
  const message: AssistantMessage = {
    role: "assistant",
    text,
    toolCalls,
    stopReason: mapFinish(finish, toolCalls.length > 0),
    usage,
  }
  if (thinking) message.thinking = thinking
  yield { type: "done", message }
}

function mapFinish(finish: string | undefined, hasToolCalls: boolean): StopReason {
  if (finish === "length") return "length"
  if (hasToolCalls) return "tool_use"
  if (finish === "content_filter") return "error"
  return "stop"
}
