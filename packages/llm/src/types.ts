// Provider-neutral model configuration, requests and stream events.

import type { AssistantMessage, Message, ToolSpec } from "@trail-agent/protocol"

export type Protocol = "openai-compat" | "anthropic" | "faux"

/** Prices in USD per million tokens. */
export interface ModelPrice {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

export interface ModelConfig {
  /** Name users pick the model by, e.g. "deepseek". */
  id: string
  protocol: Protocol
  baseUrl: string
  apiKey?: string
  /** Model id sent to the API. */
  model: string
  contextWindow: number
  maxOutput: number
  price?: ModelPrice
  headers?: Record<string, string>
  compat?: {
    /** Send `reasoning_content` back on assistant messages (DeepSeek thinking mode). */
    sendReasoningContent?: boolean
    maxTokensField?: "max_tokens" | "max_completion_tokens"
  }
  anthropic?: {
    /** `anthropic-version` header; defaults to the current API version. */
    version?: string
    /** output_config.effort: low | medium | high | xhigh | max. */
    effort?: string
    /** Thinking visibility; "summarized" returns readable reasoning. Omitted means the model default. */
    thinkingDisplay?: "summarized" | "omitted"
    /** Re-run refused requests on Anthropic's recommended fallback model (Claude API only). */
    fallbacks?: "default"
  }
}

export interface LlmRequest {
  system: string
  messages: Message[]
  tools: ToolSpec[]
  maxTokens?: number
}

/** The exact HTTP request a provider will send; `headers` carry secrets and are never logged. */
export interface HttpRequest {
  url: string
  headers: Record<string, string>
  body: unknown
}

export type LlmEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call_start"; id: string; name: string }
  /** Always the last event; errors are reported here instead of being thrown. */
  | { type: "done"; message: AssistantMessage }

export interface Provider {
  readonly config: ModelConfig
  prepare(request: LlmRequest): HttpRequest
  stream(http: HttpRequest, signal?: AbortSignal): AsyncIterable<LlmEvent>
}
