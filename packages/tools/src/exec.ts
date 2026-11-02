// Command and search tools: bash, grep, glob, and read_output for full outputs behind evidence ids.

import { WORKSPACE_PROPERTY } from "./common.ts"
import type { ToolDefinition } from "./types.ts"

const DEFAULT_TIMEOUT_S = 120
const MAX_TIMEOUT_S = 600
const SEARCH_LIMIT = 200

interface BashArgs { command: string; timeout_seconds?: number; workdir?: string }

export const bashTool: ToolDefinition<BashArgs> = {
  effect: "exec",
  spec: {
    name: "bash",
    description:
      "Run a shell command in the workspace and return its combined output and exit code. Use it to run tests, builds, git and other CLI tools. Each call is a fresh shell starting in the workspace root (or workdir). Default timeout 120s, max 600s.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command to run" },
        timeout_seconds: { type: "integer", description: "Timeout in seconds (default 120, max 600)" },
        workdir: { type: "string", description: "Directory to run in, relative to the workspace root" },
        ...WORKSPACE_PROPERTY,
      },
      required: ["command"],
    },
  },
  describe: (args) => args.command,
  async execute(args, ctx) {
    const timeoutS = Math.min(Math.max(1, args.timeout_seconds ?? DEFAULT_TIMEOUT_S), MAX_TIMEOUT_S)
    const cwd = args.workdir ? ctx.ops.resolve(args.workdir) : ctx.ops.root
    const result = await ctx.ops.exec(args.command, { cwd, timeoutMs: timeoutS * 1000, signal: ctx.signal, onOutput: ctx.onOutput })
    const status = result.timedOut ? `timed out after ${timeoutS}s` : result.aborted ? "aborted" : `exit code ${result.exitCode}`
    const output = result.output.trimEnd()
    return {
      content: `${output || "(no output)"}\n[${status}]`,
      isError: result.exitCode !== 0 || result.timedOut || result.aborted,
      evidence: {
        kind: "exec",
        command: args.command,
        exitCode: result.timedOut || result.aborted ? -1 : result.exitCode,
        durationMs: result.durationMs,
        outputExcerpt: output.slice(-300),
      },
    }
  },
}

interface GrepArgs { pattern: string; path?: string; glob?: string; ignore_case?: boolean }

export const grepTool: ToolDefinition<GrepArgs> = {
  effect: "read",
  spec: {
    name: "grep",
    description: "Search file contents with a regular expression. Returns file:line: text, up to 200 matches. Skips node_modules and .git.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression" },
        path: { type: "string", description: "File or directory to search (default: workspace root)" },
        glob: { type: "string", description: "Only files matching this glob, e.g. *.ts or src/**/*.py" },
        ignore_case: { type: "boolean" },
        ...WORKSPACE_PROPERTY,
      },
      required: ["pattern"],
    },
  },
  describe: (args) => `grep ${args.pattern}${args.path ? ` in ${args.path}` : ""}`,
  async execute(args, ctx) {
    try {
      new RegExp(args.pattern)
    } catch (error) {
      return { content: `Invalid regular expression: ${(error as Error).message}`, isError: true }
    }
    const matches = await ctx.ops.grep(args.pattern, {
      path: ctx.ops.resolve(args.path ?? "."),
      glob: args.glob,
      ignoreCase: args.ignore_case,
      limit: SEARCH_LIMIT,
    })
    if (matches.length === 0) return { content: "No matches." }
    const body = matches.map((m) => `${m.file}:${m.line}: ${m.text}`).join("\n")
    return { content: matches.length >= SEARCH_LIMIT ? `${body}\n[stopped at ${SEARCH_LIMIT} matches; narrow the search]` : body }
  },
}

interface GlobArgs { pattern: string; path?: string }

export const globTool: ToolDefinition<GlobArgs> = {
  effect: "read",
  spec: {
    name: "glob",
    description: "Find files by name pattern, e.g. **/*.ts. Returns paths relative to the workspace root, newest first, up to 200.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern" },
        path: { type: "string", description: "Directory to search from (default: workspace root)" },
        ...WORKSPACE_PROPERTY,
      },
      required: ["pattern"],
    },
  },
  describe: (args) => `glob ${args.pattern}`,
  async execute(args, ctx) {
    const files = await ctx.ops.glob(args.pattern, ctx.ops.resolve(args.path ?? "."), SEARCH_LIMIT)
    return { content: files.length > 0 ? files.join("\n") : "No files found." }
  },
}

interface ReadOutputArgs { evidence_id: string; offset?: number; limit?: number }

export const readOutputTool: ToolDefinition<ReadOutputArgs> = {
  effect: "none",
  spec: {
    name: "read_output",
    description:
      "Read the full output of an earlier tool call by its evidence id (e.g. ev_12), when the shown output was truncated or has been compacted away.",
    parameters: {
      type: "object",
      properties: {
        evidence_id: { type: "string" },
        offset: { type: "integer", description: "First line, 1-based" },
        limit: { type: "integer", description: "Number of lines (default 500)" },
      },
      required: ["evidence_id"],
    },
  },
  describe: (args) => `read_output ${args.evidence_id}`,
  async execute(args, ctx) {
    const output = ctx.readOutput(args.evidence_id)
    if (output === undefined) return { content: `No stored output for ${args.evidence_id}.`, isError: true }
    const lines = output.split("\n")
    const start = Math.max(1, args.offset ?? 1)
    const end = Math.min(lines.length, start - 1 + (args.limit ?? 500))
    const more = end < lines.length ? `\n[lines ${start}-${end} of ${lines.length}]` : ""
    return { content: lines.slice(start - 1, end).join("\n") + more }
  },
}
