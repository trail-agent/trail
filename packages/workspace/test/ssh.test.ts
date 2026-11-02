import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, describe, it } from "node:test"
import { createSshOperations, scanHostKey, type SshOperations } from "../src/index.ts"
import { startTestServer, type TestServer } from "./ssh-server.ts"

let server: TestServer
let nativeRoot: string
let ops: SshOperations
let fingerprint: string

before(async () => {
  server = await startTestServer()
  nativeRoot = mkdtempSync(join(tmpdir(), "trail-ssh-"))
  mkdirSync(join(nativeRoot, "src"))
  mkdirSync(join(nativeRoot, "node_modules"))
  writeFileSync(join(nativeRoot, "src", "app.js"), "const port = 8080\nconsole.log('app')\n")
  writeFileSync(join(nativeRoot, "node_modules", "dep.js"), "const port = 1\n")
  fingerprint = await scanHostKey("127.0.0.1", server.port)
  ops = createSshOperations(
    { host: "127.0.0.1", port: server.port, username: server.user, auth: "password", hostKeyFingerprint: fingerprint },
    server.posixPath(nativeRoot),
    async () => ({ password: server.password }),
  )
})

after(async () => {
  ops.close()
  await server.close()
})

describe("ssh operations", () => {
  it("scans the host key as an OpenSSH fingerprint", () => {
    assert.match(fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/)
  })

  it("runs commands in the remote root with exit codes", async () => {
    const result = await ops.exec("ls src && exit 3")
    assert.equal(result.exitCode, 3)
    assert.match(result.output, /app\.js/)
    const info = await ops.info()
    assert.match(info.os, /via ssh trail@127\.0\.0\.1/)
  })

  it("reads, writes and stats files over SFTP, creating directories", async () => {
    const content = await ops.readFile(ops.resolve("src/app.js"))
    assert.match(content.toString(), /port = 8080/)
    await ops.writeFile(ops.resolve("deploy/config/app.env"), "PORT=9090\n")
    assert.equal(readFileSync(join(nativeRoot, "deploy", "config", "app.env"), "utf8"), "PORT=9090\n")
    const stat = await ops.stat(ops.resolve("deploy/config/app.env"))
    assert.equal(stat.isFile, true)
    assert.equal(stat.size, 10)
    assert.equal((await ops.stat(ops.resolve("missing"))).exists, false)
    const listing = await ops.listDir(ops.root)
    assert.deepEqual(listing.find((e) => e.name === "src"), { name: "src", isDirectory: true })
  })

  it("greps and globs remotely, skipping node_modules", async () => {
    const matches = await ops.grep("port = [0-9]+", { path: ops.root, limit: 20 })
    assert.deepEqual(matches.map((m) => `${m.file}:${m.line}`), ["src/app.js:1"])
    assert.deepEqual(await ops.glob("**/*.js", ops.root, 10), ["src/app.js"])
  })

  it("refuses a server whose host key changed", async () => {
    const wrong = createSshOperations(
      { host: "127.0.0.1", port: server.port, username: server.user, auth: "password", hostKeyFingerprint: "SHA256:AAAA" },
      "/",
      async () => ({ password: server.password }),
    )
    await assert.rejects(wrong.info(), /Host key of 127\.0\.0\.1 changed/)
    wrong.close()
  })

  it("reports a wrong password clearly", async () => {
    const bad = createSshOperations(
      { host: "127.0.0.1", port: server.port, username: server.user, auth: "password", hostKeyFingerprint: fingerprint },
      "/",
      async () => ({ password: "nope" }),
    )
    await assert.rejects(bad.info(), /SSH trail@127\.0\.0\.1:\d+: All configured authentication methods failed/)
    bad.close()
  })
})
