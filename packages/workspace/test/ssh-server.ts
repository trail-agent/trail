// In-process SSH server for tests: password auth, exec through the local bash, SFTP mapped onto local files.

import { spawn } from "node:child_process"
import { closeSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, statSync, writeSync, type Stats } from "node:fs"
import type { AddressInfo } from "node:net"
import ssh2, { type Connection } from "ssh2"

const { Server, utils } = ssh2
import { detectShell } from "../src/index.ts"

const STATUS = { OK: 0, EOF: 1, NO_SUCH_FILE: 2, FAILURE: 4 }

export interface TestServer {
  port: number
  user: string
  password: string
  /** Convert a native path to the POSIX path the server's shell and SFTP use. */
  posixPath(nativePath: string): string
  close(): Promise<void>
}

const toPosix = (p: string) => (process.platform === "win32" ? p.replace(/^([A-Za-z]):\\/, (_, d: string) => `/${d.toLowerCase()}/`).replace(/\\/g, "/") : p)
const toNative = (p: string) => (process.platform === "win32" ? p.replace(/^\/([a-z])\//, (_, d: string) => `${d.toUpperCase()}:\\`).replace(/\//g, "\\") : p)

const attrsOf = (s: Stats) => ({ mode: s.mode, uid: 0, gid: 0, size: s.size, atime: Math.floor(s.atimeMs / 1000), mtime: Math.floor(s.mtimeMs / 1000) })

export async function startTestServer(): Promise<TestServer> {
  const keys = utils.generateKeyPairSync("ed25519")
  const user = "trail"
  const password = "s3cret"
  const connections = new Set<Connection>()
  const server = new Server({ hostKeys: [keys.private] }, (client: Connection) => {
    connections.add(client)
    client.on("close", () => connections.delete(client))
    // Host-key scans and rejected keys end the handshake early; that is expected here.
    client.on("error", () => {})
    client.on("authentication", (ctx) => {
      if (ctx.method === "password" && ctx.username === user && ctx.password === password) ctx.accept()
      else ctx.reject(["password"])
    })
    client.on("ready", () => {
      client.on("session", (acceptSession) => {
        const session = acceptSession()
        session.on("exec", (accept, _reject, info) => {
          const stream = accept()
          const shell = detectShell()
          const child = spawn(shell.path, ["-c", info.command], { windowsHide: true })
          child.stdout.on("data", (d: Buffer) => stream.write(d))
          child.stderr.on("data", (d: Buffer) => stream.stderr.write(d))
          child.on("close", (code) => {
            stream.exit(code ?? 1)
            stream.end()
          })
          stream.on("close", () => child.kill())
        })
        session.on("sftp", (acceptSftp) => {
          const sftp = acceptSftp()
          const handles = new Map<number, { fd?: number; dir?: string; listed?: boolean }>()
          let next = 0
          const newHandle = (entry: { fd?: number; dir?: string }) => {
            const id = next++
            handles.set(id, entry)
            const buf = Buffer.alloc(4)
            buf.writeUInt32BE(id)
            return buf
          }
          const get = (handle: Buffer) => handles.get(handle.readUInt32BE(0))
          sftp.on("OPEN", (reqid, filename, flags) => {
            try {
              const mode = utils.sftp.flagsToString(flags) ?? "r"
              sftp.handle(reqid, newHandle({ fd: openSync(toNative(filename), mode) }))
            } catch {
              sftp.status(reqid, STATUS.NO_SUCH_FILE)
            }
          })
          sftp.on("READ", (reqid, handle, offset, length) => {
            const entry = get(handle)
            if (entry?.fd === undefined) return sftp.status(reqid, STATUS.FAILURE)
            const buf = Buffer.alloc(length)
            const bytes = readSync(entry.fd, buf, 0, length, offset)
            if (bytes === 0) sftp.status(reqid, STATUS.EOF)
            else sftp.data(reqid, buf.subarray(0, bytes))
          })
          sftp.on("WRITE", (reqid, handle, offset, data) => {
            const entry = get(handle)
            if (entry?.fd === undefined) return sftp.status(reqid, STATUS.FAILURE)
            writeSync(entry.fd, data, 0, data.length, offset)
            sftp.status(reqid, STATUS.OK)
          })
          sftp.on("FSTAT", (reqid, handle) => {
            const entry = get(handle)
            if (entry?.fd === undefined) return sftp.status(reqid, STATUS.FAILURE)
            sftp.attrs(reqid, attrsOf(fstatSync(entry.fd)))
          })
          sftp.on("CLOSE", (reqid, handle) => {
            const id = handle.readUInt32BE(0)
            const entry = handles.get(id)
            if (entry?.fd !== undefined) closeSync(entry.fd)
            handles.delete(id)
            sftp.status(reqid, STATUS.OK)
          })
          const statHandler = (reqid: number, path: string) => {
            try {
              sftp.attrs(reqid, attrsOf(statSync(toNative(path))))
            } catch {
              sftp.status(reqid, STATUS.NO_SUCH_FILE)
            }
          }
          sftp.on("STAT", statHandler)
          sftp.on("LSTAT", statHandler)
          sftp.on("REALPATH", (reqid, path) => sftp.name(reqid, [{ filename: path, longname: path, attrs: {} as never }]))
          sftp.on("MKDIR", (reqid, path) => {
            try {
              mkdirSync(toNative(path))
              sftp.status(reqid, STATUS.OK)
            } catch {
              sftp.status(reqid, STATUS.FAILURE)
            }
          })
          sftp.on("OPENDIR", (reqid, path) => {
            try {
              if (!statSync(toNative(path)).isDirectory()) throw new Error("not a directory")
              sftp.handle(reqid, newHandle({ dir: path }))
            } catch {
              sftp.status(reqid, STATUS.NO_SUCH_FILE)
            }
          })
          sftp.on("READDIR", (reqid, handle) => {
            const entry = get(handle)
            if (!entry?.dir || entry.listed) return sftp.status(reqid, STATUS.EOF)
            entry.listed = true
            const names = readdirSync(toNative(entry.dir)).map((name) => {
              const s = statSync(toNative(`${entry.dir}/${name}`))
              return { filename: name, longname: name, attrs: attrsOf(s) }
            })
            sftp.name(reqid, names)
          })
        })
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    port: (server.address() as AddressInfo).port,
    user,
    password,
    posixPath: toPosix,
    // Drop open client connections too, so a failed test cannot keep the process alive.
    close: () =>
      new Promise((resolve) => {
        for (const client of connections) client.end()
        server.close(() => resolve())
      }),
  }
}
