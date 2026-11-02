// The `trail` command: run tasks, keep chatting in a session, list, inspect and report.

import { existsSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { createInterface, type Interface } from "node:readline"
import {
  configPath,
  createSession,
  databasePath,
  keychainSecrets,
  loadConfig,
  operationsFactory,
  openSession,
  openStore,
  pickModel,
  type ApprovalRequest,
  type EventStore,
  type Session,
  type SessionDeps,
  type TurnResult,
} from "@trail-agent/core"
import { formatUsage, requests, timeline, usageTotals } from "@trail-agent/inspector"
import { createProvider } from "@trail-agent/llm"
import { eventsOfType, type PermissionDecision, type PermissionLevel } from "@trail-agent/protocol"
import { bold, createRenderer, cyan, dim, green, red, yellow } from "./ui.ts"
import { describeWorkspaces, resolveSessionWorkspaces, workspaceCommand } from "./workspaces.ts"

const HELP = `trail — a coding agent that proves its work

Usage
  trail [options] [task]        run a task in the current directory (interactive when no task is given)
  trail resume <session> [task] continue a session
  trail sessions                list recent sessions
  trail report <session>        show the completion report(s)
  trail inspect <session>       timeline, tokens and cost
  trail inspect <session> --request <n>   print the exact body of request n
  trail models                  list configured models
  trail ws                      list saved workspaces
  trail ws add-ssh [name] [user@host] [/remote/path]   save a server (asks for the password, checks the host key)
  trail ws add-local <name> <path>                     save a local directory
  trail ws test <name> | trail ws remove <name>

Options
  -w, --workspace <dir>   workspace directory (default: current directory)
  -m, --model <id>        model id from the config
  --yes                   full permission: run edits and commands without asking
  --read-only             read-only local workspace
  -W, --with <alias=name[:level]>   attach a saved workspace, e.g. -W staging=web1:full -W prod=web2
                          levels: full, ask-write, read-only, ask-all (prod-like names default to read-only)
  --primary <alias>       workspace tools use by default (default: local)
  --no-local              do not attach the current directory
  --max-steps <n>         stop after n model requests per turn (default 100)

Models come from ${"$"}TRAIL_HOME/config.json (default ~/.trail/config.json), ANTHROPIC_API_KEY,
or TRAIL_BASE_URL + TRAIL_MODEL + TRAIL_API_KEY for any OpenAI-compatible endpoint.

Interactive commands: /report  /inspect  /usage  /exit
While the agent works, type a message and press Enter to add it to the running task.`

interface Args {
  command: string
  positional: string[]
  workspace?: string
  model?: string
  yes: boolean
  readOnly: boolean
  maxSteps?: number
  request?: number
  with: string[]
  primary?: string
  noLocal: boolean
  port?: number
  key?: string
  desc?: string
  trust?: string
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: "run", positional: [], yes: false, readOnly: false, with: [], noLocal: false }
  const commands = new Set(["resume", "sessions", "report", "inspect", "models", "help", "ws"])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const value = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} needs a value`)
      return v
    }
    if (a === "-w" || a === "--workspace") args.workspace = value()
    else if (a === "-m" || a === "--model") args.model = value()
    else if (a === "--yes" || a === "-y") args.yes = true
    else if (a === "--read-only") args.readOnly = true
    else if (a === "--max-steps") args.maxSteps = Number(value())
    else if (a === "--request") args.request = Number(value())
    else if (a === "-W" || a === "--with") args.with.push(value())
    else if (a === "--primary") args.primary = value()
    else if (a === "--no-local") args.noLocal = true
    else if (a === "--port") args.port = Number(value())
    else if (a === "--key") args.key = value()
    else if (a === "--desc") args.desc = value()
    else if (a === "--trust") args.trust = value()
    else if (a === "-h" || a === "--help") args.command = "help"
    else if (args.positional.length === 0 && args.command === "run" && commands.has(a)) args.command = a
    else args.positional.push(a)
  }
  return args
}

export async function runCli(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  if (args.command === "help") {
    console.log(HELP)
    return 0
  }
  if (args.command === "ws") return workspaceCommand(args.positional.shift(), args.positional, args)
  if (args.command === "models") {
    const config = loadConfig()
    if (config.models.length === 0) console.log(`No models. See \`trail help\`; config file: ${configPath()}`)
    for (const m of config.models) console.log(`${m.id === (config.defaultModel ?? config.models[0]?.id) ? "*" : " "} ${m.id}  ${m.protocol}  ${m.model}  ${m.baseUrl}`)
    return 0
  }
  const store = openStore(process.env.TRAIL_DB ?? databasePath())
  try {
    switch (args.command) {
      case "sessions":
        return listSessions(store)
      case "report":
        return showReports(store, needSession(args))
      case "inspect":
        return inspect(store, needSession(args), args.request)
      default:
        return await runSession(store, args)
    }
  } finally {
    store.close()
  }
}

function needSession(args: Args): string {
  const id = args.positional[0]
  if (!id) throw new Error(`${args.command} needs a session id (see \`trail sessions\`)`)
  return id
}

function listSessions(store: EventStore): number {
  for (const s of store.listSessions(20)) {
    const events = store.events(s.id)
    const t = usageTotals(events)
    const ends = eventsOfType(events, "turn/end").map((e) => e.payload.reason)
    console.log(`${cyan(s.id.slice(0, 8))}  ${new Date(s.createdAt).toLocaleString()}  ${bold(s.title)}`)
    console.log(dim(`          ${s.model} · ${s.workspaces.map((w) => w.alias).join(", ")} · ${ends.at(-1) ?? "no turns"} · $${t.cost.toFixed(4)}`))
  }
  return 0
}

function showReports(store: EventStore, id: string): number {
  const row = store.findSession(id)
  if (!row) throw new Error(`No session ${id}`)
  const events = store.events(row.id)
  const accepted = eventsOfType(events, "complete/accepted").map((e) => e.payload.callId)
  for (const submitted of eventsOfType(events, "complete/submitted")) {
    const ok = accepted.includes(submitted.payload.callId)
    console.log(`${ok ? green("✔ accepted") : red("✖ rejected")}  ${submitted.payload.summary}`)
    for (const claim of submitted.payload.claims) console.log(`    [${claim.kind}] ${claim.text}  ${dim(claim.evidence.join(", ") || "no evidence")}`)
  }
  return 0
}

function inspect(store: EventStore, id: string, request: number | undefined): number {
  const row = store.findSession(id)
  if (!row) throw new Error(`No session ${id}`)
  const events = store.events(row.id)
  if (request !== undefined) {
    const ref = requests(events).find((r) => r.number === request)
    if (!ref) throw new Error(`Session has ${requests(events).length} requests`)
    console.log(JSON.stringify(JSON.parse(store.getBlob(ref.bodyHash) ?? "null"), null, 2))
    return 0
  }
  console.log(`${bold(row.title)}  ${dim(row.id)}`)
  for (const line of timeline(events)) console.log(line)
  console.log(`\n${formatUsage(usageTotals(events))}`)
  return 0
}

async function runSession(store: EventStore, args: Args): Promise<number> {
  const config = loadConfig()
  const interactive = process.stdin.isTTY === true
  const renderer = createRenderer()
  let rl: Interface | undefined
  let pendingAnswer: ((line: string) => void) | undefined
  let busy = false
  let controller: AbortController | undefined
  let session: Session | undefined

  const approve = async (request: ApprovalRequest): Promise<PermissionDecision> => {
    renderer.newline()
    if (!rl) {
      console.log(yellow(`  denied (no terminal to ask): ${request.tool} ${request.summary}`))
      return "deny"
    }
    process.stdout.write(yellow(`? ${request.tool} ${bold(request.summary)} in ${request.workspace} — ${request.reason}\n  [y]es  [a]lways in this session  [n]o: `))
    const answer = (await new Promise<string>((r) => (pendingAnswer = r))).trim().toLowerCase()
    return answer === "a" ? "allow_session" : answer === "y" || answer === "yes" || answer === "" ? "allow" : "deny"
  }

  const resumeId = args.command === "resume" ? args.positional.shift() : undefined
  const row = resumeId ? store.findSession(resumeId) : undefined
  if (resumeId && !row) throw new Error(`No session ${resumeId}`)
  const modelConfig = pickModel(config, args.model ?? row?.model)
  const deps: SessionDeps = {
    store,
    provider: createProvider(modelConfig),
    approve,
    maxSteps: args.maxSteps ?? config.maxSteps,
    onEvent: (e) => renderer.event(e),
    onStream: (e) => renderer.stream(e),
    operations: operationsFactory(keychainSecrets()),
  }

  const startTurn = async (text: string): Promise<TurnResult> => {
    if (!session) {
      const path = resolve(args.workspace ?? process.cwd())
      if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`Not a directory: ${path}`)
      const localLevel: PermissionLevel = args.readOnly ? "read-only" : args.yes ? "full" : "ask-write"
      const workspaces = resolveSessionWorkspaces(args.with, path, { noLocal: args.noLocal, localLevel })
      const primary = args.primary ?? workspaces[0]!.alias
      if (!workspaces.some((w) => w.alias === primary)) throw new Error(`--primary ${primary} is not one of: ${workspaces.map((w) => w.alias).join(", ")}`)
      session = await createSession(deps, { title: text.replace(/\s+/g, " ").slice(0, 60), primary, workspaces })
      console.log(dim(`session ${session.id.slice(0, 8)} · ${modelConfig.id} (${modelConfig.model}) · primary ${primary} · `) + describeWorkspaces(workspaces))
    }
    busy = true
    controller = new AbortController()
    try {
      const result = await session.send(text, controller.signal)
      renderer.newline()
      printTurnEnd(result, session)
      return result
    } finally {
      busy = false
    }
  }

  if (row) {
    session = await openSession(deps, row.id)
    console.log(dim(`resumed ${row.id.slice(0, 8)} · ${row.title}`))
  }

  const task = args.positional.join(" ").trim()
  if (interactive) {
    rl = createInterface({ input: process.stdin, output: process.stdout, prompt: cyan("trail› ") })
    rl.on("SIGINT", () => {
      if (busy && controller) {
        controller.abort()
        console.log(yellow("\n  interrupting…"))
      } else rl?.close()
    })
  }

  if (task) {
    const result = await startTurn(task).finally(() => session?.close())
    rl?.close()
    return result.reason === "completed" || result.reason === "no_tool_calls" ? 0 : 1
  }
  if (!rl) throw new Error("No task given and stdin is not a terminal. Usage: trail \"<task>\"")

  console.log(dim("Describe a task. /exit to quit."))
  rl.prompt()
  return await new Promise<number>((resolveExit) => {
    rl!.on("close", () => {
      session?.close()
      resolveExit(0)
    })
    rl!.on("line", (line) => {
      if (pendingAnswer) {
        const answer = pendingAnswer
        pendingAnswer = undefined
        answer(line)
        return
      }
      const text = line.trim()
      if (busy) {
        if (text && session) {
          session.steer(text)
          console.log(dim("  (added to the running task)"))
        }
        return
      }
      if (!text) return rl!.prompt()
      if (text === "/exit" || text === "/quit") return rl!.close()
      if (text === "/report" || text === "/inspect" || text === "/usage") {
        if (!session) console.log(dim("No session yet."))
        else if (text === "/report") showReports(store, session.id)
        else if (text === "/inspect") inspect(store, session.id, undefined)
        else console.log(formatUsage(usageTotals(session.events())))
        return rl!.prompt()
      }
      startTurn(text)
        .catch((error: unknown) => console.log(red(String(error instanceof Error ? error.message : error))))
        .finally(() => rl!.prompt())
    })
  })
}

function printTurnEnd(result: TurnResult, session: Session): void {
  if (result.report) console.log(`\n${result.report.split("\n").map((l, i) => (i === 0 ? bold(l) : l)).join("\n")}`)
  if (result.reason === "error") console.log(red(`turn failed: ${result.error ?? "unknown error"}`))
  else if (result.reason === "max_steps") console.log(yellow("stopped: reached the step limit"))
  else if (result.reason === "aborted") console.log(yellow("interrupted"))
  console.log(dim(formatUsage(usageTotals(session.events()))))
}
