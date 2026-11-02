import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, it } from "node:test"
import { scanHostKey } from "@trail-agent/workspace"
import { startTestServer, type TestServer } from "../../workspace/test/ssh-server.ts"
import { defaultPermission, operationsFactory, storeSshSecrets, type SecretStore } from "../src/index.ts"

let server: TestServer
before(async () => {
  server = await startTestServer()
})
after(() => server.close())

function memorySecrets(): SecretStore {
  const values = new Map<string, string>()
  return { get: (k) => values.get(k), set: (k, v) => void values.set(k, v), delete: (k) => void values.delete(k) }
}

it("connects SSH workspaces with the password from the secret store", async () => {
  const secrets = memorySecrets()
  storeSshSecrets(secrets, "w1", { password: server.password })
  const fingerprint = await scanHostKey("127.0.0.1", server.port)
  const root = server.posixPath(mkdtempSync(join(tmpdir(), "trail-ws-")))
  const ssh = { host: "127.0.0.1", port: server.port, username: server.user, auth: "password" as const, hostKeyFingerprint: fingerprint }
  const ops = operationsFactory(secrets)({ alias: "srv", permission: "full", workspace: { id: "w1", name: "srv", kind: "ssh", path: root, ssh } })
  const info = await ops.info()
  assert.match(info.os, /via ssh/)
  ;(ops as { close?(): void }).close?.()

  const missing = operationsFactory(memorySecrets())({ alias: "srv", permission: "full", workspace: { id: "w2", name: "srv2", kind: "ssh", path: root, ssh } })
  await assert.rejects(missing.info(), /No saved password for workspace "srv2"/)
})

it("defaults production-looking workspaces to read-only", () => {
  assert.equal(defaultPermission({ name: "prod" }), "read-only")
  assert.equal(defaultPermission({ name: "web-prod-1" }), "read-only")
  assert.equal(defaultPermission({ name: "db", description: "生产数据库" }), "read-only")
  assert.equal(defaultPermission({ name: "staging", description: "test server" }), "ask-write")
  assert.equal(defaultPermission({ name: "producer" }), "ask-write")
})
