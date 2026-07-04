import { spawn } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync, openSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.js'
import { buildCs2Args, openFirewallPort, ensureMetamodHook } from './platform.js'
import {
  deleteStoppedServers,
  getServer,
  insertServer,
  listRunningServers,
  listServers,
  markServerStopped,
  getPreset,
  getMatchConfig,
  type ServerRow
} from './db.js'
import { RconManager } from './rcon.js'
import { MatchPoller, type LiveMatch } from './match-poller.js'
import { updateCs2Server } from './steamcmd.js'

/**
 * Emits 'servers-updated' with the full server list whenever state changes.
 * The transport layer (WS) subscribes; the manager stays transport-agnostic.
 */
export const events = new EventEmitter()

const rconManagers = new Map<string, RconManager>()
const matchPollers = new Map<string, MatchPoller>()

function broadcast(): void {
  events.emit('servers-updated', listServers())
}

function hashPassword(password: string): string {
  return createHash('sha256').update(password).digest('hex')
}

function extractRconPassword(csgoDir: string): string | null {
  if (!csgoDir) return null
  const configPath = join(csgoDir, 'addons/counterstrikesharp/plugins/MatchZy/MatchZy_config.cfg')
  if (!existsSync(configPath)) return null
  try {
    const content = readFileSync(configPath, 'utf-8')
    const match = content.match(/rcon_password\s+"([^"]+)"/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

/**
 * Pick the lowest free UDP port at/above BASE_PORT among running servers.
 * Mirrors the original launcher's allocation.
 */
function getNextAvailablePort(): number {
  const used = new Set(listRunningServers().map((s) => s.port))
  let port = config.basePort
  while (used.has(port)) port++
  return port
}

/**
 * A signal-0 kill probes liveness without touching the process.
 * ESRCH -> gone; EPERM -> alive but owned by another user (still alive).
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function writeServerConfig(cfg: string): string {
  const filename = `/tmp/cs2-config-${randomUUID()}.cfg`
  try {
    writeFileSync(filename, cfg, 'utf-8')
    chmodSync(filename, 0o666)
    console.log(`[manager] wrote config to ${filename}`)
  } catch (err) {
    console.error(`[manager] failed to write config to ${filename}:`, (err as Error).message)
    throw err
  }
  return filename
}

export interface LaunchInput {
  gameType: string
  gameMode: string
  modeName: string
  map: string
  mapLabel: string
  presetId?: string
  matchConfigId?: string
}

export interface LaunchResult {
  success: boolean
  id?: string
  port?: number
  error?: string
}

export async function launchServer(input: LaunchInput): Promise<LaunchResult> {
  const port = getNextAvailablePort()

  openFirewallPort(port)

  if (config.autoUpdateCs2) {
    console.log('[manager] checking for CS2 updates via steamcmd...')
    const update = await updateCs2Server()
    if (!update.success) {
      console.error(`[manager] steamcmd update failed, launching with current install: ${update.error}`)
    } else {
      console.log('[manager] steamcmd update check complete')
    }
    ensureMetamodHook()
  }

  let configPath: string | undefined
  if (input.presetId) {
    const preset = getPreset(input.presetId)
    if (preset) {
      try {
        configPath = writeServerConfig(preset.configContent)
      } catch (err) {
        return { success: false, error: `Failed to write preset config: ${(err as Error).message}` }
      }
    }
  }

  const args = buildCs2Args({
    gameType: input.gameType,
    gameMode: input.gameMode,
    map: input.map,
    port,
    configPath
  })

  // Redirect the server's stdout/stderr to a per-launch log file so we can
  // diagnose crashes (spawn ENOENT, missing libs, bad cfg) instead of losing
  // everything to /dev/null. One file per (port, launch time).
  const launchedAt = Date.now()
  let stdio: 'ignore' | ['ignore', number, number] = 'ignore'
  let logPath: string | null = null
  try {
    mkdirSync(config.logDir, { recursive: true })
    logPath = join(config.logDir, `${port}-${launchedAt}.log`)
    const fd = openSync(logPath, 'a')
    stdio = ['ignore', fd, fd]
  } catch (err) {
    // Logging is best-effort: if the dir/file can't be created, fall back to
    // 'ignore' rather than blocking the launch.
    console.error(`[manager] could not open log file, launching without logs:`, (err as Error).message)
  }

  let child
  try {
    child = spawn(config.cs2Bin, args, {
      detached: true,
      stdio
    })
  } catch (err) {
    return { success: false, error: `Failed to spawn ${config.cs2Bin}: ${(err as Error).message}` }
  }

  // On Linux, spawn failures (ENOENT/EACCES) surface asynchronously via the
  // 'error' event, NOT as a throw — child.pid is undefined in that case.
  // Log it so the reason ends up in journald instead of vanishing.
  child.on('error', (err) => {
    console.error(`[manager] spawn error for ${config.cs2Bin}:`, err.message)
  })

  // Detach so the CS2 process outlives the backend if it restarts.
  child.unref()

  if (child.pid === undefined) {
    return { success: false, error: 'Spawn returned no PID' }
  }

  const rconPort = port + 1
  const rconPassword = extractRconPassword(config.csgoDir)
  const passwordHash = rconPassword ? hashPassword(rconPassword) : undefined

  const row: ServerRow = {
    id: randomUUID(),
    pid: child.pid,
    port,
    exePath: config.cs2Bin,
    map: input.map,
    mapLabel: input.mapLabel || input.map,
    modeName: input.modeName || 'Custom',
    gameType: input.gameType,
    gameMode: input.gameMode,
    launchedAt,
    stoppedAt: null,
    status: 'running',
    rcon_port: rconPort,
    rcon_password_hash: passwordHash
  }

  insertServer(row)

  // Initialize RCON manager for this server if password was found
  if (rconPassword) {
    const rconManager = new RconManager(port, rconPassword)
    rconManagers.set(row.id, rconManager)
    console.log(`[manager] RCON initialized for server ${row.id} on port ${rconPort}`)

    if (input.matchConfigId) {
      startMatchPoller(row.id, rconManager, input.matchConfigId, input.map)
    }
  }

  broadcast()

  return { success: true, id: row.id, port }
}

function startMatchPoller(
  serverId: string,
  rconManager: RconManager,
  matchConfigId: string,
  map: string
): void {
  const matchConfig = getMatchConfig(matchConfigId)
  if (!matchConfig) return

  let maxRounds = 24
  try {
    const convars = JSON.parse(matchConfig.convars) as Record<string, string>
    if (convars.mp_maxrounds) {
      const parsed = parseInt(convars.mp_maxrounds, 10)
      if (!Number.isNaN(parsed)) maxRounds = parsed
    }
  } catch {
    // convars isn't valid JSON — fall back to the default maxRounds
  }

  const poller = new MatchPoller(
    rconManager,
    serverId,
    map,
    matchConfig.team1_name,
    matchConfig.team2_name,
    maxRounds,
    events
  )
  poller.start()
  matchPollers.set(serverId, poller)
  console.log(`[manager] match poller started for server ${serverId}`)
}

export function getLiveMatches(): LiveMatch[] {
  const states: LiveMatch[] = []
  for (const poller of matchPollers.values()) {
    const state = poller.getState()
    if (state) states.push(state)
  }
  return states
}

export function stopServer(id: string): { success: boolean; error?: string } {
  const entry = getServer(id)
  if (!entry) return { success: false, error: 'Server not found' }

  if (entry.status === 'running') {
    try {
      // Kill the entire process group so cs2.sh wrapper and the forked engine
      // process both die. process.kill with negative pid sends to the group.
      process.kill(-entry.pid, 'SIGTERM')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ESRCH') {
        // Group already gone — try killing just the pid as fallback
        try { process.kill(entry.pid, 'SIGTERM') } catch { /* already dead */ }
      } else {
        console.error(`[manager] failed to kill pid ${entry.pid}:`, (err as Error).message)
      }
    }
    // Clean up match poller
    const poller = matchPollers.get(id)
    if (poller) {
      poller.stop()
      matchPollers.delete(id)
    }
    // Clean up RCON manager
    const rconMgr = rconManagers.get(id)
    if (rconMgr) {
      rconMgr.close()
      rconManagers.delete(id)
    }
    markServerStopped(id, Date.now())
    broadcast()
  }
  return { success: true }
}

export async function executeRconCommand(
  serverId: string,
  command: string
): Promise<{ success: boolean; message?: string }> {
  const rconMgr = rconManagers.get(serverId)
  if (!rconMgr) {
    return { success: false, message: 'RCON not available for this server' }
  }
  try {
    const response = await rconMgr.execute(command)
    return { success: true, message: response }
  } catch (err) {
    return { success: false, message: (err as Error).message }
  }
}

export function clearStopped(): { success: boolean } {
  deleteStoppedServers()
  broadcast()
  return { success: true }
}

export function getServers(): ServerRow[] {
  reconcile()
  return listServers()
}

/**
 * Detect servers whose process died out-of-band and mark them stopped.
 * Runs on a timer and before every listing.
 */
export function reconcile(): void {
  let changed = false
  for (const entry of listRunningServers()) {
    if (!isPidAlive(entry.pid)) {
      markServerStopped(entry.id, Date.now())
      changed = true
    }
  }
  if (changed) broadcast()
}

let reconcileTimer: NodeJS.Timeout | null = null

export function startReconcileLoop(intervalMs = 3000): void {
  if (reconcileTimer) return
  reconcile()
  reconcileTimer = setInterval(reconcile, intervalMs)
  reconcileTimer.unref()
}
