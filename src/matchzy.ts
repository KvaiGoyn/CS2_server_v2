import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.js'
import type { RconManager } from './rcon.js'
import type { MatchConfigRow, PresetRow } from './db.js'

/**
 * MatchZy takes per-match convars only through a loaded match config — the
 * `cvars` object in its match JSON. Convars applied any other way (a preset's
 * +exec, or manual RCON before go-live) get overwritten when MatchZy applies
 * its own defaults on the warmup→live transition. Handing the convars to
 * MatchZy itself is the only way they survive the whole match.
 *
 * See https://shobhit-pathak.github.io/MatchZy/ (match setup / loadmatch).
 */

export interface MatchJson {
  matchid: string
  num_maps: number
  maplist: string[]
  players_per_team: number
  team1: { name: string; players: Record<string, string> }
  team2: { name: string; players: Record<string, string> }
  cvars: Record<string, string>
  remote_log_url: string
  remote_log_header_key: string
  remote_log_header_value: string
}

/**
 * Parse a match config's `convars` (stored as a JSON string) into a flat
 * string→string cvar map. Non-string values are coerced to strings; invalid
 * JSON yields an empty map so a bad config never blocks the match load.
 */
function parseCvars(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (parsed === null || typeof parsed !== 'object') return {}
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (value === null || value === undefined) continue
      out[key] = String(value)
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Point MatchZy's remote-log webhook at this backend for a given server.
 *
 * `remote_log_url` is a top-level field of the match JSON (not a cvar) that
 * makes MatchZy POST every match event (go-live, round end, series result,
 * etc.) to us as JSON, instead of the launcher polling `status` and
 * regex-parsing text the engine never guaranteed a stable shape for.
 * `remote_log_header_key/value` let the webhook route verify the request
 * actually came from this CS2 instance.
 */
function webhookFields(
  serverId: string
): Pick<MatchJson, 'remote_log_url' | 'remote_log_header_key' | 'remote_log_header_value'> {
  return {
    remote_log_url: `http://127.0.0.1:${config.port}/webhooks/matchzy/${serverId}`,
    remote_log_header_key: 'x-matchzy-secret',
    remote_log_header_value: config.matchzyWebhookSecret
  }
}

/**
 * Build a MatchZy match JSON from a stored match config.
 *
 * Player rosters are left empty: the current match config schema stores only
 * team names, not Steam64 IDs, so MatchZy runs as an open match and assigns
 * players as they connect. The `cvars` object carries the operator-defined
 * convars, which is the whole point — MatchZy re-applies them on go-live.
 *
 * `matchid` is the server's own id, not the match config's — a match config
 * can be reused across multiple simultaneously-running servers, and the
 * webhook route needs a matchid that uniquely identifies one running server.
 */
export function buildMatchJson(
  matchConfig: MatchConfigRow,
  launchMap: string,
  serverId: string
): MatchJson {
  const map = matchConfig.map || launchMap
  return {
    matchid: serverId,
    num_maps: 1,
    maplist: [map],
    players_per_team: 5,
    team1: { name: matchConfig.team1_name, players: {} },
    team2: { name: matchConfig.team2_name, players: {} },
    cvars: parseCvars(matchConfig.convars),
    ...webhookFields(serverId)
  }
}

/**
 * Parse a preset's raw `.cfg` text into a flat string→string cvar map.
 *
 * Preset configs are hand-written server .cfg files: one `cvar value` pair
 * per line, blank lines, and `//` comments (inline or full-line). This turns
 * that into the same shape `buildMatchJsonFromPreset` hands to MatchZy, so
 * the operator's rules survive the whole match instead of just warmup.
 */
export function parseCfgCvars(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of raw.split('\n')) {
    // Strip comments first (// to end of line), then trim.
    const line = rawLine.split('//')[0].trim()
    if (!line) continue

    const match = line.match(/^(\S+)\s+(.+)$/)
    if (!match) continue

    const [, key, rest] = match
    // Values are often quoted ("15") or bare (15) — strip matching quotes.
    const value = rest.trim().replace(/^"(.*)"$/, '$1')
    out[key] = value
  }
  return out
}

/**
 * Build a MatchZy match JSON from a preset, so a preset's rules go through
 * `matchzy_loadmatch` instead of a one-shot `+exec` that MatchZy overwrites
 * on the warmup→live transition.
 *
 * Team names are left generic: presets have no team-name fields, and MatchZy
 * derives display names from connected players' own team assignment/nicknames
 * when a match runs open (no player Steam64 roster), so nothing else is needed.
 */
export function buildMatchJsonFromPreset(
  preset: PresetRow,
  launchMap: string,
  serverId: string
): MatchJson {
  const map = preset.map || launchMap
  return {
    matchid: serverId,
    num_maps: 1,
    maplist: [map],
    players_per_team: 5,
    team1: { name: 'Team 1', players: {} },
    team2: { name: 'Team 2', players: {} },
    cvars: parseCfgCvars(preset.configContent),
    ...webhookFields(serverId)
  }
}

/**
 * Write the match JSON into the csgo/ directory and return the filename to
 * pass to `matchzy_loadmatch` (which resolves paths relative to csgo/).
 * Throws if CSGO_DIR is unset — without it there's nowhere MatchZy can read.
 */
export function writeMatchFile(serverId: string, json: MatchJson): string {
  if (!config.csgoDir) {
    throw new Error('CSGO_DIR is not configured; cannot write MatchZy match file')
  }
  const filename = `launcher-match-${serverId}.json`
  const fullPath = join(config.csgoDir, filename)
  writeFileSync(fullPath, JSON.stringify(json, null, 2), 'utf-8')
  console.log(`[matchzy] wrote match file to ${fullPath}`)
  return filename
}

/**
 * Ask MatchZy to load the match file, retrying until the plugin is ready.
 *
 * MatchZy isn't loaded the instant the process spawns — the map has to finish
 * loading and CSSharp has to bring the plugin up first. RCON to an
 * un-ready MatchZy returns an "Unknown command" echo, so poll with a fixed
 * delay and stop once the response no longer looks like a rejection.
 */
export async function loadMatchWithRetry(
  rconManager: RconManager,
  filename: string,
  { attempts = 20, delayMs = 3000 }: { attempts?: number; delayMs?: number } = {}
): Promise<boolean> {
  const command = `matchzy_loadmatch ${filename}`

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await rconManager.execute(command)
      // MatchZy echoes "Unknown command" (with the CS2 console prefix) while
      // the plugin hasn't registered its commands yet. Anything else means
      // the command reached the plugin.
      if (!/unknown command/i.test(response)) {
        console.log(
          `[matchzy] loadmatch accepted on attempt ${attempt}${response ? `: ${response.trim()}` : ''}`
        )
        return true
      }
    } catch (err) {
      // RCON not up yet (connection refused/reset) or a transient timeout —
      // treat like a not-ready plugin and keep retrying.
      console.log(
        `[matchzy] loadmatch attempt ${attempt} failed: ${(err as Error).message}`
      )
    }

    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }

  console.error(
    `[matchzy] loadmatch never accepted after ${attempts} attempts; ` +
      'match convars will not be applied by MatchZy'
  )
  return false
}
