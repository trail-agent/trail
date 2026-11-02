// Built-in tools.

import { bashTool, globTool, grepTool, readOutputTool } from "./exec.ts"
import { editTool, readTool, writeTool } from "./files.ts"
import type { ToolDefinition } from "./types.ts"

export type { FileTracker, ToolContext, ToolDefinition, ToolEffect, ToolRunResult } from "./types.ts"
export { createFileTracker } from "./types.ts"
export { validate } from "./schema.ts"
export { COMPLETE_TOOL_NAME, completeSpec } from "./complete.ts"
export { bashTool, editTool, globTool, grepTool, readOutputTool, readTool, writeTool }
export { sha } from "./files.ts"

// The array erases each tool's argument type; arguments are validated against the schema before execute.
export const builtinTools = [readTool, writeTool, editTool, bashTool, grepTool, globTool, readOutputTool] as unknown as ToolDefinition[]
