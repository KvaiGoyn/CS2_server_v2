import { EventEmitter } from 'node:events'
import { RconManager } from './rcon.js'

export type MatchPhase = 'warmup' | 'knife' | 'live' | 'halftime' | 'ended'

export interface LiveMatch {
  id: string
  server_id: string
  map: string
  team1_name: string
  team1_score: number
  team2_name: string
  team2_score: number
  current_round: number
  max_rounds: number
  phase: MatchPhase
  freeze_time_remaining?: number
  players_alive: { team1: number; team2: number }
  last_updated: number
}

// Parse RCON status output to extract scores and phase
function parseStatus(output: string): {
  team1_score: number
  team2_score: number
  current_round: number
  players: { team1: number; team2: number }
} | null {
  try {
    // Look for score line: "Team scores: CT:X TE:Y"
    const scoreMatch = output.match(/Team scores:\s*CT:(\d+)\s+TE:(\d+)/i)
    if (!scoreMatch) return null

    const ctScore = parseInt(scoreMatch[1], 10)
    const teScore = parseInt(scoreMatch[2], 10)

    // Count players alive per team
    const lines = output.split('\n')
    let team1Players = 0
    let team2Players = 0
    let currentRound = 0

    for (const line of lines) {
      if (line.includes('(CT)') || line.includes('(Counter-Terrorist)')) {
        team1Players++
      } else if (line.includes('(TE)') || line.includes('(Terrorist)')) {
        team2Players++
      }
    }

    // Try to extract current round from status output
    const roundMatch = output.match(/Current round: (\d+)/i)
    if (roundMatch) {
      currentRound = parseInt(roundMatch[1], 10)
    }

    return {
      team1_score: ctScore,
      team2_score: teScore,
      current_round: currentRound,
      players: { team1: team1Players, team2: team2Players }
    }
  } catch {
    return null
  }
}

// Detect match phase from server state
function detectPhase(
  team1Score: number,
  team2Score: number,
  maxRounds: number,
  output: string
): MatchPhase {
  // Check for specific keywords in output
  if (output.toLowerCase().includes('knife')) return 'knife'
  if (output.toLowerCase().includes('match ended')) return 'ended'

  // If both scores are 0, it's warmup
  if (team1Score === 0 && team2Score === 0) {
    return 'warmup'
  }

  // If halftime threshold is reached
  const halftimeThreshold = maxRounds / 2
  if ((team1Score === halftimeThreshold && team2Score < halftimeThreshold) ||
      (team2Score === halftimeThreshold && team1Score < halftimeThreshold)) {
    return 'halftime'
  }

  // Check if match is ended (one team won or max rounds reached)
  const maxWins = Math.ceil(maxRounds / 2)
  if (team1Score >= maxWins || team2Score >= maxWins) {
    return 'ended'
  }

  // Otherwise it's live
  return 'live'
}

export class MatchPoller {
  private rconManager: RconManager
  private pollInterval: NodeJS.Timeout | null = null
  private currentState: LiveMatch | null = null
  private events: EventEmitter
  private serverId: string
  private map: string
  private team1Name: string
  private team2Name: string
  private maxRounds: number

  constructor(
    rconManager: RconManager,
    serverId: string,
    map: string,
    team1Name: string,
    team2Name: string,
    maxRounds: number,
    events: EventEmitter
  ) {
    this.rconManager = rconManager
    this.serverId = serverId
    this.map = map
    this.team1Name = team1Name
    this.team2Name = team2Name
    this.maxRounds = maxRounds
    this.events = events
  }

  start(intervalMs = 2000): void {
    if (this.pollInterval) return

    this.poll()
    this.pollInterval = setInterval(() => this.poll(), intervalMs)
    this.pollInterval.unref()
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = null
    }
    this.currentState = null
  }

  private async poll(): Promise<void> {
    try {
      const response = await this.rconManager.execute('status')
      const parsed = parseStatus(response)

      if (!parsed) return

      const phase = detectPhase(parsed.team1_score, parsed.team2_score, this.maxRounds, response)

      const newState: LiveMatch = {
        id: this.serverId,
        server_id: this.serverId,
        map: this.map,
        team1_name: this.team1Name,
        team1_score: parsed.team1_score,
        team2_name: this.team2Name,
        team2_score: parsed.team2_score,
        current_round: parsed.current_round,
        max_rounds: this.maxRounds,
        phase,
        players_alive: parsed.players,
        last_updated: Date.now()
      }

      // Emit only if state changed
      if (!this.stateChanged(this.currentState, newState)) {
        return
      }

      this.currentState = newState
      this.events.emit('match-updated', newState)
    } catch (err) {
      console.error(`[match-poller] poll failed for server ${this.serverId}:`, (err as Error).message)
    }
  }

  private stateChanged(oldState: LiveMatch | null, newState: LiveMatch): boolean {
    if (!oldState) return true

    return (
      oldState.team1_score !== newState.team1_score ||
      oldState.team2_score !== newState.team2_score ||
      oldState.current_round !== newState.current_round ||
      oldState.phase !== newState.phase ||
      oldState.players_alive.team1 !== newState.players_alive.team1 ||
      oldState.players_alive.team2 !== newState.players_alive.team2
    )
  }

  getState(): LiveMatch | null {
    return this.currentState
  }
}
