// `trail ws ...`: save local and SSH workspaces, test them, and resolve -W options for a run.

import { randomUUID } from "node:crypto"
import { existsSync, statSync } from "node:fs"
import { basename, resolve } from "node:path"
import {
  defaultPermission,
  findWorkspace,
  keychainSecrets,
  loadWorkspaces,
  operationsFactory,
  saveWorkspaces,
  sshSecretKey,
  storeSshSecrets,
  type SavedWorkspace,
} from "@trail-agent/core"
import type { PermissionLevel, SessionWorkspace } from "@trail-agent/protocol"
import { createSshOperations, scanHostKey, type SshSecrets, type SshTarget } from "@trail-agent/workspace"
import { ask, askHidden, confirm } from "./prompt.ts"
import { bold, cyan, dim, green, yellow } from "./ui.ts"

const LEVELS: PermissionLevel[] = ["full", "ask-write", "read-only", "ask-all"]

export interface WsOptions {
  port?: number
  key?: string
  desc?: string
  trust?: string
}

export async function workspaceCommand(sub: string | undefined, positional: string[], options: WsOptions): Promise<number> {
  switch (sub ?? "list") {
    case "list":
      return list()
    case "add-local":
      return addLocal(positional, options)
    case "add-ssh":
      return addSsh(positional, options)
    case "test":
      return test(required(positional[0], "workspace name"))
    case "remove":
      return remove(required(positional[0], "workspace name"))
    default:
      throw new Error(`Unknown ws command "${sub}". Use list, add-local, add-ssh, test or remove.`)
  }
}

function required(value: string | undefined, what: string): string {
  if (!value) throw new Error(`Missing ${what}`)
  return value
}

function list(): number {
  const saved = loadWorkspaces()
  if (saved.length === 0) console.log(dim("No saved workspaces. Add one with `trail ws add-ssh` or `trail ws add-local <name> <path>`."))
  for (const w of saved) {
    const where = w.kind === "local" ? w.path : `${w.ssh.username}@${w.ssh.host}:${w.ssh.port}${w.path}`
    console.log(`${bold(w.name)}  ${dim(w.kind)}  ${where}  ${dim(`default ${defaultPermission(w)}`)}${w.description ? `  ${dim(w.description)}` : ""}`)
  }
  return 0
}

function addLocal(positional: string[], options: WsOptions): number {
  const name = required(positional[0], "name")
  const path = resolve(required(positional[1], "path"))
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`Not a directory: ${path}`)
  upsert({ id: randomUUID(), name, kind: "local", path, description: options.desc })
  console.log(green(`Saved local workspace ${name} → ${path}`))
  return 0
}

/** `trail ws add-ssh [name] [user@host] [remote-path]`; anything missing is asked for. Passwords are only ever typed, never passed as flags. */
async function addSsh(positional: string[], options: WsOptions): Promise<number> {
  const name = positional[0] ?? (await ask("Name (e.g. staging)"))
  const login = positional[1] ?? (await ask("Login (user@host)"))
  const [username, host] = login.includes("@") ? (login.split("@") as [string, string]) : [await ask("User", "root"), login]
  const port = options.port ?? Number(await ask("Port", "22"))
  const path = positional[2] ?? (await ask("Remote project path (absolute)", `/home/${username}`))
  if (!path.startsWith("/")) throw new Error("The remote path must be absolute, e.g. /srv/app")
  const auth: SshTarget["auth"] = options.key ? "key" : (await ask("Authentication: password or key", "password")).startsWith("k") ? "key" : "password"
  const keyPath = auth === "key" ? resolve(options.key ?? (await ask("Private key file", "~/.ssh/id_ed25519")).replace(/^~/, process.env.USERPROFILE ?? process.env.HOME ?? "~")) : undefined
  const secrets: SshSecrets = auth === "password" ? { password: await askHidden("Password") } : { passphrase: (await askHidden("Key passphrase (empty if none)")) || undefined }
  const description = options.desc ?? (await ask("Description (optional, e.g. 'test server, safe to deploy')", ""))

  console.log(dim(`Reading the host key of ${host}:${port}…`))
  const fingerprint = await scanHostKey(host, port)
  if (options.trust) {
    if (options.trust !== fingerprint) throw new Error(`Host key mismatch: server presented ${fingerprint}, expected ${options.trust}`)
  } else {
    console.log(`${yellow("Host key fingerprint:")} ${bold(fingerprint)}`)
    console.log(dim("Compare it with the server's own key, e.g. `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server."))
    if (!(await confirm("Trust this host key?"))) {
      console.log("Not saved.")
      return 1
    }
  }

  const target: SshTarget = { host, port, username, auth, keyPath, hostKeyFingerprint: fingerprint }
  const ops = createSshOperations(target, path, async () => secrets)
  try {
    const info = await ops.info()
    const root = await ops.stat(path)
    if (!root.isDirectory) throw new Error(`${path} is not a directory on ${host}`)
    console.log(green(`Connected: ${info.os}, shell ${info.shell}`))
  } finally {
    ops.close()
  }

  const id = findWorkspace(name)?.id ?? randomUUID()
  storeSshSecrets(keychainSecrets(), id, secrets)
  upsert({ id, name, kind: "ssh", path, description: description || undefined, ssh: target })
  console.log(green(`Saved ${name}. Secret stored in the system keychain; default permission ${defaultPermission({ name, description })}.`))
  return 0
}

async function test(name: string): Promise<number> {
  const saved = findWorkspace(name)
  if (!saved) throw new Error(`No workspace ${name}`)
  const ops = operationsFactory(keychainSecrets())({ alias: name, permission: "read-only", workspace: saved })
  try {
    const info = await ops.info()
    console.log(green(`${name}: ${info.os}, shell ${info.shell}, root ${ops.root}`))
    return 0
  } finally {
    ;(ops as { close?(): void }).close?.()
  }
}

function remove(name: string): number {
  const saved = loadWorkspaces()
  const target = saved.find((w) => w.name === name)
  if (!target) throw new Error(`No workspace ${name}`)
  saveWorkspaces(saved.filter((w) => w !== target))
  if (target.kind === "ssh") {
    try {
      keychainSecrets().delete(sshSecretKey(target.id))
    } catch {
      // nothing stored
    }
  }
  console.log(`Removed ${name}`)
  return 0
}

function upsert(workspace: SavedWorkspace): void {
  const saved = loadWorkspaces().filter((w) => w.name !== workspace.name)
  saveWorkspaces([...saved, workspace])
}

/** Turn `-W alias=name[:level]` options plus the current directory into session workspaces. */
export function resolveSessionWorkspaces(specs: string[], cwd: string, options: { noLocal: boolean; localLevel: PermissionLevel }): SessionWorkspace[] {
  const result: SessionWorkspace[] = []
  if (!options.noLocal) {
    result.push({ alias: "local", permission: options.localLevel, workspace: { id: "local", name: basename(cwd), kind: "local", path: cwd } })
  }
  for (const spec of specs) {
    const match = /^(?:([\w-]+)=)?([^:]+)(?::([\w-]+))?$/.exec(spec)
    if (!match) throw new Error(`Bad -W value "${spec}"; use alias=name[:level]`)
    const [, aliasPart, name, level] = match
    const saved = findWorkspace(name!)
    if (!saved) throw new Error(`No saved workspace "${name}". See \`trail ws list\`.`)
    if (level && !LEVELS.includes(level as PermissionLevel)) throw new Error(`Unknown permission "${level}"; use ${LEVELS.join(", ")}`)
    const alias = aliasPart ?? saved.name
    if (result.some((w) => w.alias === alias)) throw new Error(`Workspace alias "${alias}" is used twice`)
    result.push({ alias, permission: (level as PermissionLevel | undefined) ?? defaultPermission(saved), role: saved.description, workspace: saved })
  }
  if (result.length === 0) throw new Error("No workspaces: drop --no-local or add -W")
  return result
}

export const describeWorkspaces = (list: SessionWorkspace[]) => list.map((w) => `${cyan(w.alias)}(${w.permission})`).join(" ")
