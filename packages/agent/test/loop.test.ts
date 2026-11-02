import assert from "node:assert/strict"
import { it } from "node:test"
import { createFauxProvider, type FauxScript } from "@trail-agent/llm"
import type { Message } from "@trail-agent/protocol"
import { runAgent, type AgentHooks } from "../src/index.ts"

const echoTool: AgentHooks["executeTool"] = async (call) => ({
  message: { role: "tool", callId: call.id, name: call.name, content: `ran ${JSON.stringify(call.args)}`, isError: false },
  terminate: call.name === "complete",
})

function setup(script: FauxScript, hooks: Partial<AgentHooks> = {}, maxSteps = 10) {
  const context: Message[] = [{ role: "user", text: "task" }]
  const config = { provider: createFauxProvider(script), system: "sys", tools: [], maxSteps, hooks: { executeTool: echoTool, ...hooks } }
  return { context, run: () => runAgent(context, config) }
}

it("runs tools until a terminating tool", async () => {
  const { context, run } = setup((_, i) =>
    i === 0 ? { toolCalls: [{ name: "bash", args: { command: "ls" } }] } : { toolCalls: [{ name: "complete", args: {} }] },
  )
  assert.deepEqual(await run(), { reason: "completed" })
  assert.deepEqual(context.map((m) => m.role), ["user", "assistant", "tool", "assistant", "tool"])
})

it("stops when the model answers without tools", async () => {
  const { run } = setup(() => ({ text: "done" }))
  assert.deepEqual(await run(), { reason: "no_tool_calls" })
})

it("continues with reminders from onNoToolCalls", async () => {
  let reminded = false
  const { context, run } = setup((_, i) => (i === 0 ? { text: "I am done" } : { toolCalls: [{ name: "complete", args: {} }] }), {
    onNoToolCalls: () => {
      if (reminded) return []
      reminded = true
      return [{ role: "user", text: "call complete" }]
    },
  })
  assert.deepEqual(await run(), { reason: "completed" })
  assert.equal(context.filter((m) => m.role === "user").length, 2)
})

it("fails tool calls from a truncated response without executing them", async () => {
  let executed = 0
  const { context, run } = setup(
    (_, i) => (i === 0 ? { toolCalls: [{ name: "write", args: {} }], stopReason: "length" } : { text: "ok" }),
    { executeTool: async (call) => { executed++; return echoTool(call) } },
  )
  await run()
  assert.equal(executed, 0)
  const result = context[2]
  assert.ok(result?.role === "tool" && result.isError)
})

it("enforces max steps", async () => {
  const { run } = setup(() => ({ toolCalls: [{ name: "bash", args: {} }] }), {}, 3)
  assert.deepEqual(await run(), { reason: "max_steps" })
})

it("adds steering messages before the next request", async () => {
  const queue: Message[] = [{ role: "user", text: "also do X" }]
  const seen: number[] = []
  const { run } = setup(
    (request, i) => {
      seen.push(request.messages.filter((m) => m.role === "user").length)
      return i === 0 ? { toolCalls: [{ name: "bash", args: {} }] } : { text: "fine" }
    },
    { takeSteering: () => queue.splice(0) },
  )
  await run()
  assert.deepEqual(seen, [2, 2])
})
