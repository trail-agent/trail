import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, it } from "node:test"

const home = mkdtempSync(join(tmpdir(), "trail-cli-home-"))
process.env.TRAIL_HOME = home

const { saveWorkspaces } = await import("@trail-agent/core")
const { resolveSessionWorkspaces } = await import("../src/workspaces.ts")

before(() => {
  const ssh = { host: "h", port: 22, username: "u", auth: "password" as const, hostKeyFingerprint: "SHA256:x" }
  saveWorkspaces([
    { id: "a", name: "web1", kind: "ssh", path: "/srv/app", description: "staging box", ssh },
    { id: "b", name: "web-prod", kind: "ssh", path: "/srv/app", ssh },
  ])
})

it("attaches saved workspaces with aliases and permission levels", () => {
  const list = resolveSessionWorkspaces(["staging=web1:full", "prod=web-prod"], home, { noLocal: false, localLevel: "ask-write" })
  assert.deepEqual(list.map((w) => `${w.alias}:${w.permission}`), ["local:ask-write", "staging:full", "prod:read-only"])
  assert.equal(list[1]!.role, "staging box")
})

it("rejects unknown workspaces, bad levels and duplicate aliases", () => {
  assert.throws(() => resolveSessionWorkspaces(["x=nope"], home, { noLocal: false, localLevel: "full" }), /No saved workspace "nope"/)
  assert.throws(() => resolveSessionWorkspaces(["web1:root"], home, { noLocal: false, localLevel: "full" }), /Unknown permission "root"/)
  assert.throws(() => resolveSessionWorkspaces(["local=web1"], home, { noLocal: false, localLevel: "full" }), /alias "local" is used twice/)
  assert.throws(() => resolveSessionWorkspaces([], home, { noLocal: true, localLevel: "full" }), /No workspaces/)
})
