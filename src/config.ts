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
  rconPassword: string
  rconHost: string
  dbPath: string
  logDir: string
  csgoDir: string
  autoUpdateCs2: boolean
  steamCmdBin: string
  cs2InstallDir: string
  cs2AppId: string
  steamCmdTimeoutMs: number
}

// Resolve CSGO_DIR (preferred) or derive it from legacy PLUGINS_DIR by
// walking up from .../addons/counterstrikesharp/plugins/ to the csgo root.
function resolveCsgoDir(): string {
  const explicit = process.env.CSGO_DIR
  if (explicit && explicit !== '') return resolve(explicit)

  const legacy = process.env.PLUGINS_DIR
  if (legacy && legacy !== '') {
    // Expect .../csgo/addons/counterstrikesharp/plugins → strip 3 segments.
    const norm = resolve(legacy).replace(/\/+$/, '')
    const segs = norm.split('/')
    if (
      segs.length >= 4 &&
      segs[segs.length - 1] === 'plugins' &&
      segs[segs.length - 2] === 'counterstrikesharp' &&
      segs[segs.length - 3] === 'addons'
    ) {
      return segs.slice(0, -3).join('/')
    }
    console.warn(
      `[config] PLUGINS_DIR="${legacy}" doesn't look like .../csgo/addons/counterstrikesharp/plugins. ` +
        'Set CSGO_DIR explicitly for MatchZy-style plugins.'
    )
  }
  return ''
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
  rconPassword: str('RCON_PASSWORD', ''),
  rconHost: str('RCON_HOST', '127.0.0.1'),
  dbPath: resolve(str('DB_PATH', './data/launcher.db')),
  logDir: resolve(str('LOG_DIR', './data/logs')),
  csgoDir: resolveCsgoDir(),
  autoUpdateCs2: bool('AUTO_UPDATE_CS2', false),
  steamCmdBin: str('STEAMCMD_BIN', 'steamcmd'),
  cs2InstallDir: str('CS2_INSTALL_DIR', ''),
  cs2AppId: str('CS2_APP_ID', '730'),
  steamCmdTimeoutMs: int('STEAMCMD_TIMEOUT_MS', 300000)
}

// Warn loudly when running with insecure defaults outside local dev.
if (config.jwtSecret === 'dev-only-change-me' && config.host !== '127.0.0.1') {
  console.warn(
    '[config] WARNING: default JWT_SECRET is in use while binding beyond localhost. ' +
      'Set a strong JWT_SECRET before exposing this backend.'
  )
}

if (config.autoUpdateCs2 && config.cs2InstallDir === '') {
  console.warn(
    '[config] WARNING: AUTO_UPDATE_CS2 is enabled but CS2_INSTALL_DIR is not set. ' +
      'steamcmd needs -force_install_dir to know where the server lives; updates will be skipped.'
  )
}
