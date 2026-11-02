// Permission decisions from the workspace's level, the tool's effect, and dangerous-command patterns.

import type { PermissionLevel } from "@trail-agent/protocol"
import type { ToolEffect } from "@trail-agent/tools"

export interface PermissionInput {
  effect: ToolEffect
  level: PermissionLevel
  /** Shell command, for exec tools. */
  command?: string
  /** Whether a written path lies inside the workspace root. */
  insideRoot?: boolean
  /** The user chose "always allow" for this tool in this workspace earlier in the session. */
  sessionAllowed: boolean
}

export interface PermissionCheck {
  decision: "allow" | "ask" | "deny"
  reason: string
}

const DANGEROUS: Array<[RegExp, string]> = [
  [/\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(\/|~|\*|\$HOME)(\s|$)/, "recursive delete of a root, home or wildcard path"],
  [/\bmkfs(\.\w+)?\b/, "formats a filesystem"],
  [/\bdd\s+[^|]*\bof=\/dev\//, "writes to a raw device"],
  [/\b(shutdown|reboot|halt|poweroff)\b/, "powers off or restarts the machine"],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, "fork bomb"],
  [/\bchmod\s+(-R\s+)?777\s+\//, "opens permissions on system paths"],
  [/\bgit\s+push\b[^|;&]*(--force|-f\b)/, "force-pushes git history"],
  [/\bgit\s+reset\s+--hard\b/, "discards uncommitted work"],
  [/\bgit\s+clean\s+-[a-zA-Z]*f/, "deletes untracked files"],
  [/\b(drop\s+(database|table|schema)|truncate\s+table)\b/i, "drops database objects"],
  [/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/, "pipes a download into a shell"],
  [/>\s*\/dev\/(sd|nvme|hd)/, "overwrites a disk device"],
]

const READ_ONLY_COMMANDS = new Set([
  "cat", "ls", "head", "tail", "grep", "rg", "find", "pwd", "echo", "wc", "stat", "df", "du", "ps", "uname",
  "whoami", "id", "date", "uptime", "free", "which", "file", "tree", "less", "sort", "uniq", "cut", "jq",
])
const READ_ONLY_SUBCOMMANDS: Record<string, Set<string>> = {
  git: new Set(["status", "log", "diff", "show", "branch", "remote", "rev-parse", "blame"]),
  systemctl: new Set(["status", "is-active", "list-units"]),
  docker: new Set(["ps", "logs", "images", "inspect"]),
  journalctl: new Set(["*"]),
}

export function dangerReason(command: string): string | undefined {
  return DANGEROUS.find(([pattern]) => pattern.test(command))?.[1]
}

/** True when every segment of the command is a known read-only program and nothing is redirected to a file. */
export function isReadOnlyCommand(command: string): boolean {
  if (/(^|[^>&0-9])>|>>|\btee\b|`|\$\(/.test(command)) return false
  return command.split(/&&|\|\||;|\|/).every((segment) => {
    const [program, sub] = segment.trim().split(/\s+/)
    if (!program) return true
    const subcommands = READ_ONLY_SUBCOMMANDS[program]
    if (subcommands) return subcommands.has("*") || (sub !== undefined && subcommands.has(sub))
    return READ_ONLY_COMMANDS.has(program)
  })
}

export function checkPermission(input: PermissionInput): PermissionCheck {
  if (input.effect === "none") return { decision: "allow", reason: "no side effects" }
  const danger = input.command ? dangerReason(input.command) : undefined
  if (danger) return { decision: input.level === "read-only" ? "deny" : "ask", reason: `dangerous: ${danger}` }
  if (input.effect === "write" && input.insideRoot === false) {
    return { decision: input.level === "read-only" ? "deny" : "ask", reason: "writes outside the workspace root" }
  }
  switch (input.level) {
    case "full":
      return { decision: "allow", reason: "workspace permission is full" }
    case "read-only":
      if (input.effect === "read") return { decision: "allow", reason: "read in a read-only workspace" }
      if (input.effect === "exec" && input.command && isReadOnlyCommand(input.command)) {
        return { decision: "allow", reason: "read-only command" }
      }
      return { decision: "deny", reason: "workspace is read-only" }
    case "ask-all":
      return input.sessionAllowed ? { decision: "allow", reason: "allowed for this session" } : { decision: "ask", reason: "workspace asks for every action" }
    case "ask-write":
      if (input.effect === "read") return { decision: "allow", reason: "reads are allowed" }
      return input.sessionAllowed ? { decision: "allow", reason: "allowed for this session" } : { decision: "ask", reason: "changes need approval" }
  }
}
