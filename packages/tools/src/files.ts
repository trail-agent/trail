// File tools: read, write, edit. Writes require a prior read so the model never edits content it has not seen.

import { createHash } from "node:crypto"
import type { ToolContext, ToolDefinition, ToolRunResult } from "./types.ts"
import { WORKSPACE_PROPERTY } from "./common.ts"

const DEFAULT_LINES = 2000
const MAX_LINE_CHARS = 2000
const MAX_FILE_BYTES = 50 * 1024 * 1024

export const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16)

interface ReadArgs { path: string; offset?: number; limit?: number }

export const readTool: ToolDefinition<ReadArgs> = {
  effect: "read",
  spec: {
    name: "read",
    description:
      "Read a text file with line numbers, or list a directory. Reads up to 2000 lines by default; use offset (1-based line) and limit for large files. You must read a file before editing or overwriting it.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root, or absolute" },
        offset: { type: "integer", description: "First line to read, 1-based" },
        limit: { type: "integer", description: "Number of lines to read" },
        ...WORKSPACE_PROPERTY,
      },
      required: ["path"],
    },
  },
  describe: (args) => `read ${args.path}`,
  async execute(args, ctx) {
    const absolutePath = ctx.ops.resolve(args.path)
    const info = await ctx.ops.stat(absolutePath)
    if (!info.exists) return { content: `File not found: ${args.path}`, isError: true }
    if (info.isDirectory) {
      const entries = await ctx.ops.listDir(absolutePath)
      const listing = entries.slice(0, 500).map((e) => (e.isDirectory ? `${e.name}/` : e.name)).join("\n")
      return { content: `${listing}${entries.length > 500 ? `\n[${entries.length - 500} more entries]` : ""}` || "(empty directory)" }
    }
    if (info.size > MAX_FILE_BYTES) return { content: `File is too large (${info.size} bytes); use grep or bash to inspect it.`, isError: true }
    const buffer = await ctx.ops.readFile(absolutePath)
    if (buffer.subarray(0, 8000).includes(0)) return { content: `Binary file, not shown: ${args.path}`, isError: true }
    ctx.tracker.markRead(ctx.workspace, absolutePath, info.mtimeMs)
    const lines = buffer.toString("utf8").replace(/^﻿/, "").split(/\r?\n/)
    if (lines.at(-1) === "") lines.pop()
    const start = Math.max(1, args.offset ?? 1)
    const end = Math.min(lines.length, start - 1 + (args.limit ?? DEFAULT_LINES))
    const body = lines
      .slice(start - 1, end)
      .map((line, i) => `${String(start + i).padStart(6)}\t${line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line}`)
      .join("\n")
    const more = end < lines.length ? `\n[showing lines ${start}-${end} of ${lines.length}; use offset to read more]` : ""
    return {
      content: (body || "(empty file)") + more,
      evidence: { kind: "file_read", path: ctx.ops.display(absolutePath), diffHash: sha(buffer.toString("utf8")) },
    }
  },
}

/** Refuse writes to files that were never read or changed since the read. */
async function checkFresh(ctx: ToolContext, absolutePath: string, displayPath: string): Promise<ToolRunResult | undefined> {
  const info = await ctx.ops.stat(absolutePath)
  if (!info.exists) return undefined
  const readAt = ctx.tracker.readAt(ctx.workspace, absolutePath)
  if (readAt === undefined) return { content: `Read ${displayPath} before changing it.`, isError: true }
  if (readAt !== info.mtimeMs) return { content: `${displayPath} changed since you read it; read it again first.`, isError: true }
  return undefined
}

interface WriteArgs { path: string; content: string }

export const writeTool: ToolDefinition<WriteArgs> = {
  effect: "write",
  spec: {
    name: "write",
    description:
      "Create a file or replace its whole content. Prefer edit for changes to existing files. Overwriting an existing file requires reading it first.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root, or absolute" },
        content: { type: "string", description: "Complete file content" },
        ...WORKSPACE_PROPERTY,
      },
      required: ["path", "content"],
    },
  },
  describe: (args) => `write ${args.path} (${args.content.split("\n").length} lines)`,
  async execute(args, ctx) {
    const absolutePath = ctx.ops.resolve(args.path)
    const display = ctx.ops.display(absolutePath)
    const stale = await checkFresh(ctx, absolutePath, display)
    if (stale) return stale
    const existed = (await ctx.ops.stat(absolutePath)).exists
    await ctx.ops.writeFile(absolutePath, args.content)
    ctx.tracker.markRead(ctx.workspace, absolutePath, (await ctx.ops.stat(absolutePath)).mtimeMs)
    return {
      content: `${existed ? "Overwrote" : "Created"} ${display} (${args.content.split("\n").length} lines)`,
      evidence: { kind: "file_write", path: display, diffHash: sha(args.content) },
    }
  },
}

interface EditArgs { path: string; old_string: string; new_string: string; replace_all?: boolean }

// One character to one character, so indices in the normalized text map back to the original.
const normalize = (text: string) =>
  text
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, "\"")
    .replace(/[‐-―−]/g, "-")
    .replace(/[  -   　]/g, " ")

function findAll(haystack: string, needle: string): number[] {
  const found: number[] = []
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) found.push(i)
  return found
}

export const editTool: ToolDefinition<EditArgs> = {
  effect: "write",
  spec: {
    name: "edit",
    description:
      "Replace exact text in a file. old_string must match the file exactly (including indentation) and be unique unless replace_all is true; include surrounding lines to make it unique. Read the file first.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root, or absolute" },
        old_string: { type: "string", description: "Exact text to replace" },
        new_string: { type: "string", description: "Replacement text" },
        replace_all: { type: "boolean", description: "Replace every occurrence" },
        ...WORKSPACE_PROPERTY,
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  describe: (args) => `edit ${args.path}`,
  async execute(args, ctx) {
    if (args.old_string === args.new_string) return { content: "old_string and new_string are identical.", isError: true }
    if (args.old_string === "") return { content: "old_string is empty; use write to create files.", isError: true }
    const absolutePath = ctx.ops.resolve(args.path)
    const display = ctx.ops.display(absolutePath)
    if (!(await ctx.ops.stat(absolutePath)).exists) return { content: `File not found: ${args.path}`, isError: true }
    const stale = await checkFresh(ctx, absolutePath, display)
    if (stale) return stale

    const original = (await ctx.ops.readFile(absolutePath)).toString("utf8")
    const crlf = original.includes("\r\n")
    const adapt = (s: string) => (crlf && !s.includes("\r\n") ? s.replace(/\n/g, "\r\n") : s)
    const oldText = adapt(args.old_string)
    const newText = adapt(args.new_string)

    let positions = findAll(original, oldText)
    if (positions.length === 0) positions = findAll(normalize(original), normalize(oldText))
    if (positions.length === 0) {
      return { content: `old_string not found in ${display}. It must match exactly, including whitespace; read the file again to check.`, isError: true }
    }
    if (positions.length > 1 && !args.replace_all) {
      return { content: `old_string matches ${positions.length} places in ${display}; add surrounding lines to make it unique, or set replace_all.`, isError: true }
    }
    let updated = original
    for (const position of [...positions].reverse()) {
      updated = updated.slice(0, position) + newText + updated.slice(position + oldText.length)
    }
    await ctx.ops.writeFile(absolutePath, updated)
    ctx.tracker.markRead(ctx.workspace, absolutePath, (await ctx.ops.stat(absolutePath)).mtimeMs)

    const firstLine = updated.slice(0, positions[0]).split("\n").length
    const lines = updated.split(/\r?\n/)
    const from = Math.max(1, firstLine - 3)
    const to = Math.min(lines.length, firstLine + newText.split("\n").length + 2)
    const snippet = lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(6)}\t${l}`).join("\n")
    return {
      content: `Edited ${display}: ${positions.length} replacement(s).\n${snippet}`,
      evidence: { kind: "file_write", path: display, diffHash: sha(`${display}\n${oldText}\n${newText}`) },
    }
  },
}
