// Shared types for every Trail package: messages, evidence, claims, workspaces and the event log.

export type JsonSchema = Record<string, unknown>

/** A tool the model may call. */
export interface ToolSpec {
  name: string
  description: string
  parameters: JsonSchema
}

export interface ToolCall {
  id: string
  name: string
  args: unknown
}

export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type StopReason = "stop" | "tool_use" | "length" | "error" | "aborted"

export interface UserMessage {
  role: "user"
  text: string
}

export interface AssistantMessage {
  role: "assistant"
  text: string
  /** Readable reasoning for display only; never sent back. */
  thinking?: string
  /**
   * The provider's own content blocks, replayed unchanged on later requests to the same protocol
   * (Anthropic thinking blocks must be sent back exactly as received).
   */
  raw?: { protocol: string; content: unknown[] }
  toolCalls: ToolCall[]
  stopReason: StopReason
  usage?: Usage
  errorMessage?: string
}

export interface ToolResultMessage {
  role: "tool"
  callId: string
  name: string
  content: string
  isError: boolean
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage

// ---------------------------------------------------------------- workspaces

export type PermissionLevel = "full" | "ask-write" | "read-only" | "ask-all"

export interface LocalWorkspace {
  id: string
  name: string
  kind: "local"
  path: string
}

export interface SshWorkspace {
  id: string
  name: string
  kind: "ssh"
  path: string
  ssh: {
    host: string
    port: number
    username: string
    auth: "password" | "key"
    keyPath?: string
    hostKeyFingerprint: string
  }
}

export type Workspace = LocalWorkspace | SshWorkspace

export interface SessionWorkspace {
  workspace: Workspace
  /** Short name shown to the model: local, staging, prod. */
  alias: string
  role?: string
  permission: PermissionLevel
}

// ---------------------------------------------------------------- evidence

export type EvidenceKind = "exec" | "file_read" | "file_write" | "http" | "screenshot" | "doc"

/** A verifiable record produced by the harness, never by the model. */
export interface Evidence {
  id: string
  kind: EvidenceKind
  /** Workspace alias; empty for library evidence. */
  workspace: string
  /** Event sequence number at which the evidence was recorded. */
  seq: number
  command?: string
  exitCode?: number
  durationMs?: number
  outputHash?: string
  outputExcerpt?: string
  path?: string
  diffHash?: string
  library?: string
  doc?: string
  page?: number
  section?: string
  quoteHash?: string
}

/** Evidence fields a tool reports; the harness assigns id, workspace and seq. */
export type EvidenceDraft = Omit<Evidence, "id" | "workspace" | "seq">

export type ClaimKind =
  | "tests_passed"
  | "command_succeeded"
  | "file_changed"
  | "service_healthy"
  | "observed"
  | "per_docs"
  | "unverified"

export interface Claim {
  text: string
  kind: ClaimKind
  evidence: string[]
  workspace?: string
}

// ---------------------------------------------------------------- events

export interface EventPayloads {
  "session/created": { title: string; workspaces: SessionWorkspace[]; primary: string; model: string }
  "turn/start": Record<string, never>
  "turn/end": { reason: TurnEndReason }
  "user/message": { text: string }
  "assistant/message": { message: AssistantMessage }
  "llm/request": { model: string; protocol: string; url: string; bodyHash: string; bodyBytes: number; purpose?: "compaction" }
  "llm/response": { stopReason: StopReason; durationMs: number; firstTokenMs?: number; error?: string }
  "llm/usage": { model: string; usage: Usage; cost: number }
  "tool/call": { callId: string; name: string; args: unknown }
  "tool/result": {
    callId: string
    name: string
    content: string
    isError: boolean
    evidenceId?: string
    /** Blob hash of the untruncated output when `content` was shortened. */
    fullOutputHash?: string
  }
  "evidence/recorded": { evidence: Evidence }
  "permission/asked": { callId: string; tool: string; workspace: string; summary: string; reason: string }
  "permission/answered": { callId: string; decision: PermissionDecision }
  "complete/submitted": { callId: string; summary: string; claims: Claim[] }
  "complete/rejected": { callId: string; problems: string[] }
  "complete/accepted": { callId: string; warnings: string[] }
  "reminder/added": { text: string }
  /** Context compaction never deletes events; it changes how the log is projected into the model's context. */
  "compaction/applied":
    | { kind: "prune"; callIds: string[]; tokensBefore: number }
    | { kind: "summary"; summary: string; throughSeq: number; tokensBefore: number; trigger: "threshold" | "overflow" }
  /** Events between start and end belong to a subagent and are not part of the parent's context. */
  "subagent/start": { callId: string; description: string }
  "subagent/end": { callId: string; reason: TurnEndReason }
}

export type TurnEndReason = "completed" | "no_tool_calls" | "max_steps" | "error" | "aborted" | "proof_failed"
export type PermissionDecision = "allow" | "allow_session" | "deny"

export type EventType = keyof EventPayloads

export type TrailEvent = {
  [K in EventType]: { sessionId: string; seq: number; at: number; type: K; payload: EventPayloads[K] }
}[EventType]

export type EventOf<K extends EventType> = Extract<TrailEvent, { type: K }>

/** Narrow a list of events to one type. */
export function eventsOfType<K extends EventType>(events: readonly TrailEvent[], type: K): EventOf<K>[] {
  return events.filter((event): event is EventOf<K> => event.type === type)
}
