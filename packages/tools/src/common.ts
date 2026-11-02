// Schema fragments shared by tools.

/** Every workspace-bound tool takes an optional workspace alias; the session's primary workspace is the default. */
export const WORKSPACE_PROPERTY = {
  workspace: { type: "string", description: "Workspace alias to run in; defaults to the primary workspace" },
} as const
