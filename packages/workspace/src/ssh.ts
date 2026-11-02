// Operations on a remote POSIX machine over one long-lived SSH connection (ssh2: files over SFTP, commands over exec).

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { posix } from "node:path"
import ssh2, { type Client as SshClient, type ClientChannel, type ConnectConfig, type SFTPWrapper } from "ssh2"
import { globToRegExp } from "./local.ts"
import type { ExecOptions, ExecResult, FileStat, GrepMatch, Operations, WorkspaceInfo } from "./types.ts"

// ssh2 is CommonJS; its classes are only reachable through the default export.
const { Client } = ssh2

export interface SshTarget {
  host: string
  port: number
  username: string
  auth: "password" | "key"
  keyPath?: string
  /** "SHA256:..." as shown by OpenSSH; connections to any other key are refused. */
  hostKeyFingerprint: string
}

/** Secrets are fetched only when connecting, so they are never stored in configs or events. */
export interface SshSecrets {
  password?: string
  passphrase?: string
}

export interface SshOperations extends Operations {
  close(): void
}

const MAX_CAPTURE = 20 * 1024 * 1024
const EXCLUDED = /(^|\/)(node_modules|\.git)(\/|$)/

/** OpenSSH-style fingerprint of a raw host key. */
export function fingerprintOf(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`
}

/** Read the server's host key fingerprint without logging in, so the user can confirm it. */
export function scanHostKey(host: string, port: number, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    let fingerprint: string | undefined
    const done = () => {
      client.end()
      if (fingerprint) resolve(fingerprint)
    }
    client.on("error", (error) => {
      done()
      if (!fingerprint) reject(error)
    })
    client.on("close", done)
    client.connect({
      host,
      port,
      username: "trail-host-key-scan",
      readyTimeout: timeoutMs,
      hostVerifier: (key: Buffer) => {
        fingerprint = fingerprintOf(key)
        return false
      },
    })
  })
}

/** Quote for POSIX shells. */
export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

interface RemoteFacts extends WorkspaceInfo {
  hasTimeout: boolean
  hasRipgrep: boolean
}

export function createSshOperations(target: SshTarget, root: string, getSecrets: () => Promise<SshSecrets>): SshOperations {
  const absoluteRoot = posix.resolve("/", root)
  let connecting: Promise<SshClient> | undefined
  let sftpSession: Promise<SFTPWrapper> | undefined
  let facts: Promise<RemoteFacts> | undefined
  let current: SshClient | undefined

  const reset = () => {
    connecting = undefined
    sftpSession = undefined
    current = undefined
  }

  const connect = (): Promise<SshClient> => {
    connecting ??= getSecrets().then(
      (secrets) =>
        new Promise<SshClient>((resolve, reject) => {
          const client = new Client()
          let presented: string | undefined
          const config: ConnectConfig = {
            host: target.host,
            port: target.port,
            username: target.username,
            readyTimeout: 20_000,
            keepaliveInterval: 15_000,
            keepaliveCountMax: 3,
            tryKeyboard: target.auth === "password",
            hostVerifier: (key: Buffer) => {
              presented = fingerprintOf(key)
              return presented === target.hostKeyFingerprint
            },
          }
          if (target.auth === "password") config.password = secrets.password
          else {
            if (!target.keyPath) throw new Error("key authentication needs keyPath")
            config.privateKey = readFileSync(target.keyPath)
            if (secrets.passphrase) config.passphrase = secrets.passphrase
          }
          client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => finish(prompts.map(() => secrets.password ?? "")))
          client.on("ready", () => {
            current = client
            resolve(client)
          })
          client.on("error", (error) => {
            reset()
            if (presented && presented !== target.hostKeyFingerprint) {
              reject(new Error(`Host key of ${target.host} changed: expected ${target.hostKeyFingerprint}, server presented ${presented}. Refusing to connect.`))
            } else reject(new Error(`SSH ${target.username}@${target.host}:${target.port}: ${error.message}`))
          })
          client.on("close", () => {
            if (current === client) reset()
          })
          client.connect(config)
        }),
    )
    return connecting
  }

  const sftp = (): Promise<SFTPWrapper> => {
    sftpSession ??= connect().then(
      (client) =>
        new Promise<SFTPWrapper>((resolve, reject) => client.sftp((error, session) => (error ? reject(error) : resolve(session)))),
    )
    sftpSession.catch(() => (sftpSession = undefined))
    return sftpSession
  }

  const run = async (command: string, options: ExecOptions = {}): Promise<ExecResult> => {
    const client = await connect()
    const remote = await getFacts()
    const started = performance.now()
    const inner = `cd ${shellQuote(options.cwd ?? absoluteRoot)} && ${command}`
    const seconds = options.timeoutMs ? Math.ceil(options.timeoutMs / 1000) : undefined
    const shell = remote.shell === "bash" ? "bash" : "sh"
    // `timeout` kills the remote process tree; closing the channel alone may leave it running.
    const wrapped = seconds && remote.hasTimeout ? `timeout -k 5 ${seconds} ${shell} -c ${shellQuote(inner)}` : `${shell} -c ${shellQuote(inner)}`
    return new Promise((resolve) => {
      client.exec(wrapped, (error, channel: ClientChannel) => {
        if (error) {
          resolve({ exitCode: 255, output: error.message, timedOut: false, aborted: false, durationMs: 0 })
          return
        }
        let output = ""
        let timedOut = false
        let aborted = false
        let exitCode: number | undefined
        const onData = (data: Buffer) => {
          const text = data.toString("utf8")
          if (output.length < MAX_CAPTURE) output += text
          options.onOutput?.(text)
        }
        channel.on("data", onData)
        channel.stderr.on("data", onData)
        channel.on("exit", (code: number | null) => {
          exitCode = code ?? 255
        })
        const hardStop = seconds ? setTimeout(() => { timedOut = true; channel.close() }, (seconds + 8) * 1000) : undefined
        const onAbort = () => {
          aborted = true
          channel.close()
        }
        options.signal?.addEventListener("abort", onAbort, { once: true })
        channel.on("close", () => {
          clearTimeout(hardStop)
          options.signal?.removeEventListener("abort", onAbort)
          const code = exitCode ?? 255
          if (seconds && remote.hasTimeout && code === 124) timedOut = true
          resolve({ exitCode: code, output, timedOut, aborted, durationMs: Math.round(performance.now() - started) })
        })
      })
    })
  }

  const getFacts = (): Promise<RemoteFacts> => {
    facts ??= (async () => {
      const client = await connect()
      const probe = [
        `echo "os=$( (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") || uname -s) ($(uname -sm))"`,
        `command -v bash >/dev/null && echo bash=1`,
        `command -v timeout >/dev/null && echo timeout=1`,
        `command -v rg >/dev/null && echo rg=1`,
      ].join("; ")
      const output = await new Promise<string>((resolve, reject) => {
        client.exec(probe, (error, channel) => {
          if (error) return reject(error)
          let text = ""
          channel.on("data", (d: Buffer) => (text += d.toString("utf8")))
          channel.on("close", () => resolve(text))
        })
      })
      const value = (key: string) => new RegExp(`^${key}=(.*)$`, "m").exec(output)?.[1]?.trim()
      return {
        os: value("os") ?? "unknown POSIX",
        shell: value("bash") ? "bash" : "sh",
        hasTimeout: !!value("timeout"),
        hasRipgrep: !!value("rg"),
      }
    })()
    facts.catch(() => (facts = undefined))
    return facts
  }

  const isInside = (absolutePath: string) => {
    const rel = posix.relative(absoluteRoot, absolutePath)
    return rel === "" || (!rel.startsWith("..") && !posix.isAbsolute(rel))
  }
  const toRelative = (absolutePath: string) => posix.relative(absoluteRoot, absolutePath)

  const stat = async (absolutePath: string): Promise<FileStat> => {
    const session = await sftp()
    return new Promise((resolve) =>
      session.stat(absolutePath, (error, stats) => {
        if (error) resolve({ exists: false, isFile: false, isDirectory: false, size: 0, mtimeMs: 0 })
        else resolve({ exists: true, isFile: stats.isFile(), isDirectory: stats.isDirectory(), size: stats.size, mtimeMs: stats.mtime * 1000 })
      }),
    )
  }

  return {
    root: absoluteRoot,
    async info() {
      const { os, shell } = await getFacts()
      return { os: `${os} via ssh ${target.username}@${target.host}`, shell }
    },
    resolve: (path) => posix.resolve(absoluteRoot, path.replace(/\\/g, "/")),
    display: (absolutePath) => (isInside(absolutePath) ? toRelative(absolutePath) || "." : absolutePath),
    isInside,
    async readFile(absolutePath) {
      const session = await sftp()
      return new Promise((resolve, reject) => session.readFile(absolutePath, (error, data) => (error ? reject(error) : resolve(data))))
    },
    async writeFile(absolutePath, content) {
      const parent = posix.dirname(absolutePath)
      if (!(await stat(parent)).isDirectory) {
        const made = await run(`mkdir -p ${shellQuote(parent)}`)
        if (made.exitCode !== 0) throw new Error(`mkdir ${parent}: ${made.output.trim()}`)
      }
      const session = await sftp()
      await new Promise<void>((resolve, reject) => session.writeFile(absolutePath, content, (error) => (error ? reject(error) : resolve())))
    },
    stat,
    async listDir(absolutePath) {
      const session = await sftp()
      const list = await new Promise<Array<{ filename: string; attrs: { mode: number } }>>((resolve, reject) =>
        session.readdir(absolutePath, (error, entries) => (error ? reject(error) : resolve(entries))),
      )
      return list
        .filter((e) => e.filename !== "." && e.filename !== "..")
        .map((e) => ({ name: e.filename, isDirectory: (e.attrs.mode & 0o170000) === 0o040000 }))
        .sort((a, b) => a.name.localeCompare(b.name))
    },
    exec: run,
    async glob(pattern, cwd, limit) {
      const result = await run(
        `find ${shellQuote(cwd)} \\( -name node_modules -o -name .git \\) -prune -o -type f -printf '%T@\\t%p\\n' 2>/dev/null | head -n 50000`,
      )
      const matcher = globToRegExp(pattern)
      return result.output
        .split("\n")
        .map((line) => line.split("\t"))
        .filter((parts): parts is [string, string] => parts.length === 2 && !!parts[1])
        .filter(([, path]) => matcher.test(posix.relative(cwd, path)) && !EXCLUDED.test(posix.relative(cwd, path)))
        .sort(([a], [b]) => Number(b) - Number(a))
        .slice(0, limit)
        .map(([, path]) => toRelative(path))
    },
    async grep(pattern, options) {
      const remote = await getFacts()
      const flags = options.ignoreCase ? "-i " : ""
      const command = remote.hasRipgrep
        ? `rg --line-number --no-heading --color never --max-columns 500 ${flags}${options.glob ? `-g ${shellQuote(options.glob)} ` : ""}-e ${shellQuote(pattern)} ${shellQuote(options.path)}`
        : `grep -rnIE ${flags}${options.glob ? `--include=${shellQuote(options.glob)} ` : ""}--exclude-dir=node_modules --exclude-dir=.git -e ${shellQuote(pattern)} ${shellQuote(options.path)}`
      const result = await run(`${command} 2>/dev/null | head -n ${options.limit}`)
      const matches: GrepMatch[] = []
      for (const line of result.output.split("\n")) {
        const m = /^(.*?):(\d+):(.*)$/.exec(line)
        if (m) matches.push({ file: toRelative(posix.resolve(absoluteRoot, m[1]!)), line: Number(m[2]), text: m[3]!.slice(0, 500) })
      }
      return matches
    },
    close() {
      current?.end()
      reset()
    },
  }
}
