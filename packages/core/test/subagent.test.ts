import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "node:test"
import { createFauxProvider, type LlmRequest } from "@trail-agent/llm"
import { eventsOfType } from "@trail-agent/protocol"
import { buildContext, createSession, openStore } from "../src/index.ts"

it("delegates to a subagent whose evidence the parent can cite", async () => {
  const root = mkdtempSync(join(tmpdir(), "trail-sub-"))
  writeFileSync(join(root, "server.log"), "ok\nok\nERROR disk full at 03:12\nok\n")
  const parentRequests: LlmRequest[] = []
  let childStep = 0
  let parentStep = 0
  const provider = createFauxProvider((request) => {
    if (request.system.includes("<subagent>")) {
      assert.ok(!request.tools.some((t) => t.name === "complete" || t.name === "task"), "subagent has no complete/task")
      if (childStep++ === 0) return { toolCalls: [{ name: "bash", args: { command: "grep -n ERROR server.log" } }] }
      return { text: "Found one error: line 3, 'disk full at 03:12' (ev_1)." }
    }
    parentRequests.push(request)
    if (parentStep++ === 0) return { toolCalls: [{ name: "task", args: { description: "find errors in log", prompt: "Find ERROR lines in server.log and report them." } }] }
    return { toolCalls: [{ name: "complete", args: { summary: "found the disk error", claims: [{ text: "log shows disk full", kind: "observed", evidence: ["ev_1"] }] } }] }
  })
  const store = openStore(join(root, "t.db"))
  const session = await createSession(
    { store, provider, approve: async () => "allow" as const },
    { title: "logs", primary: "local", workspaces: [{ alias: "local", permission: "full", workspace: { id: "l", name: "l", kind: "local", path: root } }] },
  )
  const result = await session.send("Why did the server stop?")
  assert.equal(result.reason, "completed")

  const second = parentRequests[1]!
  assert.deepEqual(second.messages.map((m) => m.role), ["user", "assistant", "tool"])
  const taskResult = second.messages[2]
  assert.ok(taskResult?.role === "tool")
  assert.match(taskResult.content, /disk full at 03:12/)
  assert.match(taskResult.content, /\[subagent evidence: ev_1\]/)

  const events = session.events()
  assert.equal(eventsOfType(events, "subagent/start").length, 1)
  assert.equal(eventsOfType(events, "subagent/end")[0]!.payload.reason, "no_tool_calls")
  assert.equal(eventsOfType(events, "evidence/recorded")[0]!.payload.evidence.command, "grep -n ERROR server.log")
  // Resuming rebuilds the parent context without the subagent's conversation.
  assert.deepEqual(buildContext(events).map((m) => m.role), ["user", "assistant", "tool", "assistant", "tool"])
})
