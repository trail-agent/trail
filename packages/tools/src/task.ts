// The task tool's schema: delegate an exploration to a subagent with its own context. The core runs it.

import type { ToolSpec } from "@trail-agent/protocol"

export const TASK_TOOL_NAME = "task"

export const taskSpec: ToolSpec = {
  name: TASK_TOOL_NAME,
  description: [
    "Delegate a self-contained investigation to a subagent that has its own context and the same tools (except complete and task).",
    "Use it for work that reads a lot but needs only a conclusion back: searching a codebase, digging through logs on a server, comparing configs across workspaces.",
    "The subagent's commands produce evidence ids in this session, so you can cite them in complete. Its permissions are the same as yours.",
    "Give a precise prompt: what to find, where (workspace aliases), and what to report.",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      description: { type: "string", description: "Three to six words, shown to the user" },
      prompt: { type: "string", description: "Full instructions for the subagent" },
    },
    required: ["description", "prompt"],
  },
}
