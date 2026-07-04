import { spawn } from 'node:child_process'
import { config } from './config.js'

export interface SteamUpdateResult {
  success: boolean
  output: string
  error?: string
}

/**
 * Update the CS2 dedicated server install via SteamCMD before launch.
 *
 * Best-effort: a failed or timed-out update does not throw. The caller
 * launches CS2 on whatever bits are on disk either way — an update check
 * failing must never block starting a match.
 */
export function updateCs2Server(): Promise<SteamUpdateResult> {
  return new Promise((resolvePromise) => {
    const args = [
      '+force_install_dir',
      config.cs2InstallDir,
      '+login',
      'anonymous',
      '+app_update',
      config.cs2AppId,
      '+quit'
    ]

    let child
    try {
      child = spawn(config.steamCmdBin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      resolvePromise({ success: false, output: '', error: (err as Error).message })
      return
    }

    let output = ''
    child.stdout?.on('data', (chunk) => (output += chunk.toString()))
    child.stderr?.on('data', (chunk) => (output += chunk.toString()))

    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGTERM')
      resolvePromise({
        success: false,
        output,
        error: `steamcmd timed out after ${config.steamCmdTimeoutMs}ms`
      })
    }, config.steamCmdTimeoutMs)
    timer.unref()

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ success: false, output, error: err.message })
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) {
        resolvePromise({ success: true, output })
      } else {
        resolvePromise({ success: false, output, error: `steamcmd exited with code ${code}` })
      }
    })
  })
}
