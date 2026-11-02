// The model's context is a projection of the event log: everything the model saw is in the log.

import type { Message, TrailEvent } from "@trail-agent/protocol"

const INTERRUPTED = "Not executed: the session was interrupted before this tool ran."

/** Rebuild the conversation from events, closing tool calls an interrupted run left without results. */
export function buildContext(events: readonly TrailEvent[]): Message[] {
  const messages: Message[] = []
  let pending: Array<{ id: string; name: string }> = []
  const closePending = () => {
    for (const call of pending) messages.push({ role: "tool", callId: call.id, name: call.name, content: INTERRUPTED, isError: true })
    pending = []
  }
  for (const event of events) {
    switch (event.type) {
      case "user/message":
        closePending()
        messages.push({ role: "user", text: event.payload.text })
        break
      case "reminder/added":
        closePending()
        messages.push({ role: "user", text: event.payload.text })
        break
      case "assistant/message":
        closePending()
        messages.push(event.payload.message)
        pending = event.payload.message.toolCalls.map((c) => ({ id: c.id, name: c.name }))
        break
      case "tool/result":
        messages.push({ role: "tool", callId: event.payload.callId, name: event.payload.name, content: event.payload.content, isError: event.payload.isError })
        pending = pending.filter((c) => c.id !== event.payload.callId)
        break
    }
  }
  closePending()
  return messages
}
