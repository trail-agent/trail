import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "node:test"
import { createLocalOperations, globToRegExp } from "../src/index.ts"

function tempWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "trail-ws-"))
  mkdirSync(join(root, "src"))
  mkdirSync(join(root, "node_modules", "x"), { recursive: true })
  writeFileSync(join(root, "src", "a.ts"), "export const answer = 42\nconst other = 1\n")
  writeFileSync(join(root, "src", "b.md"), "Answer here\n")
  writeFileSync(join(root, "node_modules", "x", "c.ts"), "answer\n")
  return createLocalOperations(root)
}

it("runs commands in the workspace root with exit codes", async () => {
  const ops = tempWorkspace()
  const ok = await ops.exec("echo hello && ls src")
  assert.equal(ok.exitCode, 0)
  assert.match(ok.output, /hello/)
  assert.match(ok.output, /a\.ts/)
  const fail = await ops.exec("exit 3")
  assert.equal(fail.exitCode, 3)
})

it("times out long commands", async () => {
  const ops = tempWorkspace()
  const result = await ops.exec("sleep 5", { timeoutMs: 300 })
  assert.equal(result.timedOut, true)
  assert.ok(result.durationMs < 4000)
})

it("keeps UTF-8 output intact", async () => {
  const ops = tempWorkspace()
  const result = await ops.exec("echo 中文输出")
  assert.match(result.output, /中文输出/)
})

it("greps and globs while skipping node_modules", async () => {
  const ops = tempWorkspace()
  const matches = await ops.grep("answer", { path: ops.root, ignoreCase: true, limit: 50 })
  assert.deepEqual(matches.map((m) => m.file).sort(), ["src/a.ts", "src/b.md"])
  const tsOnly = await ops.grep("answer", { path: ops.root, glob: "*.ts", limit: 50 })
  assert.deepEqual(tsOnly.map((m) => `${m.file}:${m.line}`), ["src/a.ts:1"])
  assert.deepEqual(await ops.glob("**/*.ts", ops.root, 10), ["src/a.ts"])
})

it("resolves and displays paths relative to the root", () => {
  const ops = tempWorkspace()
  const abs = ops.resolve("src/a.ts")
  assert.equal(ops.display(abs), "src/a.ts")
  assert.equal(ops.isInside(abs), true)
  assert.equal(ops.isInside(ops.resolve("../elsewhere")), false)
})

it("converts globs", () => {
  assert.ok(globToRegExp("*.ts").test("src/deep/a.ts"))
  assert.ok(globToRegExp("src/**/*.{ts,tsx}").test("src/x/y.tsx"))
  assert.ok(!globToRegExp("src/*.ts").test("src/x/y.ts"))
})
