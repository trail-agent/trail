// Append-only event log and content-addressed blobs in SQLite (node:sqlite, no native module to build).

import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { EventOf, EventPayloads, EventType, SessionWorkspace, TrailEvent } from "@trail-agent/protocol"

export interface SessionRow {
  id: string
  createdAt: number
  title: string
  model: string
  primary: string
  workspaces: SessionWorkspace[]
}

export interface EventStore {
  createSession(row: SessionRow): void
  /** Exact id, or a unique prefix of one. */
  findSession(idOrPrefix: string): SessionRow | undefined
  listSessions(limit: number): SessionRow[]
  append<K extends EventType>(sessionId: string, type: K, payload: EventPayloads[K]): EventOf<K>
  /** Sequence number the next appended event will get. */
  nextSeq(sessionId: string): number
  events(sessionId: string): TrailEvent[]
  putBlob(text: string): string
  getBlob(hash: string): string | undefined
  close(): void
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, title TEXT NOT NULL,
  model TEXT NOT NULL, primary_alias TEXT NOT NULL, workspaces TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, at INTEGER NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE TABLE IF NOT EXISTS blobs (hash TEXT PRIMARY KEY, data TEXT NOT NULL);
`

interface SessionRecord {
  id: string
  created_at: number
  title: string
  model: string
  primary_alias: string
  workspaces: string
}

export function openStore(path: string): EventStore {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")
  db.exec(SCHEMA)
  const insertSession = db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)")
  const insertEvent = db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?)")
  const maxSeq = db.prepare("SELECT MAX(seq) AS seq FROM events WHERE session_id = ?")
  const selectEvents = db.prepare("SELECT seq, type, at, payload FROM events WHERE session_id = ? ORDER BY seq")
  const insertBlob = db.prepare("INSERT OR IGNORE INTO blobs VALUES (?, ?)")
  const selectBlob = db.prepare("SELECT data FROM blobs WHERE hash = ?")
  const seqs = new Map<string, number>()

  const toRow = (r: SessionRecord): SessionRow => ({
    id: r.id,
    createdAt: r.created_at,
    title: r.title,
    model: r.model,
    primary: r.primary_alias,
    workspaces: JSON.parse(r.workspaces) as SessionWorkspace[],
  })
  const nextSeq = (sessionId: string) => {
    let seq = seqs.get(sessionId)
    if (seq === undefined) {
      const row = maxSeq.get(sessionId) as { seq: number | null } | undefined
      seq = (row?.seq ?? -1) + 1
      seqs.set(sessionId, seq)
    }
    return seq
  }

  return {
    createSession(row) {
      insertSession.run(row.id, row.createdAt, row.title, row.model, row.primary, JSON.stringify(row.workspaces))
    },
    findSession(idOrPrefix) {
      const rows = db.prepare("SELECT * FROM sessions WHERE id LIKE ? LIMIT 2").all(`${idOrPrefix}%`) as unknown as SessionRecord[]
      return rows.length === 1 ? toRow(rows[0]!) : rows.map(toRow).find((r) => r.id === idOrPrefix)
    },
    listSessions(limit) {
      const rows = db.prepare("SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?").all(limit) as unknown as SessionRecord[]
      return rows.map(toRow)
    },
    append(sessionId, type, payload) {
      const seq = nextSeq(sessionId)
      const at = Date.now()
      insertEvent.run(sessionId, seq, type, at, JSON.stringify(payload))
      seqs.set(sessionId, seq + 1)
      return { sessionId, seq, at, type, payload } as unknown as EventOf<typeof type>
    },
    nextSeq,
    events(sessionId) {
      const rows = selectEvents.all(sessionId) as Array<{ seq: number; type: string; at: number; payload: string }>
      return rows.map((r) => ({ sessionId, seq: r.seq, at: r.at, type: r.type, payload: JSON.parse(r.payload) }) as TrailEvent)
    },
    putBlob(text) {
      const hash = createHash("sha256").update(text).digest("hex")
      insertBlob.run(hash, text)
      return hash
    },
    getBlob(hash) {
      return (selectBlob.get(hash) as { data: string } | undefined)?.data
    },
    close: () => db.close(),
  }
}
