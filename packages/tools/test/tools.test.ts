import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "node:test"
import { createLocalOperations } from "@trail-agent/workspace"
import { bashTool, createFileTracker, editTool, readTool, validate, writeTool, type ToolContext } from "../src/index.ts"

function context(): { ctx: ToolContext; root: string } {
  const root = mkdtempSync(join(tmpdir(), "trail-tools-"))
  const ops = createLocalOperations(root)
  const ctx: ToolContext = { ops, workspace: "local", primaryWorkspace: "local", workspaceOps: () => ops, tracker: createFileTracker(), readOutput: () => undefined }
  return { ctx, root }
}

it("reads with line numbers and records file_read evidence", async () => {
  const { ctx, root } = context()
  writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\n")
  const result = await readTool.execute({ path: "a.txt", offset: 2, limit: 1 }, ctx)
  assert.equal(result.content, "     2\ttwo\n[showing lines 2-2 of 3; use offset to read more]")
  assert.equal(result.evidence?.kind, "file_read")
})

it("refuses to edit unread or changed files", async () => {
  const { ctx, root } = context()
  writeFileSync(join(root, "a.ts"), "const x = 1\n")
  const unread = await editTool.execute({ path: "a.ts", old_string: "1", new_string: "2" }, ctx)
  assert.match(unread.content, /Read a\.ts before/)
  await readTool.execute({ path: "a.ts" }, ctx)
  await new Promise((r) => setTimeout(r, 20))
  writeFileSync(join(root, "a.ts"), "const x = 5\n")
  const changed = await editTool.execute({ path: "a.ts", old_string: "5", new_string: "2" }, ctx)
  assert.match(changed.content, /changed since you read it/)
})

it("edits uniquely, keeps CRLF, and tolerates smart quotes", async () => {
  const { ctx, root } = context()
  writeFileSync(join(root, "a.ts"), "a = 'x'\r\nb = 'x'\r\n")
  await readTool.execute({ path: "a.ts" }, ctx)
  const ambiguous = await editTool.execute({ path: "a.ts", old_string: "'x'", new_string: "'y'" }, ctx)
  assert.match(ambiguous.content, /matches 2 places/)
  const ok = await editTool.execute({ path: "a.ts", old_string: "a = ‘x’\nb", new_string: "a = 'z'\nb" }, ctx)
  assert.equal(ok.isError, undefined)
  assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "a = 'z'\r\nb = 'x'\r\n")
  assert.equal(ok.evidence?.kind, "file_write")
})

it("writes new files, but requires a read before overwriting", async () => {
  const { ctx, root } = context()
  const created = await writeTool.execute({ path: "dir/new.txt", content: "hi" }, ctx)
  assert.match(created.content, /Created dir\/new\.txt/)
  writeFileSync(join(root, "old.txt"), "x")
  const blocked = await writeTool.execute({ path: "old.txt", content: "y" }, ctx)
  assert.equal(blocked.isError, true)
})

it("reports exit codes as exec evidence", async () => {
  const { ctx } = context()
  const result = await bashTool.execute({ command: "echo hi; exit 2" }, ctx)
  assert.equal(result.isError, true)
  assert.match(result.content, /hi\n\[exit code 2\]/)
  assert.equal(result.evidence?.exitCode, 2)
  assert.equal(result.evidence?.command, "echo hi; exit 2")
})

it("validates arguments against the schema", () => {
  assert.deepEqual(validate(readTool.spec.parameters, { path: "a" }), [])
  assert.deepEqual(validate(readTool.spec.parameters, {}), ["arguments.path is required"])
  assert.deepEqual(validate(readTool.spec.parameters, { path: 3 }), ["arguments.path should be string"])
  assert.match(validate(readTool.spec.parameters, { __invalid_json__: "{bad" })[0] ?? "", /not valid JSON/)
})
