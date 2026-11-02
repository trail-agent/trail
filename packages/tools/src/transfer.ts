// transfer: copy a file between workspaces (for example local → staging). Permissions apply to the destination.

import { createHash } from "node:crypto"
import type { ToolDefinition } from "./types.ts"

const MAX_BYTES = 100 * 1024 * 1024

interface TransferArgs {
  from_workspace?: string
  from_path: string
  to_workspace?: string
  to_path: string
  overwrite?: boolean
}

export const transferTool: ToolDefinition<TransferArgs> = {
  effect: "write",
  spec: {
    name: "transfer",
    description:
      "Copy one file between workspaces, e.g. a build artifact or config from local to a server. Workspaces default to the primary one. Replacing an existing destination file requires overwrite: true.",
    parameters: {
      type: "object",
      properties: {
        from_workspace: { type: "string" },
        from_path: { type: "string" },
        to_workspace: { type: "string" },
        to_path: { type: "string" },
        overwrite: { type: "boolean", description: "Replace the destination if it exists" },
      },
      required: ["from_path", "to_path"],
    },
  },
  describe: (args) => `${args.from_workspace ?? "primary"}:${args.from_path} → ${args.to_workspace ?? "primary"}:${args.to_path}`,
  target: (args) => ({ workspace: args.to_workspace, path: args.to_path }),
  async execute(args, ctx) {
    const src = ctx.workspaceOps(args.from_workspace ?? ctx.primaryWorkspace)
    if (!src) return { content: `Unknown workspace "${args.from_workspace}".`, isError: true }
    const srcPath = src.resolve(args.from_path)
    const info = await src.stat(srcPath)
    if (!info.isFile) return { content: `Not a file: ${args.from_path}`, isError: true }
    if (info.size > MAX_BYTES) return { content: `File too large to transfer (${info.size} bytes, limit ${MAX_BYTES}).`, isError: true }
    const dstPath = ctx.ops.resolve(args.to_path)
    const existing = await ctx.ops.stat(dstPath)
    if (existing.isDirectory) return { content: `Destination is a directory; give a file path: ${args.to_path}`, isError: true }
    if (existing.exists && !args.overwrite) {
      return { content: `${args.to_path} already exists in "${ctx.workspace}"; set overwrite: true to replace it.`, isError: true }
    }
    const content = await src.readFile(srcPath)
    await ctx.ops.writeFile(dstPath, content)
    ctx.tracker.markRead(ctx.workspace, dstPath, (await ctx.ops.stat(dstPath)).mtimeMs)
    const display = ctx.ops.display(dstPath)
    return {
      content: `Copied ${content.length} bytes to ${ctx.workspace}:${display}`,
      evidence: { kind: "file_write", path: display, diffHash: createHash("sha256").update(content).digest("hex").slice(0, 16) },
    }
  },
}
