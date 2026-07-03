import { existsSync, readdirSync, rmSync, mkdirSync, createWriteStream } from 'node:fs'
import { join, basename } from 'node:path'
import { pipeline } from 'node:stream/promises'
import https from 'node:https'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { config } from './config.js'

const execFileAsync = promisify(execFile)

export interface PluginInfo {
  name: string
}

function pluginsDir(): string {
  if (!config.pluginsDir) {
    throw new Error('PLUGINS_DIR is not configured')
  }
  return config.pluginsDir
}

export function listPlugins(): PluginInfo[] {
  const dir = pluginsDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name }))
}

export async function installPlugin(url: string): Promise<{ name: string }> {
  const dir = pluginsDir()
  mkdirSync(dir, { recursive: true })

  const tmpPath = join(dir, `_tmp_${Date.now()}.zip`)
  await downloadFile(url, tmpPath)

  // List top-level dirs before extracting to find the plugin name
  const { stdout } = await execFileAsync('unzip', ['-Z1', tmpPath])
  const topDirs = new Set<string>()
  for (const line of stdout.split('\n')) {
    const top = line.trim().split('/')[0]
    if (top) topDirs.add(top)
  }

  await execFileAsync('unzip', ['-o', tmpPath, '-d', dir])
  rmSync(tmpPath)

  const name = topDirs.size >= 1 ? [...topDirs][0] : basename(url, '.zip')
  return { name }
}

export function deletePlugin(name: string): void {
  if (name.includes('/') || name.includes('..') || name.startsWith('.')) {
    throw new Error('Invalid plugin name')
  }
  const target = join(pluginsDir(), name)
  if (!existsSync(target)) {
    throw new Error(`Plugin not found: ${name}`)
  }
  rmSync(target, { recursive: true, force: true })
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest)
    const proto = url.startsWith('https') ? https : http
    const request = proto.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close()
        rmSync(dest, { force: true })
        downloadFile(res.headers.location!, dest).then(resolve).catch(reject)
        return
      }
      if (res.statusCode !== 200) {
        file.close()
        rmSync(dest, { force: true })
        reject(new Error(`HTTP ${res.statusCode} for ${url}`))
        return
      }
      pipeline(res, file).then(resolve).catch(reject)
    })
    request.on('error', (err) => {
      file.close()
      rmSync(dest, { force: true })
      reject(err)
    })
  })
}
