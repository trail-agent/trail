// Operations on the machine Trail runs on.

import { spawn, spawnSync } from "node:child_process"
import { glob as fsGlob, mkdir, readdir, readFile, stat as fsStat, writeFile } from "node:fs/promises"
import { release, version } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { detectShell } from "./shell.ts"
import type { ExecOptions, ExecResult, FileStat, GrepMatch, GrepOptions, Operations, WorkspaceInfo } from "./types.ts"

const MAX_CAPTURE = 20 * 1024 * 1024
const SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn"])
const EXCLUDED = /(^|[\\/])(node_modules|\.git)([\\/]|$)/

export function createLocalOperations(root: string): Operations {
  const absoluteRoot = resolve(root)
  const toRelative = (absolutePath: string) => relative(absoluteRoot, absolutePath).split("\\").join("/")
  const isInside = (absolutePath: string) => {
    const rel = relative(absoluteRoot, absolutePath)
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
  }

  return {
    root: absoluteRoot,
    async info(): Promise<WorkspaceInfo> {
      return { os: `${version()} ${release()} (${process.platform} ${process.arch})`, shell: detectShell().kind }
    },
    resolve: (path) => resolve(absoluteRoot, path),
    display: (absolutePath) => (isInside(absolutePath) ? toRelative(absolutePath) || "." : absolutePath),
    isInside,
    readFile: (absolutePath) => readFile(absolutePath),
    async writeFile(absolutePath, content) {
      await mkdir(dirname(absolutePath), { recursive: true })
      await writeFile(absolutePath, content)
    },
    stat,
    async listDir(absolutePath) {
      const entries = await readdir(absolutePath, { withFileTypes: true })
      return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() })).sort((a, b) => a.name.localeCompare(b.name))
    },
    exec: (command, options) => exec(command, { cwd: absoluteRoot, ...options }),
    async glob(pattern, cwd, limit) {
      const found: Array<{ path: string; mtime: number }> = []
      for await (const entry of fsGlob(pattern, { cwd, exclude: (p: string) => EXCLUDED.test(p) })) {
        const absolutePath = join(cwd, entry)
        const info = await stat(absolutePath)
        if (info.isFile) found.push({ path: toRelative(absolutePath), mtime: info.mtimeMs })
        if (found.length >= limit * 4) break
      }
      return found.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map((f) => f.path)
    },
    grep: (pattern, options) => (hasRipgrep() ? grepWithRipgrep(pattern, options, toRelative) : grepWithNode(pattern, options, toRelative)),
  }
}

async function stat(absolutePath: string): Promise<FileStat> {
  try {
    const s = await fsStat(absolutePath)
    return { exists: true, isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs }
  } catch {
    return { exists: false, isFile: false, isDirectory: false, size: 0, mtimeMs: 0 }
  }
}

function exec(command: string, options: ExecOptions): Promise<ExecResult> {
  const shell = detectShell()
  const started = performance.now()
  return new Promise((resolvePromise) => {
    const child = spawn(shell.path, shell.args(command), {
      cwd: options.cwd,
      env: process.env,
      windowsHide: true,
      detached: process.platform !== "win32",
    })
    let output = ""
    let timedOut = false
    let aborted = false
    const onData = (data: Buffer) => {
      const text = data.toString("utf8")
      if (output.length < MAX_CAPTURE) output += text
      options.onOutput?.(text)
    }
    child.stdout.on("data", onData)
    child.stderr.on("data", onData)
    const kill = () => killTree(child.pid)
    const timer = options.timeoutMs ? setTimeout(() => { timedOut = true; kill() }, options.timeoutMs) : undefined
    const onAbort = () => { aborted = true; kill() }
    options.signal?.addEventListener("abort", onAbort, { once: true })
    const finish = (exitCode: number) => {
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", onAbort)
      resolvePromise({ exitCode, output, timedOut, aborted, durationMs: Math.round(performance.now() - started) })
    }
    child.on("error", (error) => {
      output += `\n${error.message}`
      finish(127)
    })
    child.on("close", (code, signal) => finish(code ?? (signal ? 128 : 1)))
  })
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true })
    else process.kill(-pid, "SIGKILL")
  } catch {
    // already exited
  }
}

let ripgrep: boolean | undefined
function hasRipgrep(): boolean {
  ripgrep ??= spawnSync("rg", ["--version"], { windowsHide: true }).status === 0
  return ripgrep
}

function grepWithRipgrep(pattern: string, options: GrepOptions, toRelative: (p: string) => string): Promise<GrepMatch[]> {
  const args = ["--line-number", "--no-heading", "--color", "never", "--max-columns", "500"]
  if (options.ignoreCase) args.push("-i")
  if (options.glob) args.push("-g", options.glob)
  args.push("-e", pattern, options.path)
  const result = spawnSync("rg", args, { encoding: "utf8", maxBuffer: MAX_CAPTURE, windowsHide: true })
  const matches: GrepMatch[] = []
  for (const line of (result.stdout ?? "").split(/\r?\n/)) {
    const m = /^(.*?):(\d+):(.*)$/.exec(line)
    if (!m) continue
    matches.push({ file: toRelative(resolve(m[1]!)), line: Number(m[2]), text: m[3]! })
    if (matches.length >= options.limit) break
  }
  return Promise.resolve(matches)
}

async function grepWithNode(pattern: string, options: GrepOptions, toRelative: (p: string) => string): Promise<GrepMatch[]> {
  const regex = new RegExp(pattern, options.ignoreCase ? "i" : "")
  const fileFilter = options.glob ? globToRegExp(options.glob) : undefined
  const matches: GrepMatch[] = []
  const visit = async (absolutePath: string, isRoot: boolean): Promise<void> => {
    if (matches.length >= options.limit) return
    const info = await stat(absolutePath)
    if (info.isDirectory) {
      for (const entry of await readdir(absolutePath, { withFileTypes: true })) {
        if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue
        await visit(join(absolutePath, entry.name), false)
        if (matches.length >= options.limit) return
      }
      return
    }
    if (!info.isFile || info.size > 2 * 1024 * 1024) return
    const rel = toRelative(absolutePath)
    if (!isRoot && fileFilter && !fileFilter.test(rel)) return
    const content = await readFile(absolutePath)
    if (content.subarray(0, 8000).includes(0)) return
    const lines = content.toString("utf8").split(/\r?\n/)
    for (let i = 0; i < lines.length && matches.length < options.limit; i++) {
      if (regex.test(lines[i]!)) matches.push({ file: rel, line: i + 1, text: lines[i]!.slice(0, 500) })
    }
  }
  await visit(options.path, true)
  return matches
}

/** Minimal glob for file filtering: `*`, `**`, `?`, `{a,b}`; a pattern without `/` matches the basename. */
export function globToRegExp(pattern: string): RegExp {
  let source = ""
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        source += ".*"
        i++
        if (pattern[i + 1] === "/") i++
      } else source += "[^/]*"
    } else if (c === "?") source += "[^/]"
    else if (c === "{") source += "("
    else if (c === "}") source += ")"
    else if (c === "," && source.includes("(")) source += "|"
    else source += c.replace(/[.+^$()|[\]\\]/g, "\\$&")
  }
  return new RegExp(pattern.includes("/") ? `^${source}$` : `(^|/)${source}$`)
}
