import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.js'

/**
 * Open a UDP port in the host firewall via ufw (requires root).
 *
 * Best-effort and fire-and-forget: launching a server must not fail just
 * because the firewall rule could not be added (e.g. no privileges in dev).
 * No-op entirely when FIREWALL=off.
 */
export function openFirewallPort(port: number): void {
  if (!config.firewall) return

  spawn('ufw', ['allow', `${port}/udp`]).on('error', (err) => {
    console.error(`[firewall] failed to add ufw rule for port ${port}:`, err.message)
  })
}

export interface LaunchParams {
  gameType: string
  gameMode: string
  map: string
  port: number
  configPath?: string
}

/**
 * Build the argv passed to the CS2 dedicated server binary.
 * Platform-agnostic; extra args and GSLT come from config.
 */
export function buildCs2Args(p: LaunchParams): string[] {
  // Each console command and its value must be a SEPARATE argv element.
  // Joining them (e.g. '+game_type 0') passes one arg with an embedded space,
  // which the engine parses correctly on Windows (it re-reads the raw command
  // line) but NOT on Linux (argv is taken verbatim). Keep them split.
  //
  // Port binding uses the '-port' launch flag, not the '+hostport' cvar.
  // '-port' is read early during engine init and reliably binds the game
  // socket, so multiple instances get distinct ports. '+hostport' is a cvar
  // applied later and is not honored consistently across instances, which
  // would collapse every server onto the default 27015.
  const args = [
    '-dedicated',
    '-usercon',
    '-port',
    String(p.port),
    '+game_type',
    p.gameType,
    '+game_mode',
    p.gameMode,
    '+map',
    p.map
  ]

  // Preset config file execution (runs before extra args so they can override).
  if (p.configPath) {
    args.push('+exec', p.configPath)
  }

  // GSLT is only needed for public/internet servers (Linux prod). Optional.
  if (config.gsltToken) {
    args.push('+sv_setsteamaccount', config.gsltToken)
  }

  // Any operator-supplied extra flags (e.g. +sv_hibernate_when_empty 0).
  args.push(...config.cs2ExtraArgs)

  return args
}

const METAMOD_SEARCH_PATH = 'Game\t\tcsgo/addons/metamod'

/**
 * steamcmd's app_update validate step overwrites csgo/gameinfo.gi with the
 * stock version, silently dropping the Metamod search path that Metamod's
 * own installer adds. Re-insert it after every steamcmd run so CSSharp
 * plugins keep loading. Idempotent and best-effort: a missing/unwritable
 * gameinfo.gi must not block the server launch.
 */
export function ensureMetamodHook(): void {
  if (!config.csgoDir) return

  const gameinfoPath = join(config.csgoDir, 'gameinfo.gi')
  if (!existsSync(gameinfoPath)) return

  try {
    const content = readFileSync(gameinfoPath, 'utf-8')
    if (content.includes('csgo/addons/metamod')) return

    const lines = content.split('\n')
    const gameLineIndex = lines.findIndex((line) => /^\s*Game\s+csgo\s*$/.test(line))
    if (gameLineIndex === -1) {
      console.error('[platform] could not find "Game csgo" search path in gameinfo.gi, skipping metamod hook')
      return
    }

    lines.splice(gameLineIndex + 1, 0, `\t\t\t${METAMOD_SEARCH_PATH.trim()}`)
    writeFileSync(gameinfoPath, lines.join('\n'), 'utf-8')
    console.log('[platform] re-inserted metamod search path into gameinfo.gi')
  } catch (err) {
    console.error('[platform] failed to patch gameinfo.gi:', (err as Error).message)
  }
}
