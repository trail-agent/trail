// Saved workspaces (~/.trail/workspaces.json) and their secrets in the OS keychain.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Entry } from "@napi-rs/keyring"
import type { PermissionLevel, SessionWorkspace, Workspace } from "@trail-agent/protocol"
import { createLocalOperations, createSshOperations, type Operations, type SshSecrets } from "@trail-agent/workspace"
import { trailHome } from "./config.ts"

export type SavedWorkspace = Workspace & { description?: string }

export const workspacesPath = () => join(trailHome(), "workspaces.json")

export function loadWorkspaces(): SavedWorkspace[] {
  const path = workspacesPath()
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as SavedWorkspace[]) : []
}

export function saveWorkspaces(list: SavedWorkspace[]): void {
  const path = workspacesPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(list, null, 2)}\n`)
}

export function findWorkspace(name: string): SavedWorkspace | undefined {
  return loadWorkspaces().find((w) => w.name === name || w.id === name)
}

/** Production-looking workspaces start read-only; everything else asks before changes. */
export function defaultPermission(workspace: { name: string; description?: string }): PermissionLevel {
  return /\bprod(uction)?\b|生产|线上/i.test(`${workspace.name} ${workspace.description ?? ""}`) ? "read-only" : "ask-write"
}

/** Where secrets live. The keychain implementation is the default; tests use an in-memory one. */
export interface SecretStore {
  get(key: string): string | undefined
  set(key: string, value: string): void
  delete(key: string): void
}

const KEYCHAIN_SERVICE = "trail-agent"

export function keychainSecrets(): SecretStore {
  const entry = (key: string) => new Entry(KEYCHAIN_SERVICE, key)
  return {
    get: (key) => entry(key).getPassword() ?? undefined,
    set: (key, value) => entry(key).setPassword(value),
    delete: (key) => void entry(key).deletePassword(),
  }
}

export const sshSecretKey = (workspaceId: string) => `ssh:${workspaceId}`

export function storeSshSecrets(secrets: SecretStore, workspaceId: string, value: SshSecrets): void {
  secrets.set(sshSecretKey(workspaceId), JSON.stringify(value))
}

/** Operations for any workspace kind; SSH secrets are read from the store only when a connection opens. */
export function operationsFactory(secrets: SecretStore): (workspace: SessionWorkspace) => Operations {
  return ({ workspace }) => {
    if (workspace.kind === "local") return createLocalOperations(workspace.path)
    return createSshOperations(workspace.ssh, workspace.path, async () => {
      const stored = secrets.get(sshSecretKey(workspace.id))
      if (!stored && workspace.ssh.auth === "password") throw new Error(`No saved password for workspace "${workspace.name}"; run \`trail ws add-ssh\` again`)
      return stored ? (JSON.parse(stored) as SshSecrets) : {}
    })
  }
}
