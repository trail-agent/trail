// Terminal rendering: colors, streamed text, tool calls and results.

import type { LlmEvent } from "@trail-agent/llm"
import type { TrailEvent } from "@trail-agent/protocol"
import { builtinTools } from "@trail-agent/tools"

const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code: string) => (text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text)
export const dim = paint("2")
export const bold = paint("1")
export const red = paint("31")
export const green = paint("32")
export const yellow = paint("33")
export const cyan = paint("36")

const describers = new Map(builtinTools.map((t) => [t.spec.name, t.describe]))
const RESULT_PREVIEW_LINES = 4

export interface Renderer {
  stream(event: LlmEvent): void
  event(event: TrailEvent): void
  toolOutput(chunk: string): void
  /** Make sure the next write starts on a fresh line. */
  newline(): void
}

export function createRenderer(write: (text: string) => void = (t) => process.stdout.write(t)): Renderer {
  let atLineStart = true
  let mode: "text" | "thinking" | "other" = "other"
  const out = (text: string) => {
    if (!text) return
    write(text)
    atLineStart = text.endsWith("\n")
  }
  const newline = () => {
    if (!atLineStart) out("\n")
  }
  return {
    newline,
    stream(event) {
      if (event.type === "text_delta") {
        if (mode !== "text") newline()
        mode = "text"
        out(event.text)
      } else if (event.type === "thinking_delta") {
        if (mode !== "thinking") {
          newline()
          out(dim("✻ "))
        }
        mode = "thinking"
        out(dim(event.text))
      }
    },
    toolOutput(chunk) {
      out(dim(chunk))
    },
    event(event) {
      switch (event.type) {
        case "tool/call": {
          mode = "other"
          newline()
          const args = (event.payload.args ?? {}) as Record<string, unknown>
          const describe = describers.get(event.payload.name)
          const special: Record<string, unknown> = { complete: args.summary, task: args.description }
          const described = event.payload.name in special ? String(special[event.payload.name] ?? "") : describe ? describe(args) : JSON.stringify(args)
          const summary = described.startsWith(`${event.payload.name} `) ? described.slice(event.payload.name.length + 1) : described
          const where = typeof args.workspace === "string" ? dim(` @${args.workspace}`) : ""
          out(`${cyan("●")} ${bold(event.payload.name)} ${summary}${where}\n`)
          break
        }
        case "tool/result": {
          if (event.payload.name === "complete") break
          newline()
          const lines = event.payload.content.split("\n")
          const evidence = lines.at(-1)?.startsWith("[evidence:") ? lines.pop() : undefined
          while (lines.length > 1 && lines[0]!.trim() === "") lines.shift()
          const shown = lines.slice(0, RESULT_PREVIEW_LINES).map((l) => `  ${l.slice(0, 160)}`).join("\n")
          const more = lines.length > RESULT_PREVIEW_LINES ? dim(`\n  … ${lines.length - RESULT_PREVIEW_LINES} more lines`) : ""
          out(`${event.payload.isError ? red(shown) : dim(shown)}${more}\n`)
          if (evidence) out(`  ${green(evidence)}\n`)
          break
        }
        case "complete/rejected":
          newline()
          out(yellow("  completion rejected:\n"))
          for (const problem of event.payload.problems) out(yellow(`    ✖ ${problem}\n`))
          break
        case "reminder/added":
          newline()
          out(dim("  (reminded the agent to prove its work)\n"))
          break
        case "compaction/applied":
          newline()
          out(dim(event.payload.kind === "prune" ? `  (context: removed ${event.payload.callIds.length} old tool outputs)\n` : `  (context: summarized earlier history, ${event.payload.trigger})\n`))
          break
        case "subagent/start":
          newline()
          out(`${cyan("◆")} ${bold("subagent")} ${event.payload.description}\n`)
          break
        case "subagent/end":
          newline()
          out(dim(`  subagent finished (${event.payload.reason})\n`))
          break
        case "llm/response":
          mode = "other"
          if (event.payload.error) {
            newline()
            out(red(`  model error: ${event.payload.error}\n`))
          }
          break
      }
    },
  }
}
