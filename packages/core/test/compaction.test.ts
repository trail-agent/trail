import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "node:test"
import { createFauxProvider, type FauxReply, type LlmRequest } from "@trail-agent/llm"
import { eventsOfType, type Message } from "@trail-agent/protocol"
import { chooseCut, createSession, openStore } from "../src/index.ts"

const isSummaryRequest = (r: LlmRequest) => r.system.startsWith("You write checkpoint summaries")

function setup(script: (request: LlmRequest, step: number) => FauxReply, contextWindow: number) {
  const root = mkdtempSync(join(tmpdir(), "trail-compact-"))
  writeFileSync(join(root, "a.txt"), "x\n")
  const summaries: LlmRequest[] = []
  let step = 0
  const provider = createFauxProvider(
    (request) => {
      if (isSummaryRequest(request)) {
        summaries.push(request)
        return { text: "## Goal\n- count numbers\n## Evidence ledger\n- ev_1 local: first count" }
      }
      return script(request, step++)
    },
    { contextWindow, maxOutput: 500 },
  )
  const store = openStore(join(root, "trail.db"))
  return { store, summaries, provider, root }
}

/** Run `steps` commands of `lines` lines each, then complete citing ev_1, whose output gets compacted away. */
async function countingSession(contextWindow: number, steps: number, lines: number) {
  const requests: LlmRequest[] = []
  const { store, summaries, provider, root } = setup((request, step) => {
    requests.push(request)
    if (step < steps) return { toolCalls: [{ name: "bash", args: { command: `seq ${step * 1000} ${step * 1000 + lines}` } }] }
    return { toolCalls: [{ name: "complete", args: { summary: "counted", claims: [{ text: "first count ran", kind: "command_succeeded", evidence: ["ev_1"] }] } }] }
  }, contextWindow)
  const session = await createSession(
    { store, provider, approve: async () => "allow" as const },
    { title: "count", primary: "local", workspaces: [{ alias: "local", permission: "full", workspace: { id: "l", name: "l", kind: "local", path: root } }] },
  )
  const result = await session.send("count a lot")
  const compactions = eventsOfType(session.events(), "compaction/applied").map((e) => e.payload)
  return { result, requests, summaries, compactions, session }
}

it("prunes old outputs without a model call, and pruned evidence stays citable", async () => {
  const { result, requests, summaries, compactions } = await countingSession(9000, 14, 250)
  assert.equal(result.reason, "completed")
  assert.ok(compactions.some((c) => c.kind === "prune"), "expected a prune")
  assert.equal(summaries.length, 0)
  const last = requests.at(-1)!
  assert.ok(last.messages.some((m) => m.role === "tool" && m.content === '[bash output removed to save context; read_output("ev_1") shows it again]'))
  const toolResults = last.messages.filter((m) => m.role === "tool")
  assert.ok(toolResults.slice(-6).every((m) => !m.content.includes("removed to save context")), "recent outputs are kept")
})

it("summarizes older history when pruning is not enough", async () => {
  const { result, requests, summaries, compactions, session } = await countingSession(6000, 10, 600)
  assert.equal(result.reason, "completed")
  assert.ok(compactions.some((c) => c.kind === "summary" && c.trigger === "threshold"), "expected a summary")
  assert.equal(eventsOfType(session.events(), "llm/request").filter((e) => e.payload.purpose === "compaction").length, summaries.length)
  const first = requests.at(-1)!.messages[0]
  assert.ok(first?.role === "user" && first.text.startsWith("<conversation-summary>"), "context starts with the summary")
  assert.ok(!requests.at(-1)!.messages.some((m) => m.role === "tool" && m.content.startsWith("0\n1\n2")), "summarized history is gone")
  // A later summary request includes the earlier summary so nothing is lost between compactions.
  if (summaries.length > 1) assert.match(JSON.stringify(summaries[1]!.messages[0]), /conversation-summary/)
  for (const r of requests) assert.notEqual(r.messages[0]?.role, "tool")
})

it("recovers from a context-overflow error by summarizing and retrying once", async () => {
  let failed = false
  const { store, provider, root } = setup((_, step) => {
    if (step < 3) return { toolCalls: [{ name: "bash", args: { command: "echo step" } }] }
    if (!failed) {
      failed = true
      return { stopReason: "error", text: "" }
    }
    return { text: "done" }
  }, 200_000)
  // The faux provider has no error text; wrap it to report an overflow message.
  const overflowing = {
    ...provider,
    async *stream(http: Parameters<typeof provider.stream>[0]) {
      for await (const event of provider.stream(http)) {
        if (event.type === "done" && event.message.stopReason === "error") yield { ...event, message: { ...event.message, errorMessage: "prompt is too long: 210000 tokens > 200000 maximum" } }
        else yield event
      }
    },
  }
  const session = await createSession(
    { store, provider: overflowing, approve: async () => "allow" as const },
    { title: "x", primary: "local", workspaces: [{ alias: "local", permission: "full", workspace: { id: "l", name: "l", kind: "local", path: root } }] },
  )
  const result = await session.send("go")
  assert.equal(result.reason, "no_tool_calls")
  const summary = eventsOfType(session.events(), "compaction/applied").find((e) => e.payload.kind === "summary")
  assert.equal(summary?.payload.kind === "summary" && summary.payload.trigger, "overflow")
  assert.equal(eventsOfType(session.events(), "assistant/message").filter((e) => e.payload.message.stopReason === "error").length, 0)
})

it("chooses a cut that keeps tool results with their calls", () => {
  const big = "y".repeat(4000)
  const messages: Message[] = [
    { role: "user", text: "start" },
    { role: "assistant", text: "", toolCalls: [{ id: "1", name: "bash", args: {} }], stopReason: "tool_use" },
    { role: "tool", callId: "1", name: "bash", content: big, isError: false },
    { role: "assistant", text: "", toolCalls: [{ id: "2", name: "bash", args: {} }], stopReason: "tool_use" },
    { role: "tool", callId: "2", name: "bash", content: "small", isError: false },
    { role: "user", text: "next" },
  ]
  assert.equal(chooseCut(messages, 50), 3)
  assert.equal(chooseCut(messages, 1), 5)
  assert.equal(chooseCut([{ role: "user", text: "only" }], 100), -1)
})

