import { writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { config } from './config.js'
import type { RconManager } from './rcon.js'
import type { MatchConfigRow, PresetRow } from './db.js'

/**
 * Getting operator convars to survive the whole match takes TWO mechanisms,
 * because MatchZy applies convars at different phases:
 *
 * 1. Match JSON `cvars` (loadmatch) — applied when the match loads, so they
 *    hold during warmup. But on the warmup→live transition MatchZy executes
 *    cfg/MatchZy/live.cfg, which resets a big list of gameplay convars to
 *    MatchZy's OWN defaults (e.g. mp_freezetime 18), clobbering the JSON values.
 *
 * 2. cfg/MatchZy/live_override.cfg — the LAST line of live.cfg is
 *    `exec MatchZy/live_override.cfg`, a MatchZy-provided hook that runs AFTER
 *    the defaults. Writing the operator's convars here is the only place they
 *    survive go-live. This ships empty by default; the launcher fills it per
 *    match (see writeLiveOverride).
 *
 * So we write BOTH: the match JSON covers warmup + remote_log + sv_lan, and
 * live_override.cfg re-asserts the operator's gameplay convars on go-live.
 *
 * See https://shobhit-pathak.github.io/MatchZy/ (match setup / configuration).
 */

export interface MatchJson {
  // MatchZy's schema requires `matchid` as a NUMBER (the canonical example
  // uses `"matchid": 27`). A string here (a UUID, as an earlier version of
  // this code used) fails JSON deserialization inside MatchZy and the plugin
  // echoes "Match load failed! Resetting current match" — the preset cvars
  // never apply. Derive a stable unsigned 32-bit int from the server id.
  matchid: number
  num_maps: number
  maplist: string[]
  players_per_team: number
  team1: { name: string; players: Record<string, string> }
  team2: { name: string; players: Record<string, string> }
  cvars: Record<string, string>
}

/**
 * Cvars the launcher force-applies to every match, spread AFTER the operator's
 * preset/config cvars so they win even if the preset sets a conflicting value.
 *
 * Two groups:
 *
 * 1. MatchZy remote event logging (`matchzy_remote_log_url`,
 *    `matchzy_remote_log_header_key`, `matchzy_remote_log_header_value`) —
 *    MatchZy takes these as CONVARS, NOT top-level fields of the match JSON.
 *    An earlier version put `remote_log_url` etc. as siblings of `matchid`;
 *    MatchZy's schema does not know those keys and unknown top-level fields
 *    can contribute to a parse failure. Folding them into `cvars` makes
 *    MatchZy apply them like any other convar on loadmatch.
 *
 * 2. `sv_lan` is NOT forced — the operator picks it per preset in the launcher
 *    (open server = `sv_lan 0`, needs a GSLT; local LAN = `sv_lan 1`, no token).
 *    Forcing it here would override that choice, since forcedCvars spreads last.
 *    The GSLT itself, if configured (env `GSLT_TOKEN`), is added as
 *    `+sv_setsteamaccount` in buildCs2Args regardless of sv_lan.
 */
function forcedCvars(
  serverId: string
): Record<string, string> {
  return {
    matchzy_remote_log_url: `http://127.0.0.1:${config.port}/webhooks/matchzy/${serverId}`,
    matchzy_remote_log_header_key: 'x-matchzy-secret',
    matchzy_remote_log_header_value: config.matchzyWebhookSecret
  }
}

/**
 * Derive a stable unsigned 32-bit match id from the server's UUID. MatchZy
 * wants a numeric matchid (its example uses an integer), but the launcher
 * keys everything off the server's UUID. Hashing the UUID gives a stable
 * number in MatchZy's range; the webhook route still uses the real serverId
 * from the URL path, so routing does not depend on this number.
 */
function numericMatchId(serverId: string): number {
  const digest = createHash('sha256').update(serverId).digest()
  return digest.readUInt32BE(0)
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
 * Build a MatchZy match JSON from a stored match config.
 *
 * Player rosters are left empty: the current match config schema stores only
 * team names, not Steam64 IDs, so MatchZy runs as an open match and assigns
 * players as they connect. The `cvars` object carries the operator-defined
 * convars, which is the whole point — MatchZy re-applies them on go-live.
 *
 * `matchid` is a number derived from the server's id (see numericMatchId):
 * MatchZy's schema requires a numeric matchid; a UUID string here makes
 * MatchZy reject the whole file ("Match load failed! Resetting current
 * match"). The webhook route identifies the server via the URL path, not via
 * this matchid, so a hashed number is fine.
 */
export function buildMatchJson(
  matchConfig: MatchConfigRow,
  launchMap: string,
  serverId: string
): MatchJson {
  const map = matchConfig.map || launchMap
  return {
    matchid: numericMatchId(serverId),
    num_maps: 1,
    maplist: [map],
    players_per_team: 5,
    team1: { name: matchConfig.team1_name, players: {} },
    team2: { name: matchConfig.team2_name, players: {} },
    cvars: { ...parseCvars(matchConfig.convars), ...forcedCvars(serverId) }
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
    matchid: numericMatchId(serverId),
    num_maps: 1,
    maplist: [map],
    players_per_team: 5,
    team1: { name: 'Team 1', players: {} },
    team2: { name: 'Team 2', players: {} },
    cvars: { ...parseCfgCvars(preset.configContent), ...forcedCvars(serverId) }
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
 * Write the operator's gameplay convars into cfg/MatchZy/live_override.cfg so
 * they win on go-live. live.cfg resets gameplay convars to MatchZy defaults
 * (e.g. mp_freezetime 18) and then, on its LAST line, runs
 * `exec MatchZy/live_override.cfg` — so whatever we put here is applied AFTER
 * live.cfg and is the only thing that survives the warmup→live transition.
 *
 * Derived from the match JSON's own cvars, minus the launcher-forced entries:
 * `matchzy_*` are plugin convars (not gameplay) and `sv_lan` is a launch-time
 * setting live.cfg never touches, so neither belongs in the go-live override.
 * The file is one `cvar value` per line and is overwritten for every match.
 */
export function writeLiveOverride(json: MatchJson): void {
  if (!config.csgoDir) return
  const path = join(config.csgoDir, 'cfg', 'MatchZy', 'live_override.cfg')
  const lines = Object.entries(json.cvars)
    .filter(([key]) => !key.startsWith('matchzy_') && key !== 'sv_lan')
    .map(([key, value]) => `${key} ${value}`)
  const header =
    '// Generated by CS2 launcher — operator convars re-asserted on go-live.\n' +
    '// Executed by the last line of live.cfg; overwritten per match.\n'
  writeFileSync(path, `${header}${lines.join('\n')}\n`, 'utf-8')
  console.log(`[matchzy] wrote live_override.cfg (${lines.length} cvars) to ${path}`)
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

  // MatchZy's reply vocabulary:
  //   - "Unknown command ..."      → plugin not registered yet (keep retrying)
  //   - "Match load failed! Resetting current match" → plugin IS up but the
  //     JSON was rejected (bad schema — e.g. a non-numeric matchid). Retrying
  //     with the same file won't help, but a flaky transient load can, so we
  //     still retry a couple of times before giving up loudly.
  //   - anything else             → accepted.
  const isNotReady = (r: string): boolean => /unknown command/i.test(r)
  const isLoadFailed = (r: string): boolean =>
    /match load failed|resetting current match/i.test(r)

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await rconManager.execute(command)
      if (isLoadFailed(response)) {
        // The plugin received the command but rejected the match JSON.
        // Surface the exact echo so the operator can see WHY (schema bug,
        // bad cvar, etc.) instead of it masquerading as "accepted".
        console.error(
          `[matchzy] loadmatch REJECTED on attempt ${attempt}: ${response.trim()}`
        )
        // Don't immediately bail — the first response sometimes races with
        // plugin init. Keep retrying; if it keeps failing, the loop's end
        // logs the definitive "never accepted".
      } else if (!isNotReady(response)) {
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
