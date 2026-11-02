// Re-exports used by the loop, kept in one place so the loop file stays focused.

export type { AssistantMessage, Message, ToolCall, ToolResultMessage, ToolSpec, TurnEndReason } from "@trail-agent/protocol"
export type { HttpRequest as HttpRequestLike } from "@trail-agent/llm"
