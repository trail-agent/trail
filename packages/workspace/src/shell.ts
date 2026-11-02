// Pick the shell for local commands: bash everywhere; on Windows Git Bash first, PowerShell as fallback.

import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"

export interface ShellChoice {
  kind: "bash" | "powershell" | "sh"
  path: string
  args(command: string): string[]
}

const POWERSHELL_UTF8 = "try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}; "

let cached: ShellChoice | undefined

export function detectShell(): ShellChoice {
  cached ??= process.platform === "win32" ? detectWindows() : detectPosix()
  return cached
}

function detectPosix(): ShellChoice {
  const path = ["/bin/bash", "/usr/bin/bash"].find(existsSync)
  if (path) return { kind: "bash", path, args: (c) => ["-c", c] }
  return { kind: "sh", path: "/bin/sh", args: (c) => ["-c", c] }
}

function detectWindows(): ShellChoice {
  const bash = findGitBash()
  if (bash) return { kind: "bash", path: bash, args: (c) => ["-c", c] }
  return {
    kind: "powershell",
    path: "powershell.exe",
    args: (c) => ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_UTF8 + c],
  }
}

/** Git Bash only; System32\bash.exe is WSL and runs in a different filesystem. */
function findGitBash(): string | undefined {
  const candidates = [
    process.env.TRAIL_BASH,
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
    join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
    join(process.env.LOCALAPPDATA ?? "", "Programs", "Git", "bin", "bash.exe"),
  ]
  try {
    const git = execFileSync("where", ["git"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/)[0]
    if (git) candidates.push(join(dirname(dirname(git)), "bin", "bash.exe"))
  } catch {
    // git not on PATH
  }
  return candidates.find((c): c is string => !!c && existsSync(c))
}
