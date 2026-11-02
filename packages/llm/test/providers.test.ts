import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { after, before, describe, it } from "node:test"
import type { AssistantMessage } from "@trail-agent/protocol"
import { computeCost, createAnthropicProvider, createOpenAICompatProvider, type LlmEvent, type Provider } from "../src/index.ts"

let server: Server
let baseUrl = ""
let nextBody = ""
let nextStatus = 200
let lastRequest: { url: string; headers: Record<string, unknown>; body: unknown } | undefined

before(async () => {
  server = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      lastRequest = { url: req.url ?? "", headers: req.headers, body: JSON.parse(raw) }
      res.writeHead(nextStatus, { "content-type": "text/event-stream" })
      res.end(nextBody)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address && typeof address === "object") baseUrl = `http://127.0.0.1:${address.port}`
})

after(() => server.close())

async function run(provider: Provider, body: string): Promise<{ events: LlmEvent[]; message: AssistantMessage }> {
  nextBody = body
  nextStatus = 200
  const events: LlmEvent[] = []
  const http = provider.prepare({
    system: "sys",
    messages: [{ role: "user", text: "hi" }],
    tools: [{ name: "read", description: "read a file", parameters: { type: "object", properties: {} } }],
  })
  for await (const event of provider.stream(http)) events.push(event)
  const done = events.at(-1)
  assert.equal(done?.type, "done")
  return { events, message: (done as Extract<LlmEvent, { type: "done" }>).message }
}

const sse = (chunks: unknown[]) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n"

describe("openai-compat", () => {
  const provider = () =>
    createOpenAICompatProvider({
      id: "t", protocol: "openai-compat", baseUrl, apiKey: "k", model: "m", contextWindow: 1000, maxOutput: 100,
    })

  it("streams text, reasoning, tool calls and DeepSeek-style cache usage", async () => {
    const { events, message } = await run(provider(), sse([
      { choices: [{ delta: { reasoning_content: "think " } }] },
      { choices: [{ delta: { content: "Hel" } }] },
      { choices: [{ delta: { content: "lo" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: "{\"pa" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "th\":\"a.ts\"}" } }] }, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 60 } },
    ]))
    assert.equal(message.text, "Hello")
    assert.equal(message.thinking, "think ")
    assert.deepEqual(message.toolCalls, [{ id: "c1", name: "read", args: { path: "a.ts" } }])
    assert.equal(message.stopReason, "tool_use")
    assert.deepEqual(message.usage, { input: 40, output: 20, cacheRead: 60, cacheWrite: 0 })
    assert.equal(events.filter((e) => e.type === "text_delta").length, 2)
    assert.equal(lastRequest?.url, "/chat/completions")
    assert.equal(lastRequest?.headers.authorization, "Bearer k")
    const body = lastRequest?.body as { messages: Array<{ role: string }>; tools: unknown[] }
    assert.equal(body.messages[0]?.role, "system")
    assert.equal(body.tools.length, 1)
  })

  it("reports HTTP errors in the done message instead of throwing", async () => {
    nextStatus = 400
    nextBody = "{\"error\":\"bad\"}"
    const p = provider()
    const events: LlmEvent[] = []
    for await (const e of p.stream(p.prepare({ system: "s", messages: [], tools: [] }))) events.push(e)
    const done = events.at(-1) as Extract<LlmEvent, { type: "done" }>
    assert.equal(done.message.stopReason, "error")
    assert.match(done.message.errorMessage ?? "", /HTTP 400/)
  })

  it("serializes assistant tool calls and tool results", () => {
    const http = provider().prepare({
      system: "s",
      tools: [],
      messages: [
        { role: "user", text: "go" },
        { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "bash", args: { command: "ls" } }], stopReason: "tool_use" },
        { role: "tool", callId: "c1", name: "bash", content: "a.ts", isError: false },
      ],
    })
    const body = http.body as { messages: Array<Record<string, unknown>> }
    assert.deepEqual(body.messages[2], {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{\"command\":\"ls\"}" } }],
    })
    assert.deepEqual(body.messages[3], { role: "tool", tool_call_id: "c1", content: "a.ts" })
  })
})

describe("anthropic", () => {
  const provider = () =>
    createAnthropicProvider({ id: "a", protocol: "anthropic", baseUrl, apiKey: "k", model: "m", contextWindow: 1000, maxOutput: 100 })
  const events = (list: Array<Record<string, unknown>>) => list.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("")

  it("streams text and tool_use with cache usage", async () => {
    const { message } = await run(provider(), events([
      { type: "message_start", message: { usage: { input_tokens: 5, cache_read_input_tokens: 90, cache_creation_input_tokens: 10, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "read" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"path\":" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "\"b.ts\"}" } },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 30 } },
      { type: "message_stop" },
    ]))
    assert.equal(message.text, "ok")
    assert.deepEqual(message.toolCalls, [{ id: "t1", name: "read", args: { path: "b.ts" } }])
    assert.deepEqual(message.usage, { input: 5, output: 30, cacheRead: 90, cacheWrite: 10 })
    assert.equal(lastRequest?.url, "/v1/messages")
    assert.equal(lastRequest?.headers["x-api-key"], "k")
  })

  it("merges tool results into one user turn and marks cache breakpoints", () => {
    const http = provider().prepare({
      system: "s",
      tools: [{ name: "a", description: "", parameters: {} }, { name: "b", description: "", parameters: {} }],
      messages: [
        { role: "user", text: "go" },
        { role: "assistant", text: "", toolCalls: [{ id: "1", name: "a", args: {} }, { id: "2", name: "b", args: {} }], stopReason: "tool_use" },
        { role: "tool", callId: "1", name: "a", content: "x", isError: false },
        { role: "tool", callId: "2", name: "b", content: "y", isError: true },
      ],
    })
    const body = http.body as { messages: Array<{ role: string; content: Array<Record<string, unknown>> }>; tools: Array<Record<string, unknown>> }
    assert.equal(body.messages.length, 3)
    assert.equal(body.messages[2]?.content.length, 2)
    assert.deepEqual(body.messages[2]?.content[1]?.cache_control, { type: "ephemeral" })
    assert.equal(body.tools[0]?.cache_control, undefined)
    assert.deepEqual(body.tools[1]?.cache_control, { type: "ephemeral" })
    assert.equal(body.tools[0]?.eager_input_streaming, true)
    assert.equal(http.headers["anthropic-version"], "2026-10-21")
  })

  it("keeps every block, including empty-text thinking, and replays them unchanged", async () => {
    const { message } = await run(provider(), events([
      { type: "message_start", message: { usage: { input_tokens: 5 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig1" } },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "read" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"path\":\"a\"}" } },
      { type: "content_block_start", index: 2, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 2, delta: { type: "thinking_delta", thinking: "next" } },
      { type: "content_block_delta", index: 2, delta: { type: "signature_delta", signature: "sig2" } },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
    ]))
    assert.deepEqual(message.raw?.content, [
      { type: "thinking", thinking: "", signature: "sig1" },
      { type: "tool_use", id: "t1", name: "read", input: { path: "a" } },
      { type: "thinking", thinking: "next", signature: "sig2" },
    ])
    const replay = provider().prepare({
      system: "s",
      tools: [],
      messages: [{ role: "user", text: "go" }, message, { role: "tool", callId: "t1", name: "read", content: "x", isError: false }],
    })
    const body = replay.body as { messages: Array<{ content: unknown[] }> }
    assert.deepEqual(body.messages[1]?.content, message.raw?.content)
    assert.equal((message.raw?.content[2] as Record<string, unknown>).cache_control, undefined)
  })

  it("reports refusals as errors and sends fallbacks when configured", async () => {
    const p = createAnthropicProvider({
      id: "a", protocol: "anthropic", baseUrl, model: "m", contextWindow: 1000, maxOutput: 100,
      anthropic: { fallbacks: "default", effort: "high", thinkingDisplay: "summarized" },
    })
    const { message } = await run(p, events([
      { type: "message_delta", delta: { stop_reason: "refusal", stop_details: { category: "cyber", explanation: "no" } } },
    ]))
    assert.equal(message.stopReason, "error")
    assert.match(message.errorMessage ?? "", /declined.*cyber/)
    assert.equal(lastRequest?.headers["anthropic-beta"], "server-side-fallback-2026-07-01")
    const body = lastRequest?.body as Record<string, unknown>
    assert.equal(body.fallbacks, "default")
    assert.deepEqual(body.output_config, { effort: "high" })
    assert.deepEqual(body.thinking, { type: "adaptive", display: "summarized" })
  })
})

it("computes cost with cache prices", () => {
  const cost = computeCost({ input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 }, { input: 1, output: 2, cacheRead: 0.1 })
  assert.equal(cost, 3.1)
})
