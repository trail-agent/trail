// User configuration: ~/.trail/config.json plus presets derived from environment variables.

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ModelConfig } from "@trail-agent/llm"

export interface TrailConfig {
  defaultModel?: string
  maxSteps?: number
  models: ModelConfig[]
}

export function trailHome(): string {
  return process.env.TRAIL_HOME ?? join(homedir(), ".trail")
}

export const configPath = () => join(trailHome(), "config.json")
export const databasePath = () => join(trailHome(), "trail.db")

/** Values written as "env:NAME" are read from the environment, so keys stay out of the file. */
function resolveSecret(value: string | undefined): string | undefined {
  if (value?.startsWith("env:")) return process.env[value.slice(4)]
  return value
}

export function loadConfig(): TrailConfig {
  const path = configPath()
  const fromFile: TrailConfig = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as TrailConfig) : { models: [] }
  const models: ModelConfig[] = (fromFile.models ?? []).map((m) => ({ ...m, apiKey: resolveSecret(m.apiKey) }))
  for (const preset of envPresets()) {
    if (!models.some((m) => m.id === preset.id)) models.push(preset)
  }
  return { ...fromFile, models }
}

function envPresets(): ModelConfig[] {
  const presets: ModelConfig[] = []
  if (process.env.ANTHROPIC_API_KEY) {
    presets.push({
      id: "claude",
      protocol: "anthropic",
      baseUrl: process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: "claude-opus-5-5",
      contextWindow: 1_000_000,
      maxOutput: 64_000,
      price: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
      anthropic: { effort: "high", thinkingDisplay: "summarized", fallbacks: "default" },
    })
  }
  // Any OpenAI-compatible endpoint (DeepSeek, Qwen, Kimi, GLM, Ollama, OpenRouter...) without a config file.
  if (process.env.TRAIL_BASE_URL && process.env.TRAIL_MODEL) {
    presets.push({
      id: "env",
      protocol: "openai-compat",
      baseUrl: process.env.TRAIL_BASE_URL,
      apiKey: process.env.TRAIL_API_KEY,
      model: process.env.TRAIL_MODEL,
      contextWindow: Number(process.env.TRAIL_CONTEXT_WINDOW ?? 128_000),
      maxOutput: Number(process.env.TRAIL_MAX_OUTPUT ?? 8_192),
    })
  }
  return presets
}

export function pickModel(config: TrailConfig, id?: string): ModelConfig {
  const wanted = id ?? config.defaultModel
  const model = wanted ? config.models.find((m) => m.id === wanted) : config.models[0]
  if (model) return model
  const known = config.models.map((m) => m.id).join(", ") || "none"
  throw new Error(
    wanted
      ? `Unknown model "${wanted}". Configured: ${known}.`
      : `No model configured. Set ANTHROPIC_API_KEY, or TRAIL_BASE_URL + TRAIL_MODEL (+ TRAIL_API_KEY), or create ${configPath()}.`,
  )
}
