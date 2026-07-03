import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.js'
import { buildCs2Args, openFirewallPort } from './platform.js'
import {
  deleteStoppedServers,
  getServer,
  insertServer,
  listRunningServers,
  listServers,
  markServerStopped,
  type ServerRow
} from './db.js'

/**
 * Emits 'servers-updated' with the full server list whenever state changes.
 * The transport layer (WS) subscribes; the manager stays transport-agnostic.
 */
export const events = new EventEmitter()

function broadcast(): void {
  events.emit('servers-updated', listServers())
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

export interface LaunchInput {
  gameType: string
  gameMode: string
  modeName: string
  map: string
  mapLabel: string
}

export interface LaunchResult {
  success: boolean
  id?: string
  port?: number
  error?: string
}

export function launchServer(input: LaunchInput): LaunchResult {
  const port = getNextAvailablePort()

  openFirewallPort(port)

  const args = buildCs2Args({
    gameType: input.gameType,
    gameMode: input.gameMode,
    map: input.map,
    port
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
    status: 'running'
  }

  insertServer(row)
  broadcast()

  return { success: true, id: row.id, port }
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
    markServerStopped(id, Date.now())
    broadcast()
  }
  return { success: true }
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
