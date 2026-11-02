import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { Claim, Evidence } from "@trail-agent/protocol"
import { renderReport, validateClaims } from "../src/index.ts"

const ev = (id: string, seq: number, kind: Evidence["kind"], extra: Partial<Evidence> = {}): Evidence => ({ id, seq, kind, workspace: "local", ...extra })

const testsBeforeEdit = ev("ev_1", 1, "exec", { command: "npm test", exitCode: 0 })
const edit = ev("ev_2", 2, "file_write", { path: "src/a.ts" })
const testsAfterEdit = ev("ev_3", 3, "exec", { command: "npm test", exitCode: 0 })
const failingTests = ev("ev_4", 4, "exec", { command: "npm test", exitCode: 1 })
const evidence = [testsBeforeEdit, edit, testsAfterEdit, failingTests]

const check = (claims: Claim[], list = evidence) => validateClaims({ claims, evidence: list, primaryWorkspace: "local" })
const claim = (kind: Claim["kind"], ids: string[], extra: Partial<Claim> = {}): Claim => ({ text: kind, kind, evidence: ids, ...extra })

describe("claim validation", () => {
  it("accepts fresh passing tests and recorded writes", () => {
    const result = check([claim("tests_passed", ["ev_3"]), claim("file_changed", ["ev_2"])])
    assert.equal(result.accepted, true)
    assert.deepEqual(result.checks.map((c) => c.status), ["verified", "verified"])
  })

  it("rule 1: rejects unknown evidence ids", () => {
    const result = check([claim("tests_passed", ["ev_99"])])
    assert.equal(result.accepted, false)
    assert.match(result.checks[0]!.problems[0]!, /ev_99 does not exist/)
  })

  it("rule 2: rejects failing or non-command evidence", () => {
    assert.match(check([claim("tests_passed", ["ev_4"])]).checks[0]!.problems.join(), /exited with code 1/)
    assert.match(check([claim("command_succeeded", ["ev_2"])]).checks[0]!.problems.join(), /must cite a command/)
  })

  it("rule 3: rejects tests that ran before the last change", () => {
    const result = check([claim("tests_passed", ["ev_1"])])
    assert.equal(result.accepted, false)
    assert.match(result.checks[0]!.problems.join(), /before the last file change/)
  })

  it("rule 4: file_changed needs a write", () => {
    assert.equal(check([claim("file_changed", ["ev_3"])]).accepted, false)
  })

  it("rule 5: evidence must come from the claimed workspace", () => {
    const staging = ev("ev_5", 5, "exec", { command: "curl /health", exitCode: 0, workspace: "staging" })
    const result = check([claim("service_healthy", ["ev_5"], { workspace: "prod" }), claim("file_changed", ["ev_2"])], [...evidence, staging])
    assert.match(result.checks[0]!.problems.join(), /recorded in workspace "staging"/)
  })

  it("rule 6: changed files need at least one verified claim", () => {
    const result = check([claim("unverified", [])])
    assert.equal(result.accepted, false)
    assert.match(result.problems.join(), /no claim is backed by evidence/)
    assert.equal(check([claim("unverified", [])], [testsBeforeEdit]).accepted, true)
  })

  it("rule 7: unverified claims pass with a warning", () => {
    const result = check([claim("tests_passed", ["ev_3"]), claim("unverified", [], { text: "prod logs are clean" })])
    assert.equal(result.accepted, true)
    assert.deepEqual(result.warnings, ["unverified: prod logs are clean"])
  })

  it("rule 8: per_docs needs doc evidence", () => {
    assert.match(check([claim("per_docs", ["ev_3"])]).checks[0]!.problems.join(), /doc evidence/)
  })

  it("verified claims need at least one citation", () => {
    assert.match(check([claim("observed", [])], [testsBeforeEdit]).checks[0]!.problems.join(), /must cite evidence/)
  })

  it("renders a report", () => {
    const report = renderReport({ summary: "fixed it", validation: check([claim("tests_passed", ["ev_3"], { text: "tests pass" })]) })
    assert.match(report, /✔ Task complete: fixed it/)
    assert.match(report, /✔ tests pass\n {6}local · ev_3 `npm test` → exit 0/)
  })
})
