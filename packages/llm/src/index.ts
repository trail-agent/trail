// Model access: pick a provider by protocol, compute cost.

import type { Usage } from "@trail-agent/protocol"
import { createAnthropicProvider } from "./anthropic.ts"
import { createOpenAICompatProvider } from "./openai-compat.ts"
import type { ModelConfig, ModelPrice, Provider } from "./types.ts"

export type { HttpRequest, LlmEvent, LlmRequest, ModelConfig, ModelPrice, Protocol, Provider } from "./types.ts"
export { createAnthropicProvider } from "./anthropic.ts"
export { createOpenAICompatProvider } from "./openai-compat.ts"
export { createFauxProvider, type FauxReply, type FauxScript } from "./faux.ts"
export { readSse } from "./http.ts"

export function createProvider(config: ModelConfig): Provider {
  switch (config.protocol) {
    case "openai-compat":
      return createOpenAICompatProvider(config)
    case "anthropic":
      return createAnthropicProvider(config)
    case "faux":
      throw new Error("faux providers are created in code with createFauxProvider()")
  }
}

/** USD cost of one response; cache reads and writes fall back to the input price when unpriced. */
export function computeCost(usage: Usage, price: ModelPrice | undefined): number {
  if (!price) return 0
  return (
    (usage.input * price.input +
      usage.output * price.output +
      usage.cacheRead * (price.cacheRead ?? price.input) +
      usage.cacheWrite * (price.cacheWrite ?? price.input)) /
    1_000_000
  )
}
