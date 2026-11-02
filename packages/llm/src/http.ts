// HTTP plumbing shared by providers: retrying POST and a server-sent-events reader.

import type { AssistantMessage, Usage } from "@trail-agent/protocol"
import type { HttpRequest } from "./types.ts"

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529])
const MAX_ATTEMPTS = 3

export type PostResult = { ok: true; response: Response } | { ok: false; error: string; aborted: boolean }

/** POST with retries on network errors and retryable statuses; never throws. */
export async function postWithRetry(http: HttpRequest, signal?: AbortSignal): Promise<PostResult> {
  let lastError = ""
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) return { ok: false, error: "aborted", aborted: true }
    try {
      const response = await fetch(http.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...http.headers },
        body: JSON.stringify(http.body),
        signal,
      })
      if (response.ok && response.body) return { ok: true, response }
      const text = await response.text().catch(() => "")
      lastError = `HTTP ${response.status}: ${text.slice(0, 2000)}`
      if (!RETRYABLE_STATUS.has(response.status)) break
      await sleep(retryDelay(attempt, response.headers.get("retry-after")), signal)
    } catch (error) {
      if (signal?.aborted) return { ok: false, error: "aborted", aborted: true }
      lastError = `network error: ${error instanceof Error ? error.message : String(error)}`
      await sleep(retryDelay(attempt, null), signal)
    }
  }
  return { ok: false, error: lastError, aborted: false }
}

function retryDelay(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter ? Number(retryAfter) : Number.NaN
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 30_000)
  return 1000 * 2 ** (attempt - 1)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

export interface SseMessage {
  event?: string
  data: string
}

/** Parse a server-sent-events body into messages. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const decoder = new TextDecoder()
  let buffer = ""
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n")
    let boundary: number
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const message = parseSseBlock(buffer.slice(0, boundary))
      buffer = buffer.slice(boundary + 2)
      if (message) yield message
    }
  }
  const tail = parseSseBlock(buffer + decoder.decode())
  if (tail) yield tail
}

function parseSseBlock(block: string): SseMessage | undefined {
  let event: string | undefined
  const data: string[] = []
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim()
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""))
  }
  return data.length > 0 ? { event, data: data.join("\n") } : undefined
}

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

export function errorMessage(error: string, aborted: boolean): AssistantMessage {
  return {
    role: "assistant",
    text: "",
    toolCalls: [],
    stopReason: aborted ? "aborted" : "error",
    errorMessage: error,
  }
}

/** Parse tool-call argument JSON; malformed input is kept so validation can report it to the model. */
export function parseToolArgs(raw: string): unknown {
  if (raw.trim() === "") return {}
  try {
    return JSON.parse(raw)
  } catch {
    return { __invalid_json__: raw }
  }
}
