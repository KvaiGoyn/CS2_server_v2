import { spawn } from 'node:child_process'
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
  const args = [
    '-dedicated',
    '-usercon',
    '+game_type',
    p.gameType,
    '+game_mode',
    p.gameMode,
    '+map',
    p.map,
    '+hostport',
    String(p.port)
  ]

  // GSLT is only needed for public/internet servers (Linux prod). Optional.
  if (config.gsltToken) {
    args.push('+sv_setsteamaccount', config.gsltToken)
  }

  // Any operator-supplied extra flags (e.g. +sv_hibernate_when_empty 0).
  args.push(...config.cs2ExtraArgs)

  return args
}
