// Workspaces: where tools run. Every workspace exposes the same Operations.

export type { ExecOptions, ExecResult, FileStat, GrepMatch, GrepOptions, Operations, WorkspaceInfo } from "./types.ts"
export { createLocalOperations, globToRegExp } from "./local.ts"
export { createSshOperations, fingerprintOf, scanHostKey, shellQuote, type SshOperations, type SshSecrets, type SshTarget } from "./ssh.ts"
export { detectShell, type ShellChoice } from "./shell.ts"
