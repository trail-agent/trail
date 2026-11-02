// Tool definition contract shared by built-in tools and the core that runs them.

import type { EvidenceDraft, ToolSpec } from "@trail-agent/protocol"
import type { Operations } from "@trail-agent/workspace"

/** What a tool does, for permission decisions. */
export type ToolEffect = "read" | "write" | "exec" | "none"

/** Remembers which files the model has read, so edits never apply to unseen or changed content. */
export interface FileTracker {
  markRead(workspace: string, absolutePath: string, mtimeMs: number): void
  /** mtime recorded at the last read, or undefined if never read. */
  readAt(workspace: string, absolutePath: string): number | undefined
}

export interface ToolContext {
  ops: Operations
  /** Workspace alias the call runs in. */
  workspace: string
  /** Operations of any workspace in the session, for tools that span machines. */
  workspaceOps(alias: string): Operations | undefined
  primaryWorkspace: string
  tracker: FileTracker
  signal?: AbortSignal
  onOutput?(chunk: string): void
  /** Full output behind an evidence id, provided by the core. */
  readOutput(evidenceId: string): string | undefined
}

export interface ToolRunResult {
  content: string
  isError?: boolean
  /** Evidence the harness should record for this run. */
  evidence?: EvidenceDraft
}

export interface ToolDefinition<Args = Record<string, unknown>> {
  spec: ToolSpec
  effect: ToolEffect
  /** One line for permission prompts and timelines. */
  describe(args: Args): string
  /**
   * Where the call takes effect, for permissions and evidence. Defaults to `args.workspace` and `args.path`;
   * tools that span workspaces (transfer) name their destination here.
   */
  target?(args: Args): { workspace?: string; path?: string }
  execute(args: Args, context: ToolContext): Promise<ToolRunResult>
}

export function createFileTracker(): FileTracker {
  const reads = new Map<string, number>()
  const key = (workspace: string, path: string) => `${workspace}\u0000${path}`
  return {
    markRead: (workspace, path, mtime) => void reads.set(key(workspace, path), mtime),
    readAt: (workspace, path) => reads.get(key(workspace, path)),
  }
}
