import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { config } from './config.js'

export type ServerStatus = 'running' | 'stopped'

// Mirrors the renderer's ServerRecord one-to-one so the client type is unchanged.
export interface ServerRow {
  id: string
  pid: number
  port: number
  exePath: string
  map: string
  mapLabel: string
  modeName: string
  gameType: string
  gameMode: string
  launchedAt: number
  stoppedAt: number | null
  status: ServerStatus
}

export interface UserRow {
  id: number
  username: string
  password_hash: string
  created_at: number
}

// Ensure the parent directory of the SQLite file exists before opening.
mkdirSync(dirname(config.dbPath), { recursive: true })

// node:sqlite (Node >= 22.5) — no native build step, unlike better-sqlite3.
export const db = new DatabaseSync(config.dbPath)
db.exec('PRAGMA journal_mode = WAL;')
db.exec('PRAGMA foreign_keys = ON;')

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS servers (
    id         TEXT PRIMARY KEY,
    pid        INTEGER NOT NULL,
    port       INTEGER NOT NULL,
    exePath    TEXT NOT NULL,
    map        TEXT NOT NULL,
    mapLabel   TEXT NOT NULL,
    modeName   TEXT NOT NULL,
    gameType   TEXT NOT NULL,
    gameMode   TEXT NOT NULL,
    launchedAt INTEGER NOT NULL,
    stoppedAt  INTEGER,
    status     TEXT NOT NULL CHECK (status IN ('running', 'stopped'))
  );

  CREATE INDEX IF NOT EXISTS idx_servers_status ON servers(status);
`)

// --- User statements ---
const insertUserStmt = db.prepare(
  `INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)`
)
const findUserStmt = db.prepare(`SELECT * FROM users WHERE username = ?`)
const countUsersStmt = db.prepare(`SELECT COUNT(*) AS n FROM users`)

export function createUser(username: string, passwordHash: string): void {
  insertUserStmt.run(username, passwordHash, Date.now())
}

export function findUserByUsername(username: string): UserRow | undefined {
  return findUserStmt.get(username) as UserRow | undefined
}

export function countUsers(): number {
  return (countUsersStmt.get() as { n: number }).n
}

// --- Server statements ---
const insertServerStmt = db.prepare(`
  INSERT INTO servers
    (id, pid, port, exePath, map, mapLabel, modeName, gameType, gameMode, launchedAt, stoppedAt, status)
  VALUES
    (@id, @pid, @port, @exePath, @map, @mapLabel, @modeName, @gameType, @gameMode, @launchedAt, @stoppedAt, @status)
`)
const listServersStmt = db.prepare(`SELECT * FROM servers ORDER BY launchedAt DESC`)
const getServerStmt = db.prepare(`SELECT * FROM servers WHERE id = ?`)
const markStoppedStmt = db.prepare(
  `UPDATE servers SET status = 'stopped', stoppedAt = ? WHERE id = ?`
)
const listRunningStmt = db.prepare(`SELECT * FROM servers WHERE status = 'running'`)
const deleteStoppedStmt = db.prepare(`DELETE FROM servers WHERE status = 'stopped'`)

export function insertServer(row: ServerRow): void {
  // node:sqlite binds named params from a plain object (bare names allowed by default).
  insertServerStmt.run(row as unknown as Record<string, SQLInputValue>)
}

export function listServers(): ServerRow[] {
  return listServersStmt.all() as unknown as ServerRow[]
}

export function getServer(id: string): ServerRow | undefined {
  return getServerStmt.get(id) as ServerRow | undefined
}

export function listRunningServers(): ServerRow[] {
  return listRunningStmt.all() as unknown as ServerRow[]
}

export function markServerStopped(id: string, stoppedAt: number): void {
  markStoppedStmt.run(stoppedAt, id)
}

export function deleteStoppedServers(): void {
  deleteStoppedStmt.run()
}
