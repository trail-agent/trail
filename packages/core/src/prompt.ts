// System prompt: sections in a fixed order, most stable first, so the cached prefix survives.

import type { PermissionLevel } from "@trail-agent/protocol"

export interface PromptWorkspace {
  alias: string
  primary: boolean
  os: string
  shell: string
  root: string
  permission: PermissionLevel
  role?: string
}

export interface PromptInput {
  workspaces: PromptWorkspace[]
  instructions: Array<{ workspace: string; file: string; content: string }>
  date: string
}

const IDENTITY =
  "You are Trail, a coding agent that works on the user's machines through tools. Each tool runs in a workspace: a directory on one machine."

const RULES = `- Read the relevant code before changing it, and follow the conventions of the surrounding code.
- Keep changes to what the task needs. Do not refactor or add features nobody asked for.
- After changing code, verify it: run the tests, the build, or the command that exercises the change.
- Tool results end with an evidence line such as [evidence: ev_12 | local | exit 0]. When a task changed anything, finish by calling complete with claims that cite those evidence ids. Never claim something no tool result showed you; mark what you could not check as "unverified".
- A question that needs no changes can be answered directly, without complete.
- If the request is ambiguous, or an action would be risky, ask the user instead of guessing.
- Long outputs are truncated; read_output(evidence id) returns the full text.
- Respect each workspace's permission. Denied actions are the user's decision; do not try to work around them.`

const LEVELS: Record<PermissionLevel, string> = {
  "full": "full access",
  "ask-write": "changes need user approval",
  "read-only": "read-only, writes are refused",
  "ask-all": "every action needs approval",
}

export function buildSystemPrompt(input: PromptInput): string {
  const workspaces = input.workspaces
    .map((w) => {
      const parts = [`${w.alias}${w.primary ? " (primary)" : ""}: ${w.os}`, `root ${w.root.split("\\").join("/")}`, `shell ${w.shell}`, LEVELS[w.permission]]
      return `- ${parts.join("; ")}${w.role ? `. ${w.role}` : ""}`
    })
    .join("\n")
  const sections = [IDENTITY, `<rules>\n${RULES}\n</rules>`, `<workspaces>\n${workspaces}\n</workspaces>`]
  for (const instruction of input.instructions) {
    sections.push(`<project_instructions workspace="${instruction.workspace}" file="${instruction.file}">\n${instruction.content.trim()}\n</project_instructions>`)
  }
  sections.push(`<environment>\nToday's date: ${input.date}\n</environment>`)
  return sections.join("\n\n")
}
