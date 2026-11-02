// Inspector: what the agent sent, what it cost, and what it did, computed from the event log.

import { eventsOfType, type TrailEvent, type Usage } from "@trail-agent/protocol"

export interface UsageTotals extends Usage {
  requests: number
  cost: number
  /** Share of prompt tokens served from cache, 0..1. */
  cacheHitRate: number
  durationMs: number
}

export function usageTotals(events: readonly TrailEvent[]): UsageTotals {
  const totals: UsageTotals = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, cacheHitRate: 0, durationMs: 0 }
  for (const event of eventsOfType(events, "llm/usage")) {
    const u = event.payload.usage
    totals.input += u.input
    totals.output += u.output
    totals.cacheRead += u.cacheRead
    totals.cacheWrite += u.cacheWrite
    totals.cost += event.payload.cost
  }
  for (const event of eventsOfType(events, "llm/response")) totals.durationMs += event.payload.durationMs
  totals.requests = eventsOfType(events, "llm/request").length
  const prompt = totals.input + totals.cacheRead + totals.cacheWrite
  totals.cacheHitRate = prompt > 0 ? totals.cacheRead / prompt : 0
  return totals
}

export interface RequestRef {
  /** 1-based request number within the session. */
  number: number
  seq: number
  bodyHash: string
  bodyBytes: number
  model: string
}

export function requests(events: readonly TrailEvent[]): RequestRef[] {
  return eventsOfType(events, "llm/request").map((e, i) => ({
    number: i + 1,
    seq: e.seq,
    bodyHash: e.payload.bodyHash,
    bodyBytes: e.payload.bodyBytes,
    model: e.payload.model,
  }))
}

const n = (value: number) => value.toLocaleString("en-US")
const pct = (value: number) => `${Math.round(value * 100)}%`
const oneLine = (text: string, max = 80) => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export function formatUsage(t: UsageTotals): string {
  return `${t.requests} requests · in ${n(t.input + t.cacheRead + t.cacheWrite)} (cache ${pct(t.cacheHitRate)}) · out ${n(t.output)} · $${t.cost.toFixed(4)} · ${(t.durationMs / 1000).toFixed(1)}s model time`
}

/** One line per notable event, grouped by turn. */
export function timeline(events: readonly TrailEvent[]): string[] {
  const lines: string[] = []
  let request = 0
  const toolNames = new Map<string, string>()
  for (const event of events) {
    switch (event.type) {
      case "turn/start":
        lines.push("")
        break
      case "user/message":
        lines.push(`#${event.seq} user: ${oneLine(event.payload.text)}`)
        break
      case "reminder/added":
        lines.push(`#${event.seq} reminder: ${oneLine(event.payload.text)}`)
        break
      case "llm/request":
        request++
        lines.push(`#${event.seq} request ${request} → ${event.payload.model} (${n(event.payload.bodyBytes)} bytes)${event.payload.purpose ? ` [${event.payload.purpose}]` : ""}`)
        break
      case "compaction/applied":
        lines.push(
          event.payload.kind === "prune"
            ? `#${event.seq} context pruned: ${event.payload.callIds.length} old tool outputs (≈${n(event.payload.tokensBefore)} tokens before)`
            : `#${event.seq} context summarized through #${event.payload.throughSeq} (${event.payload.trigger}, ≈${n(event.payload.tokensBefore)} tokens before)`,
        )
        break
      case "subagent/start":
        lines.push(`#${event.seq} subagent started: ${oneLine(event.payload.description)}`)
        break
      case "subagent/end":
        lines.push(`#${event.seq} subagent finished: ${event.payload.reason}`)
        break
      case "llm/usage": {
        const u = event.payload.usage
        const prompt = u.input + u.cacheRead + u.cacheWrite
        lines.push(`      tokens in ${n(prompt)} (cache read ${n(u.cacheRead)}, write ${n(u.cacheWrite)}) out ${n(u.output)} · $${event.payload.cost.toFixed(4)}`)
        break
      }
      case "llm/response":
        lines.push(`      ${event.payload.stopReason} in ${(event.payload.durationMs / 1000).toFixed(1)}s${event.payload.error ? ` · error: ${oneLine(event.payload.error)}` : ""}`)
        break
      case "assistant/message":
        if (event.payload.message.text) lines.push(`#${event.seq} assistant: ${oneLine(event.payload.message.text)}`)
        break
      case "tool/call":
        toolNames.set(event.payload.callId, event.payload.name)
        lines.push(`#${event.seq} tool ${event.payload.name} ${oneLine(JSON.stringify(event.payload.args), 100)}`)
        break
      case "evidence/recorded": {
        const e = event.payload.evidence
        lines.push(`      evidence ${e.id} (${e.kind}${e.exitCode !== undefined ? `, exit ${e.exitCode}` : ""}${e.path ? `, ${e.path}` : ""})`)
        break
      }
      case "tool/result":
        if (event.payload.isError) lines.push(`      error: ${oneLine(event.payload.content)}`)
        break
      case "permission/asked":
        lines.push(`#${event.seq} permission asked: ${event.payload.tool} in ${event.payload.workspace} (${event.payload.reason})`)
        break
      case "permission/answered":
        lines.push(`      answered: ${event.payload.decision}`)
        break
      case "complete/submitted":
        lines.push(`#${event.seq} complete: ${oneLine(event.payload.summary)} (${event.payload.claims.length} claims)`)
        break
      case "complete/rejected":
        for (const problem of event.payload.problems) lines.push(`      ✖ ${oneLine(problem, 120)}`)
        break
      case "complete/accepted":
        lines.push(`      ✔ accepted${event.payload.warnings.length ? ` with ${event.payload.warnings.length} warning(s)` : ""}`)
        break
      case "turn/end":
        lines.push(`#${event.seq} turn ended: ${event.payload.reason}`)
        break
    }
  }
  return lines
}
