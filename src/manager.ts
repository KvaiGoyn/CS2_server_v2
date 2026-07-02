import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
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

  let child
  try {
    child = spawn(config.cs2Bin, args, {
      detached: true,
      stdio: 'ignore'
    })
  } catch (err) {
    return { success: false, error: `Failed to spawn ${config.cs2Bin}: ${(err as Error).message}` }
  }

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
    launchedAt: Date.now(),
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
      process.kill(entry.pid)
    } catch (err) {
      // ESRCH just means it already died; anything else we log but still mark stopped.
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ESRCH') {
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
