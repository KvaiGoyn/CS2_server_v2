import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { config } from './config.js'

export type ServerStatus = 'running' | 'stopped'
export type RconCommandStatus = 'pending' | 'executing' | 'completed' | 'failed'

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
  rcon_port?: number
  rcon_password_hash?: string
}

export interface UserRow {
  id: number
  username: string
  password_hash: string
  created_at: number
}

export interface PresetRow {
  id: string
  name: string
  description: string
  gameType: string
  gameMode: string
  map: string
  configContent: string
  createdAt: number
}

export interface MatchConfigRow {
  id: string
  name: string
  description: string
  map: string
  team1_name: string
  team2_name: string
  convars: string
  createdAt: number
}

export interface RconCommandRow {
  id: string
  server_id: string
  command: string
  status: RconCommandStatus
  response?: string
  retry_count: number
  created_at: number
  executed_at?: number
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
    id                    TEXT PRIMARY KEY,
    pid                   INTEGER NOT NULL,
    port                  INTEGER NOT NULL,
    exePath               TEXT NOT NULL,
    map                   TEXT NOT NULL,
    mapLabel              TEXT NOT NULL,
    modeName              TEXT NOT NULL,
    gameType              TEXT NOT NULL,
    gameMode              TEXT NOT NULL,
    launchedAt            INTEGER NOT NULL,
    stoppedAt             INTEGER,
    status                TEXT NOT NULL CHECK (status IN ('running', 'stopped')),
    rcon_port             INTEGER,
    rcon_password_hash    TEXT
  );

  CREATE TABLE IF NOT EXISTS presets (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL UNIQUE,
    description   TEXT NOT NULL DEFAULT '',
    gameType      TEXT NOT NULL,
    gameMode      TEXT NOT NULL,
    map           TEXT NOT NULL,
    configContent TEXT NOT NULL,
    createdAt     INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS match_configs (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL UNIQUE,
    description   TEXT NOT NULL DEFAULT '',
    map           TEXT NOT NULL,
    team1_name    TEXT NOT NULL,
    team2_name    TEXT NOT NULL,
    convars       TEXT NOT NULL,
    createdAt     INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rcon_commands (
    id            TEXT PRIMARY KEY,
    server_id     TEXT NOT NULL,
    command       TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('pending', 'executing', 'completed', 'failed')),
    response      TEXT,
    retry_count   INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    executed_at   INTEGER,
    FOREIGN KEY (server_id) REFERENCES servers(id)
  );

  CREATE INDEX IF NOT EXISTS idx_servers_status ON servers(status);
  CREATE INDEX IF NOT EXISTS idx_presets_name ON presets(name);
  CREATE INDEX IF NOT EXISTS idx_match_configs_name ON match_configs(name);
  CREATE INDEX IF NOT EXISTS idx_rcon_commands_server ON rcon_commands(server_id);
  CREATE INDEX IF NOT EXISTS idx_rcon_commands_status ON rcon_commands(status);
  CREATE INDEX IF NOT EXISTS idx_rcon_commands_created ON rcon_commands(created_at);
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
    (id, pid, port, exePath, map, mapLabel, modeName, gameType, gameMode, launchedAt, stoppedAt, status, rcon_port, rcon_password_hash)
  VALUES
    (@id, @pid, @port, @exePath, @map, @mapLabel, @modeName, @gameType, @gameMode, @launchedAt, @stoppedAt, @status, @rcon_port, @rcon_password_hash)
`)
const listServersStmt = db.prepare(`SELECT * FROM servers ORDER BY launchedAt DESC`)
const getServerStmt = db.prepare(`SELECT * FROM servers WHERE id = ?`)
const markStoppedStmt = db.prepare(
  `UPDATE servers SET status = 'stopped', stoppedAt = ? WHERE id = ?`
)
const listRunningStmt = db.prepare(`SELECT * FROM servers WHERE status = 'running'`)
const deleteStoppedStmt = db.prepare(`DELETE FROM servers WHERE status = 'stopped'`)

export function insertServer(row: ServerRow): void {
  // node:sqlite rejects `undefined` bindings outright, so optional columns
  // need an explicit null when absent (bare param names are bound from object keys).
  insertServerStmt.run({
    ...row,
    rcon_port: row.rcon_port ?? null,
    rcon_password_hash: row.rcon_password_hash ?? null
  } as unknown as Record<string, SQLInputValue>)
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

// --- Preset statements ---
const insertPresetStmt = db.prepare(`
  INSERT INTO presets
    (id, name, description, gameType, gameMode, map, configContent, createdAt)
  VALUES
    (@id, @name, @description, @gameType, @gameMode, @map, @configContent, @createdAt)
`)
const listPresetsStmt = db.prepare(`SELECT * FROM presets ORDER BY createdAt DESC`)
const getPresetStmt = db.prepare(`SELECT * FROM presets WHERE id = ?`)
const updatePresetStmt = db.prepare(`
  UPDATE presets
  SET name = COALESCE(?, name),
      description = COALESCE(?, description),
      gameType = COALESCE(?, gameType),
      gameMode = COALESCE(?, gameMode),
      map = COALESCE(?, map),
      configContent = COALESCE(?, configContent)
  WHERE id = ?
`)
const deletePresetStmt = db.prepare(`DELETE FROM presets WHERE id = ?`)

export function insertPreset(row: PresetRow): void {
  insertPresetStmt.run(row as unknown as Record<string, SQLInputValue>)
}

export function listPresets(): PresetRow[] {
  return listPresetsStmt.all() as unknown as PresetRow[]
}

export function getPreset(id: string): PresetRow | undefined {
  return getPresetStmt.get(id) as PresetRow | undefined
}

export function updatePreset(
  id: string,
  updates: Partial<Omit<PresetRow, 'id' | 'createdAt'>>
): void {
  updatePresetStmt.run(
    updates.name ?? null,
    updates.description ?? null,
    updates.gameType ?? null,
    updates.gameMode ?? null,
    updates.map ?? null,
    updates.configContent ?? null,
    id
  )
}

export function deletePreset(id: string): void {
  deletePresetStmt.run(id)
}

// --- Match Config statements ---
const insertMatchConfigStmt = db.prepare(`
  INSERT INTO match_configs
    (id, name, description, map, team1_name, team2_name, convars, createdAt)
  VALUES
    (@id, @name, @description, @map, @team1_name, @team2_name, @convars, @createdAt)
`)
const listMatchConfigsStmt = db.prepare(`SELECT * FROM match_configs ORDER BY createdAt DESC`)
const getMatchConfigStmt = db.prepare(`SELECT * FROM match_configs WHERE id = ?`)
const updateMatchConfigStmt = db.prepare(`
  UPDATE match_configs
  SET name = COALESCE(?, name),
      description = COALESCE(?, description),
      map = COALESCE(?, map),
      team1_name = COALESCE(?, team1_name),
      team2_name = COALESCE(?, team2_name),
      convars = COALESCE(?, convars)
  WHERE id = ?
`)
const deleteMatchConfigStmt = db.prepare(`DELETE FROM match_configs WHERE id = ?`)

export function insertMatchConfig(row: MatchConfigRow): void {
  insertMatchConfigStmt.run(row as unknown as Record<string, SQLInputValue>)
}

export function listMatchConfigs(): MatchConfigRow[] {
  return listMatchConfigsStmt.all() as unknown as MatchConfigRow[]
}

export function getMatchConfig(id: string): MatchConfigRow | undefined {
  return getMatchConfigStmt.get(id) as MatchConfigRow | undefined
}

export function updateMatchConfig(
  id: string,
  updates: Partial<Omit<MatchConfigRow, 'id' | 'createdAt'>>
): void {
  updateMatchConfigStmt.run(
    updates.name ?? null,
    updates.description ?? null,
    updates.map ?? null,
    updates.team1_name ?? null,
    updates.team2_name ?? null,
    updates.convars ?? null,
    id
  )
}

export function deleteMatchConfig(id: string): void {
  deleteMatchConfigStmt.run(id)
}

// --- RCON Command statements ---
const insertRconCommandStmt = db.prepare(`
  INSERT INTO rcon_commands
    (id, server_id, command, status, response, retry_count, created_at, executed_at)
  VALUES
    (@id, @server_id, @command, @status, @response, @retry_count, @created_at, @executed_at)
`)
const listPendingRconStmt = db.prepare(`
  SELECT * FROM rcon_commands
  WHERE status IN ('pending', 'executing')
  ORDER BY created_at ASC
  LIMIT 100
`)
const getRconCommandStmt = db.prepare(`SELECT * FROM rcon_commands WHERE id = ?`)
const updateRconCommandStmt = db.prepare(`
  UPDATE rcon_commands
  SET status = ?, response = ?, retry_count = ?, executed_at = ?
  WHERE id = ?
`)
const listRconByServerStmt = db.prepare(`
  SELECT * FROM rcon_commands
  WHERE server_id = ?
  ORDER BY created_at DESC
  LIMIT 50
`)

export function insertRconCommand(row: RconCommandRow): void {
  insertRconCommandStmt.run(row as unknown as Record<string, SQLInputValue>)
}

export function listPendingRconCommands(): RconCommandRow[] {
  return listPendingRconStmt.all() as unknown as RconCommandRow[]
}

export function getRconCommand(id: string): RconCommandRow | undefined {
  return getRconCommandStmt.get(id) as RconCommandRow | undefined
}

export function updateRconCommand(
  id: string,
  status: RconCommandStatus,
  response?: string,
  retryCount?: number,
  executedAt?: number
): void {
  updateRconCommandStmt.run(
    status,
    response ?? null,
    retryCount ?? 0,
    executedAt ?? null,
    id
  )
}

export function listRconCommandsByServer(serverId: string): RconCommandRow[] {
  return listRconByServerStmt.all(serverId) as unknown as RconCommandRow[]
}

export async function seedDefaultPresets(): Promise<boolean> {
  const count = (db.prepare('SELECT COUNT(*) AS n FROM presets').get() as { n: number }).n
  if (count > 0) return false

  const { randomUUID } = await import('node:crypto')
  const configContent = `// --- Базовые параметры
sv_cheats 0
sv_lan 0
log on

// --- Командные и дружеский огонь
mp_autoteambalance 0
mp_limitteams 1
mp_friendlyfire 1
mp_forcecamera 1         // смотреть только за своими после смерти
mp_teammates_are_enemies 0
mp_solid_teammates 1

// --- Варм-ап
mp_warmuptime 60
mp_warmup_pausetimer 0

// --- Экономика и раунды (MR12)
mp_startmoney 800
mp_maxmoney 16000
mp_maxrounds 24            // MR12 (до 13 побед)
mp_halftime 1
mp_halftime_duration 15
mp_freezetime 15
mp_buytime 20
mp_defuser_allocation 0    // без бесплатных китов
mp_roundtime 1.92         // ~1:55
mp_roundtime_defuse 1.92

// --- Овертаймы (как на FACEIT/турнирах)
mp_overtime_enable 1
mp_overtime_maxrounds 6    // MR3 на сторону (в сумме 6)
mp_overtime_startmoney 12500

// --- Тайм-ауты (4 по 30 сек)
mp_team_timeout_max 4
mp_team_timeout_time 30

// --- Поведение матчей/раундов
mp_round_restart_delay 5
mp_match_end_restart 0
mp_match_end_changelevel 1
mp_endmatch_votenextmap 0

// --- Дропы
mp_death_drop_defuser 1
mp_death_drop_grenade 2    // 2 = лучшее
mp_death_drop_gun 1

// --- Ограничения по гранатам (актуально для большинства лиг)
ammo_grenade_limit_total 4

// --- Боты и прочее
bot_quota 0
mp_disconnect_kills_bots 1
sv_hibernate_when_empty 0

// --- GOTV (на турнирах ставят большую задержку)
tv_enable 1
tv_delay 105
tv_delaymapchange 1
tv_relayvoice 0`

  insertPreset({
    id: randomUUID(),
    name: 'MR12 Competitive',
    description: 'Competitive 12-16 with FACEIT/tournament rules',
    gameType: '0',
    gameMode: '1',
    map: 'de_dust2',
    configContent,
    createdAt: Date.now()
  })

  return true
}
