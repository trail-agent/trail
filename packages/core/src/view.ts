// The model's context is a projection of the event log: everything the model saw is in the log.
// Compaction events change the projection (pruned outputs, summarized history); no event is ever deleted.

import { eventsOfType, type Message, type TrailEvent } from "@trail-agent/protocol"

const INTERRUPTED = "Not executed: the session was interrupted before this tool ran."

export const SUMMARY_OPEN = "<conversation-summary>"
export const SUMMARY_CLOSE = "</conversation-summary>"

export function prunedPlaceholder(name: string, evidenceId: string | undefined): string {
  return `[${name} output removed to save context${evidenceId ? `; read_output("${evidenceId}") shows it again` : ""}]`
}

export interface ContextWithSeqs {
  messages: Message[]
  /** Event sequence number behind each message. */
  seqs: number[]
}

/** Rebuild the conversation from events, closing tool calls an interrupted run left without results. */
export function buildContext(events: readonly TrailEvent[]): Message[] {
  return buildContextWithSeqs(events).messages
}

export function buildContextWithSeqs(events: readonly TrailEvent[]): ContextWithSeqs {
  const compactions = eventsOfType(events, "compaction/applied")
  const pruned = new Set(compactions.flatMap((c) => (c.payload.kind === "prune" ? c.payload.callIds : [])))
  const summary = compactions.filter((c) => c.payload.kind === "summary").at(-1)
  const summaryThrough = summary?.payload.kind === "summary" ? summary.payload.throughSeq : -1

  const messages: Message[] = []
  const seqs: number[] = []
  const push = (message: Message, seq: number) => {
    messages.push(message)
    seqs.push(seq)
  }
  if (summary?.payload.kind === "summary") push({ role: "user", text: `${SUMMARY_OPEN}\n${summary.payload.summary}\n${SUMMARY_CLOSE}` }, summary.seq)

  let pending: Array<{ id: string; name: string; seq: number }> = []
  const closePending = () => {
    for (const call of pending) push({ role: "tool", callId: call.id, name: call.name, content: INTERRUPTED, isError: true }, call.seq)
    pending = []
  }
  let subagentDepth = 0
  for (const event of events) {
    if (event.type === "subagent/start") subagentDepth++
    else if (event.type === "subagent/end") subagentDepth--
    if (subagentDepth > 0 || event.seq <= summaryThrough) continue
    switch (event.type) {
      case "user/message":
      case "reminder/added":
        closePending()
        push({ role: "user", text: event.payload.text }, event.seq)
        break
      case "assistant/message":
        closePending()
        push(event.payload.message, event.seq)
        pending = event.payload.message.toolCalls.map((c) => ({ id: c.id, name: c.name, seq: event.seq }))
        break
      case "tool/result": {
        const p = event.payload
        const content = pruned.has(p.callId) ? prunedPlaceholder(p.name, p.evidenceId) : p.content
        push({ role: "tool", callId: p.callId, name: p.name, content, isError: p.isError }, event.seq)
        pending = pending.filter((c) => c.id !== p.callId)
        break
      }
    }
  }
  closePending()
  return { messages, seqs }
}
