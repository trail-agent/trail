// Scripted provider for tests: replies come from a function instead of a network call.

import type { AssistantMessage } from "@trail-agent/protocol"
import type { HttpRequest, LlmEvent, LlmRequest, ModelConfig, Provider } from "./types.ts"

export interface FauxReply {
  text?: string
  toolCalls?: Array<{ name: string; args: unknown }>
  stopReason?: AssistantMessage["stopReason"]
}

/** Called once per model request with the request and its zero-based index. */
export type FauxScript = (request: LlmRequest, index: number) => FauxReply

export function createFauxProvider(script: FauxScript, config?: Partial<ModelConfig>): Provider {
  let index = 0
  const fullConfig: ModelConfig = {
    id: "faux",
    protocol: "faux",
    baseUrl: "faux://",
    model: "faux-1",
    contextWindow: 128_000,
    maxOutput: 8_000,
    ...config,
  }
  return {
    config: fullConfig,
    // Snapshot like a real provider serializing its body, so later context changes do not leak in.
    prepare: (request): HttpRequest => ({ url: "faux://complete", headers: {}, body: structuredClone(request) }),
    async *stream(http): AsyncGenerator<LlmEvent> {
      const request = http.body as LlmRequest
      const reply = script(request, index)
      const toolCalls = (reply.toolCalls ?? []).map((call, i) => ({ id: `faux_${index}_${i}`, name: call.name, args: call.args }))
      index++
      if (reply.text) yield { type: "text_delta", text: reply.text }
      const promptChars = request.system.length + JSON.stringify(request.messages).length
      yield {
        type: "done",
        message: {
          role: "assistant",
          text: reply.text ?? "",
          toolCalls,
          stopReason: reply.stopReason ?? (toolCalls.length > 0 ? "tool_use" : "stop"),
          usage: { input: Math.ceil(promptChars / 4), output: Math.ceil((reply.text ?? "").length / 4) + 10, cacheRead: 0, cacheWrite: 0 },
        },
      }
    },
  }
}
