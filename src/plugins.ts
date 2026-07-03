import {
  existsSync,
  readdirSync,
  rmSync,
  mkdirSync,
  createWriteStream,
  renameSync,
  cpSync
} from 'node:fs'
import { join, basename, dirname } from 'node:path'
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

// Root of the CS2 csgo/ tree. Full-tree zips (MatchZy et al.) unpack here so
// their addons/*, cfg/*, gamedata/* land in the right places.
function csgoDir(): string {
  if (!config.csgoDir) {
    throw new Error('CSGO_DIR is not configured')
  }
  return config.csgoDir
}

function pluginsDir(): string {
  return join(csgoDir(), 'addons', 'counterstrikesharp', 'plugins')
}

function configsDir(): string {
  return join(csgoDir(), 'addons', 'counterstrikesharp', 'configs', 'plugins')
}

function gamedataDir(): string {
  return join(csgoDir(), 'addons', 'counterstrikesharp', 'gamedata')
}

export function listPlugins(): PluginInfo[] {
  const dir = pluginsDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name }))
}

// Two zip layouts we support:
//   A (simple):    <PluginName>/PluginName.dll                → extracted into plugins/
//   B (full tree): addons/counterstrikesharp/plugins/<Name>/  → extracted into csgo/
//                  (may also carry addons/.../configs/, gamedata/, cfg/)
type ZipLayout =
  | { kind: 'simple'; pluginName: string }
  | { kind: 'full-tree'; pluginName: string }

function detectLayout(entries: string[], urlHint: string): ZipLayout {
  // Look for CSSharp plugin dir inside the zip.
  const rx = /^addons\/counterstrikesharp\/plugins\/([^\/]+)\//i
  for (const entry of entries) {
    const m = entry.match(rx)
    if (m) return { kind: 'full-tree', pluginName: m[1] }
  }

  // Simple layout: use the first top-level directory as the plugin name.
  const topDirs = new Set<string>()
  for (const entry of entries) {
    const top = entry.split('/')[0]
    if (top) topDirs.add(top)
  }
  const name = topDirs.size >= 1 ? [...topDirs][0] : basename(urlHint, '.zip')
  return { kind: 'simple', pluginName: name }
}

export async function installPlugin(url: string): Promise<{ name: string }> {
  const plugins = pluginsDir()
  mkdirSync(plugins, { recursive: true })

  // Work in a scratch dir OUTSIDE plugins/ so a failed install doesn't leak
  // half-extracted files that listPlugins() would then show as "plugins".
  const scratchRoot = join(csgoDir(), '.launcher-scratch')
  mkdirSync(scratchRoot, { recursive: true })
  const tmpDir = join(scratchRoot, `install_${Date.now()}`)
  const tmpZip = `${tmpDir}.zip`
  mkdirSync(tmpDir, { recursive: true })

  try {
    await downloadFile(url, tmpZip)

    const { stdout } = await execFileAsync('unzip', ['-Z1', tmpZip])
    const entries = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
    const layout = detectLayout(entries, url)

    await execFileAsync('unzip', ['-o', tmpZip, '-d', tmpDir])

    if (layout.kind === 'full-tree') {
      // Merge the zip's tree into csgo/. We only touch directories the zip
      // itself provides, so unrelated CS2 files are untouched.
      cpSync(tmpDir, csgoDir(), { recursive: true, force: true })
    } else {
      // Simple: extract straight into plugins/<PluginName>/.
      // The zip's top-level dir already IS <PluginName>/, so copy tmpDir/* → plugins/.
      cpSync(tmpDir, plugins, { recursive: true, force: true })
    }

    return { name: layout.pluginName }
  } finally {
    // Always clean scratch, even on failure.
    rmSync(tmpZip, { force: true })
    rmSync(tmpDir, { recursive: true, force: true })
    // Best-effort: remove scratchRoot if empty.
    try {
      const remaining = readdirSync(scratchRoot)
      if (remaining.length === 0) rmSync(scratchRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

export function deletePlugin(name: string): void {
  if (name.includes('/') || name.includes('..') || name.startsWith('.')) {
    throw new Error('Invalid plugin name')
  }
  const pluginPath = join(pluginsDir(), name)
  if (!existsSync(pluginPath)) {
    throw new Error(`Plugin not found: ${name}`)
  }
  rmSync(pluginPath, { recursive: true, force: true })

  // Best-effort: also drop the plugin's configs/ dir so a reinstall starts
  // clean. Gamedata files are shared/global — leave them alone.
  const cfg = join(configsDir(), name)
  if (existsSync(cfg)) {
    rmSync(cfg, { recursive: true, force: true })
  }
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    mkdirSync(dirname(dest), { recursive: true })
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
