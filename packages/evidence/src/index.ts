// Claim validation against recorded evidence, and the completion report. Pure functions over the event log.

import type { Claim, ClaimKind, Evidence } from "@trail-agent/protocol"

export type ClaimStatus = "verified" | "unverified" | "rejected"

export interface ClaimCheck {
  claim: Claim
  workspace: string
  status: ClaimStatus
  problems: string[]
  evidence: Evidence[]
}

export interface Validation {
  accepted: boolean
  checks: ClaimCheck[]
  /** Problems that are not tied to one claim. */
  problems: string[]
  warnings: string[]
}

export interface ValidationInput {
  claims: Claim[]
  /** All evidence recorded in the session so far. */
  evidence: Evidence[]
  primaryWorkspace: string
}

const NEEDS_EXEC: ReadonlySet<ClaimKind> = new Set(["tests_passed", "command_succeeded"])

/** Check every claim; the submission is accepted only when no claim is rejected and rule 6 holds. */
export function validateClaims(input: ValidationInput): Validation {
  const byId = new Map(input.evidence.map((e) => [e.id, e]))
  const lastWrite = new Map<string, number>()
  for (const e of input.evidence) {
    if (e.kind === "file_write") lastWrite.set(e.workspace, Math.max(lastWrite.get(e.workspace) ?? -1, e.seq))
  }

  const checks = input.claims.map((claim): ClaimCheck => {
    const workspace = claim.workspace ?? input.primaryWorkspace
    const problems: string[] = []
    const cited: Evidence[] = []
    // Rule 1: cited evidence exists in this session.
    for (const id of claim.evidence) {
      const found = byId.get(id)
      if (found) cited.push(found)
      else problems.push(`evidence ${id} does not exist in this session`)
    }
    if (claim.kind === "unverified") return { claim, workspace, status: "unverified", problems: [], evidence: cited }
    if (claim.evidence.length === 0) problems.push(`a "${claim.kind}" claim must cite evidence, or use kind "unverified"`)

    // Rule 5: evidence comes from the workspace the claim is about.
    for (const e of cited) {
      if (e.kind !== "doc" && e.workspace !== workspace) {
        problems.push(`${e.id} was recorded in workspace "${e.workspace}", but the claim is about "${workspace}"`)
      }
    }
    // Rule 2: test and command claims rest on successful commands.
    if (NEEDS_EXEC.has(claim.kind)) {
      const execs = cited.filter((e) => e.kind === "exec")
      if (execs.length === 0) problems.push(`"${claim.kind}" must cite a command (exec evidence)`)
      for (const e of execs) {
        if (e.exitCode !== 0) problems.push(`${e.id} (${e.command}) exited with code ${e.exitCode}`)
      }
      // Rule 3: tests must have run after the last file change in that workspace.
      const last = lastWrite.get(workspace)
      if (claim.kind === "tests_passed" && last !== undefined && execs.length > 0 && !execs.some((e) => e.seq > last)) {
        problems.push(`the cited test run happened before the last file change in "${workspace}"; run the tests again`)
      }
    }
    // Rule 4: file changes rest on recorded writes.
    if (claim.kind === "file_changed" && !cited.some((e) => e.kind === "file_write")) {
      problems.push(`"file_changed" must cite a write or edit (file_write evidence)`)
    }
    // Rule 8: documentation claims rest on library lookups.
    if (claim.kind === "per_docs" && !cited.some((e) => e.kind === "doc")) {
      problems.push(`"per_docs" must cite a documentation lookup (doc evidence)`)
    }
    return { claim, workspace, status: problems.length > 0 ? "rejected" : "verified", problems, evidence: cited }
  })

  const problems: string[] = []
  // Rule 6: a session that changed files must back at least one claim with evidence.
  if (lastWrite.size > 0 && !checks.some((c) => c.status === "verified")) {
    problems.push("files were changed in this session, but no claim is backed by evidence; verify the change (for example run the tests) or cite the file_write evidence")
  }
  // Rule 7: unverified claims pass with a warning.
  const warnings = checks.filter((c) => c.status === "unverified").map((c) => `unverified: ${c.claim.text}`)
  return { accepted: problems.length === 0 && checks.every((c) => c.status !== "rejected"), checks, problems, warnings }
}

/** Text sent back to the model when its submission is rejected. */
export function rejectionMessage(validation: Validation): string {
  const lines = ["Completion rejected. Fix these and call complete again:"]
  for (const check of validation.checks) {
    for (const problem of check.problems) lines.push(`- "${check.claim.text}": ${problem}`)
  }
  for (const problem of validation.problems) lines.push(`- ${problem}`)
  return lines.join("\n")
}

export interface ReportInput {
  summary: string
  validation: Validation
  /** Set when the harness gave up after repeated rejections. */
  proofFailed?: boolean
}

/** Plain-text completion report for terminals and logs. */
export function renderReport(input: ReportInput): string {
  const head = input.proofFailed ? "✖ Task ended without acceptable proof" : "✔ Task complete"
  const lines = [`${head}: ${input.summary}`, ""]
  for (const check of input.validation.checks) {
    const mark = check.status === "verified" ? "✔" : check.status === "unverified" ? "⚠" : "✖"
    const label = check.status === "unverified" ? `${check.claim.text} (unverified)` : check.claim.text
    const proof = check.evidence.map(describeEvidence).join("; ") || "no evidence"
    lines.push(`  ${mark} ${label}`)
    lines.push(`      ${check.workspace} · ${proof}`)
    for (const problem of check.problems) lines.push(`      ✖ ${problem}`)
  }
  for (const problem of input.validation.problems) lines.push(`  ✖ ${problem}`)
  return lines.join("\n")
}

export function describeEvidence(e: Evidence): string {
  switch (e.kind) {
    case "exec":
      return `${e.id} \`${e.command}\` → exit ${e.exitCode}${e.durationMs !== undefined ? ` (${(e.durationMs / 1000).toFixed(1)}s)` : ""}`
    case "file_write":
      return `${e.id} wrote ${e.path}`
    case "file_read":
      return `${e.id} read ${e.path}`
    case "doc":
      return `${e.id} ${e.doc} p.${e.page}`
    default:
      return e.id
  }
}
