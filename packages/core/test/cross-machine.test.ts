import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, it } from "node:test"
import { createFauxProvider, type LlmRequest } from "@trail-agent/llm"
import { eventsOfType, type SessionWorkspace } from "@trail-agent/protocol"
import { createLocalOperations, createSshOperations, scanHostKey } from "@trail-agent/workspace"
import { startTestServer, type TestServer } from "../../workspace/test/ssh-server.ts"
import { createSession, openStore } from "../src/index.ts"

let server: TestServer
let fingerprint: string
before(async () => {
  server = await startTestServer()
  fingerprint = await scanHostKey("127.0.0.1", server.port)
})
after(() => server.close())

function lastEvidence(request: LlmRequest): string {
  const tool = [...request.messages].reverse().find((m) => m.role === "tool")
  return /\[evidence: (ev_\d+)/.exec(tool?.role === "tool" ? tool.content : "")?.[1] ?? "none"
}

it("works across local, staging and a read-only prod in one session", async () => {
  const base = mkdtempSync(join(tmpdir(), "trail-xm-"))
  const dirs = { local: join(base, "local"), staging: join(base, "staging"), prod: join(base, "prod") }
  for (const d of Object.values(dirs)) mkdirSync(d)
  writeFileSync(join(dirs.local, "app.env"), "PORT=8080\n")
  writeFileSync(join(dirs.prod, "app.env"), "PORT=80\n")
  writeFileSync(join(dirs.staging, "AGENTS.md"), "Staging: check config with `cat app.env`.\n")

  const ssh = (alias: string, dir: string, permission: SessionWorkspace["permission"]): SessionWorkspace => ({
    alias,
    permission,
    workspace: {
      id: alias, name: alias, kind: "ssh", path: server.posixPath(dir),
      ssh: { host: "127.0.0.1", port: server.port, username: server.user, auth: "password", hostKeyFingerprint: fingerprint },
    },
  })
  const workspaces: SessionWorkspace[] = [
    { alias: "local", permission: "full", workspace: { id: "local", name: "local", kind: "local", path: dirs.local } },
    ssh("staging", dirs.staging, "full"),
    ssh("prod", dirs.prod, "read-only"),
  ]

  let editEv = ""
  let checkEv = ""
  let prodEv = ""
  const script = (request: LlmRequest, i: number) => {
    switch (i) {
      case 0: return { toolCalls: [{ name: "read", args: { path: "app.env" } }] }
      case 1: return { toolCalls: [{ name: "edit", args: { path: "app.env", old_string: "8080", new_string: "9090" } }] }
      case 2: editEv = lastEvidence(request); return { toolCalls: [{ name: "transfer", args: { from_path: "app.env", to_workspace: "staging", to_path: "app.env" } }] }
      case 3: return { toolCalls: [{ name: "bash", args: { command: "cat app.env", workspace: "staging" } }] }
      case 4: checkEv = lastEvidence(request); return { toolCalls: [{ name: "write", args: { path: "app.env", content: "PORT=9090\n", workspace: "prod" } }] }
      case 5: return { toolCalls: [{ name: "bash", args: { command: "cat app.env", workspace: "prod" } }] }
      case 6: prodEv = lastEvidence(request); return { toolCalls: [{ name: "complete", args: { summary: "x", claims: [
        { text: "prod runs on 9090", kind: "service_healthy", workspace: "prod", evidence: [checkEv] },
      ] } }] }
      case 7: return { toolCalls: [{ name: "complete", args: { summary: "Port 9090 rolled out to staging; prod untouched", claims: [
        { text: "local config changed", kind: "file_changed", evidence: [editEv] },
        { text: "staging serves the new config", kind: "observed", workspace: "staging", evidence: [checkEv] },
        { text: "prod still on port 80", kind: "observed", workspace: "prod", evidence: [prodEv] },
      ] } }] }
      default: throw new Error(`unexpected request ${i}`)
    }
  }

  const store = openStore(join(base, "trail.db"))
  const deps = {
    store,
    provider: createFauxProvider(script),
    approve: async () => "allow" as const,
    operations: (w: SessionWorkspace) =>
      w.workspace.kind === "local"
        ? createLocalOperations(w.workspace.path)
        : createSshOperations({ ...w.workspace.ssh }, w.workspace.path, async () => ({ password: server.password })),
  }
  const session = await createSession(deps, { title: "roll out port", primary: "local", workspaces })
  const result = await session.send("Change the port to 9090 and roll it out to staging only").finally(() => session.close())

  assert.equal(result.reason, "completed")
  assert.equal(readFileSync(join(dirs.staging, "app.env"), "utf8"), "PORT=9090\n")
  assert.equal(readFileSync(join(dirs.prod, "app.env"), "utf8"), "PORT=80\n")

  const events = session.events()
  const results = eventsOfType(events, "tool/result")
  assert.match(results[4]!.payload.content, /Permission denied in workspace "prod": workspace is read-only/)
  assert.match(eventsOfType(events, "complete/rejected")[0]!.payload.problems.join(), /recorded in workspace "staging", but the claim is about "prod"/)
  const evidence = eventsOfType(events, "evidence/recorded").map((e) => `${e.payload.evidence.id}@${e.payload.evidence.workspace}:${e.payload.evidence.kind}`)
  assert.deepEqual(evidence, ["ev_1@local:file_read", "ev_2@local:file_write", "ev_3@staging:file_write", "ev_4@staging:exec", "ev_5@prod:exec"])

  const body = JSON.parse(store.getBlob(eventsOfType(events, "llm/request")[0]!.payload.bodyHash)!) as LlmRequest
  assert.match(body.system, /- staging: .*via ssh trail@127\.0\.0\.1.*full access/)
  assert.match(body.system, /- prod: .*read-only, writes are refused/)
  assert.match(body.system, /workspace="staging" file="AGENTS\.md"/)
  assert.match(result.report ?? "", /prod · ev_5 `cat app\.env` → exit 0/)
})
