import 'dotenv/config'
import { resolve } from 'node:path'

function str(name: string, fallback?: string): string {
  const v = process.env[name]
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback
    throw new Error(`Missing required env var: ${name}`)
  }
  return v
}

function int(name: string, fallback: number): number {
  const v = process.env[name]
  if (v === undefined || v === '') return fallback
  const n = Number.parseInt(v, 10)
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be an integer, got: ${v}`)
  return n
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name]
  if (v === undefined || v === '') return fallback
  return /^(1|true|on|yes)$/i.test(v)
}

// CS2_EXTRA_ARGS is pipe-separated so individual args may contain spaces
// without shell quoting. Empty string -> no extra args.
function pipeArgs(name: string): string[] {
  const v = process.env[name]
  if (v === undefined || v === '') return []
  return v.split('|')
}

export interface Config {
  host: string
  port: number
  jwtSecret: string
  jwtTtl: number
  seedUsername: string
  seedPassword: string
  cs2Bin: string
  cs2ExtraArgs: string[]
  basePort: number
  firewall: boolean
  gsltToken: string
  dbPath: string
  logDir: string
  pluginsDir: string
}

export const config: Config = {
  host: str('HOST', '127.0.0.1'),
  port: int('PORT', 3000),
  jwtSecret: str('JWT_SECRET', 'dev-only-change-me'),
  jwtTtl: int('JWT_TTL', 43200),
  seedUsername: str('SEED_USERNAME', 'admin'),
  seedPassword: str('SEED_PASSWORD', 'changeme'),
  cs2Bin: str('CS2_BIN', 'node'),
  cs2ExtraArgs: pipeArgs('CS2_EXTRA_ARGS'),
  basePort: int('BASE_PORT', 27015),
  firewall: bool('FIREWALL', false),
  gsltToken: str('GSLT_TOKEN', ''),
  dbPath: resolve(str('DB_PATH', './data/launcher.db')),
  logDir: resolve(str('LOG_DIR', './data/logs')),
  pluginsDir: resolve(str('PLUGINS_DIR', ''))
}

// Warn loudly when running with insecure defaults outside local dev.
if (config.jwtSecret === 'dev-only-change-me' && config.host !== '127.0.0.1') {
  console.warn(
    '[config] WARNING: default JWT_SECRET is in use while binding beyond localhost. ' +
      'Set a strong JWT_SECRET before exposing this backend.'
  )
}
