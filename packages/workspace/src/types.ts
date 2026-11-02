// The Operations interface: everything tools may do on a machine. Local now, SSH in M2.

export interface WorkspaceInfo {
  /** e.g. "Windows 11 (win32 x64)" or "Ubuntu 24.04". */
  os: string
  shell: "bash" | "powershell" | "sh"
}

export interface FileStat {
  exists: boolean
  isFile: boolean
  isDirectory: boolean
  size: number
  mtimeMs: number
}

export interface ExecOptions {
  /** Absolute directory; defaults to the workspace root. */
  cwd?: string
  timeoutMs?: number
  signal?: AbortSignal
  onOutput?(chunk: string): void
}

export interface ExecResult {
  exitCode: number
  /** stdout and stderr interleaved as produced. */
  output: string
  timedOut: boolean
  aborted: boolean
  durationMs: number
}

export interface GrepOptions {
  /** Absolute file or directory to search. */
  path: string
  glob?: string
  ignoreCase?: boolean
  limit: number
}

export interface GrepMatch {
  /** Path relative to the workspace root, with forward slashes. */
  file: string
  line: number
  text: string
}

export interface Operations {
  /** Absolute workspace root in the machine's own path style. */
  readonly root: string
  info(): Promise<WorkspaceInfo>
  /** Resolve a model-supplied path (relative to the root, or absolute). */
  resolve(path: string): string
  /** Path relative to the root with forward slashes, or the absolute path when outside the root. */
  display(absolutePath: string): string
  isInside(absolutePath: string): boolean
  readFile(absolutePath: string): Promise<Buffer>
  /** Write a file, creating parent directories. */
  writeFile(absolutePath: string, content: string | Buffer): Promise<void>
  stat(absolutePath: string): Promise<FileStat>
  listDir(absolutePath: string): Promise<Array<{ name: string; isDirectory: boolean }>>
  exec(command: string, options?: ExecOptions): Promise<ExecResult>
  /** Files matching a glob under `cwd`, relative to the root, newest first. */
  glob(pattern: string, cwd: string, limit: number): Promise<string[]>
  grep(pattern: string, options: GrepOptions): Promise<GrepMatch[]>
}
