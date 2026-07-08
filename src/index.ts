import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import websocket from '@fastify/websocket'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { config } from './config.js'
import { authenticate, seedFirstUser } from './auth.js'
import {
  clearStopped,
  events,
  getServers,
  getLiveMatches,
  launchServer,
  startReconcileLoop,
  stopServer,
  executeRconCommand,
  type LaunchInput
} from './manager.js'
import type { LiveMatch } from './match-poller.js'
import { listPlugins, installPlugin, deletePlugin } from './plugins.js'
import {
  insertPreset,
  listPresets,
  getPreset,
  updatePreset,
  deletePreset,
  seedDefaultPresets,
  insertMatchConfig,
  listMatchConfigs,
  getMatchConfig,
  updateMatchConfig,
  deleteMatchConfig,
  type PresetRow,
  type MatchConfigRow
} from './db.js'
import type { ServerRow } from './db.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const publicPath = join(__dirname, '../out/renderer')

// JWT payload shape we sign and expect back.
interface TokenPayload {
  sub: string
}

const app = Fastify({
  logger: {
    // The WS token arrives as ?token=<jwt>. Strip the query string from
    // request logs so valid JWTs never land in journald/log files.
    serializers: {
      req(request) {
        return {
          method: request.method,
          url: request.url.split('?')[0],
          host: request.headers.host
        }
      }
    }
  }
})

// --- Plugins ---
// CORS: the Electron renderer loads from file:// (prod) or the Vite dev URL,
// so requests to this backend are cross-origin. Reflect origin; auth is by
// bearer token, not cookies, so credentialed CORS is unnecessary.
await app.register(cors, { origin: true })

await app.register(jwt, { secret: config.jwtSecret })

await app.register(websocket)

// --- Auth guard for HTTP routes ---
async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await req.jwtVerify()
  } catch {
    await reply.code(401).send({ error: 'Unauthorized' })
  }
}

// --- Routes ---

// Public: exchange credentials for a JWT access token.
app.post('/auth/login', async (req, reply) => {
  const body = (req.body ?? {}) as { username?: unknown; password?: unknown }
  const username = typeof body.username === 'string' ? body.username : ''
  const password = typeof body.password === 'string' ? body.password : ''

  if (!username || !password) {
    return reply.code(400).send({ error: 'username and password are required' })
  }

  const who = await authenticate(username, password)
  if (!who) {
    return reply.code(401).send({ error: 'Invalid credentials' })
  }

  const payload: TokenPayload = { sub: who }
  const token = await reply.jwtSign(payload, { expiresIn: config.jwtTtl })
  return { token, username: who }
})

// All /servers routes require a valid token.
app.get('/servers', { preHandler: requireAuth }, async () => {
  return getServers()
})

app.post('/servers', { preHandler: requireAuth }, async (req, reply) => {
  const body = (req.body ?? {}) as Partial<Record<keyof LaunchInput, unknown>>
  const fields: (keyof LaunchInput)[] = ['gameType', 'gameMode', 'modeName', 'map', 'mapLabel']

  for (const f of fields) {
    if (typeof body[f] !== 'string' || (body[f] as string).length === 0) {
      return reply.code(400).send({ error: `Missing or invalid field: ${f}` })
    }
  }

  const result = await launchServer({
    gameType: body.gameType as string,
    gameMode: body.gameMode as string,
    modeName: body.modeName as string,
    map: body.map as string,
    mapLabel: body.mapLabel as string,
    presetId: typeof body.presetId === 'string' ? body.presetId : undefined,
    matchConfigId: typeof body.matchConfigId === 'string' ? body.matchConfigId : undefined
  })

  if (!result.success) {
    return reply.code(500).send(result)
  }
  return result
})

app.post('/servers/:id/stop', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string }
  const result = stopServer(id)
  if (!result.success) {
    return reply.code(404).send(result)
  }
  return result
})

app.delete('/servers/stopped', { preHandler: requireAuth }, async () => {
  return clearStopped()
})

// --- Plugin routes ---

app.get('/plugins', { preHandler: requireAuth }, async () => {
  return listPlugins()
})

app.post('/plugins/install', { preHandler: requireAuth }, async (req, reply) => {
  const body = (req.body ?? {}) as { url?: unknown }
  if (typeof body.url !== 'string' || !body.url) {
    return reply.code(400).send({ error: 'url is required' })
  }
  try {
    const result = await installPlugin(body.url)
    return result
  } catch (err) {
    return reply.code(500).send({ error: (err as Error).message })
  }
})

app.delete('/plugins/:name', { preHandler: requireAuth }, async (req, reply) => {
  const { name } = req.params as { name: string }
  try {
    deletePlugin(name)
    return { success: true }
  } catch (err) {
    return reply.code(404).send({ error: (err as Error).message })
  }
})

// --- Preset routes ---

app.get('/presets', { preHandler: requireAuth }, async () => {
  return listPresets()
})

app.post('/presets', { preHandler: requireAuth }, async (req, reply) => {
  const body = (req.body ?? {}) as Partial<PresetRow>
  const required = ['name', 'gameType', 'gameMode', 'map', 'configContent']

  for (const f of required) {
    if (typeof body[f as keyof PresetRow] !== 'string' || (body[f as keyof PresetRow] as string).length === 0) {
      return reply.code(400).send({ error: `Missing or invalid field: ${f}` })
    }
  }

  try {
    const { randomUUID } = await import('node:crypto')
    const id = randomUUID()
    insertPreset({
      id,
      name: body.name as string,
      description: body.description ?? '',
      gameType: body.gameType as string,
      gameMode: body.gameMode as string,
      map: body.map as string,
      configContent: body.configContent as string,
      createdAt: Date.now()
    })
    return { success: true, id }
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message })
  }
})

app.get('/presets/:id', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string }
  const preset = getPreset(id)
  if (!preset) {
    return reply.code(404).send({ error: 'Preset not found' })
  }
  return preset
})

app.put('/presets/:id', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string }
  const preset = getPreset(id)
  if (!preset) {
    return reply.code(404).send({ error: 'Preset not found' })
  }

  const body = (req.body ?? {}) as Partial<PresetRow>
  try {
    updatePreset(id, {
      name: body.name ?? preset.name,
      description: body.description ?? preset.description,
      gameType: body.gameType ?? preset.gameType,
      gameMode: body.gameMode ?? preset.gameMode,
      map: body.map ?? preset.map,
      configContent: body.configContent ?? preset.configContent
    })
    return { success: true }
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message })
  }
})

app.delete('/presets/:id', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string }
  const preset = getPreset(id)
  if (!preset) {
    return reply.code(404).send({ error: 'Preset not found' })
  }
  deletePreset(id)
  return { success: true }
})

// --- Match Config routes ---

app.get('/match-configs', { preHandler: requireAuth }, async () => {
  return listMatchConfigs()
})

app.post('/match-configs', { preHandler: requireAuth }, async (req, reply) => {
  const body = (req.body ?? {}) as Partial<MatchConfigRow>
  const required = ['name', 'map', 'team1_name', 'team2_name']

  for (const f of required) {
    if (typeof body[f as keyof MatchConfigRow] !== 'string' || (body[f as keyof MatchConfigRow] as string).length === 0) {
      return reply.code(400).send({ error: `Missing or invalid field: ${f}` })
    }
  }

  try {
    const { randomUUID } = await import('node:crypto')
    const id = randomUUID()
    insertMatchConfig({
      id,
      name: body.name as string,
      description: body.description ?? '',
      map: body.map as string,
      team1_name: body.team1_name as string,
      team2_name: body.team2_name as string,
      convars: body.convars ?? '{}',
      createdAt: Date.now()
    })
    return { success: true, id }
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message })
  }
})

app.get('/match-configs/:id', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string }
  const config = getMatchConfig(id)
  if (!config) {
    return reply.code(404).send({ error: 'Match config not found' })
  }
  return config
})

app.put('/match-configs/:id', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string }
  const config = getMatchConfig(id)
  if (!config) {
    return reply.code(404).send({ error: 'Match config not found' })
  }

  const body = (req.body ?? {}) as Partial<MatchConfigRow>
  try {
    updateMatchConfig(id, {
      name: body.name ?? config.name,
      description: body.description ?? config.description,
      map: body.map ?? config.map,
      team1_name: body.team1_name ?? config.team1_name,
      team2_name: body.team2_name ?? config.team2_name,
      convars: body.convars ?? config.convars
    })
    return { success: true }
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message })
  }
})

app.delete('/match-configs/:id', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string }
  const config = getMatchConfig(id)
  if (!config) {
    return reply.code(404).send({ error: 'Match config not found' })
  }
  deleteMatchConfig(id)
  return { success: true }
})

// --- RCON routes ---

app.post('/servers/:id/rcon', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string }
  const body = (req.body ?? {}) as { command?: unknown }

  if (typeof body.command !== 'string' || !body.command.trim()) {
    return reply.code(400).send({ error: 'command is required' })
  }

  const result = await executeRconCommand(id, body.command)
  if (!result.success) {
    // Send { error } so the client's request() wrapper surfaces the real
    // reason (e.g. "RCON not available for this server") in ApiError.message.
    return reply.code(500).send({ error: result.message ?? 'RCON command failed' })
  }
  return result
})

// --- Live match routes ---

app.get('/live-matches', { preHandler: requireAuth }, async () => {
  return getLiveMatches()
})

// --- MatchZy webhook (remote_log) ---
// MatchZy can't hold a JWT, so this route is authenticated with a shared
// secret sent via the x-matchzy-secret header (matchzy_remote_log_header_key
// /value cvars in the generated match JSON) instead of requireAuth.
app.post('/webhooks/matchzy/:serverId', async (req, reply) => {
  const { serverId } = req.params as { serverId: string }
  const secret = req.headers['x-matchzy-secret']

  if (secret !== config.matchzyWebhookSecret) {
    return reply.code(401).send({ error: 'invalid webhook secret' })
  }

  console.log(`[matchzy-webhook] ${serverId}`, JSON.stringify(req.body))
  return { success: true }
})

// --- Static file serving for SPA ---
const rendererPath = join(__dirname, '../out/renderer')
console.log(`[static] serving frontend from: ${rendererPath}`)

function getMimeType(filePath: string): string {
  if (filePath.endsWith('.js')) return 'application/javascript'
  if (filePath.endsWith('.css')) return 'text/css'
  if (filePath.endsWith('.html')) return 'text/html'
  if (filePath.endsWith('.png')) return 'image/png'
  if (filePath.endsWith('.jpg')) return 'image/jpeg'
  if (filePath.endsWith('.svg')) return 'image/svg+xml'
  if (filePath.endsWith('.woff2')) return 'font/woff2'
  return 'application/octet-stream'
}

app.get('/', async (req, reply) => {
  const indexPath = join(rendererPath, 'index.html')
  console.log(`[static] GET / checking: ${indexPath} exists=${existsSync(indexPath)}`)
  if (existsSync(indexPath)) {
    const content = readFileSync(indexPath)
    reply.type('text/html')
    return reply.send(content)
  }
  return reply.code(404).send({ error: 'Frontend not built' })
})

app.get('/assets/*', async (req, reply) => {
  const filePath = join(rendererPath, 'assets', (req.params as { '*': string })['*'])
  if (existsSync(filePath)) {
    const content = readFileSync(filePath)
    reply.type(getMimeType(filePath))
    return reply.send(content)
  }
  return reply.code(404).send({ error: 'Asset not found' })
})

// Fallback: any other route -> index.html (for SPA routing)
app.get('/*', async (req, reply) => {
  const indexPath = join(rendererPath, 'index.html')
  if (existsSync(indexPath)) {
    const content = readFileSync(indexPath)
    reply.type('text/html')
    return reply.send(content)
  }
  return reply.code(404).send({ error: 'Frontend not built' })
})

// --- WebSocket: live server-status stream ---
// Browsers/Electron can't set Authorization on a WS handshake, so the token
// comes in as ?token=<jwt> and is verified before the socket is accepted.
app.register(async (scoped) => {
  // @fastify/websocket v10 passes the ws.WebSocket directly as the first arg
  // (the v8 `{ socket }` connection wrapper was removed). Use it as the socket.
  scoped.get('/events', { websocket: true }, (socket, req) => {
    const token = (req.query as { token?: string }).token
    try {
      if (!token) throw new Error('missing token')
      app.jwt.verify<TokenPayload>(token)
    } catch {
      socket.close(1008, 'Unauthorized')
      return
    }

    // Push the current snapshot immediately, then on every change.
    const send = (servers: ServerRow[]): void => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: 'servers-updated', servers }))
      }
    }

    const sendMatch = (match: LiveMatch): void => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: 'match-updated', match }))
      }
    }

    send(getServers())
    for (const match of getLiveMatches()) sendMatch(match)

    const listener = (servers: ServerRow[]): void => send(servers)
    const matchListener = (match: LiveMatch): void => sendMatch(match)
    events.on('servers-updated', listener)
    events.on('match-updated', matchListener)

    socket.on('close', () => {
      events.off('servers-updated', listener)
      events.off('match-updated', matchListener)
    })
  })
})

// --- Boot ---
async function start(): Promise<void> {
  const created = await seedFirstUser()
  if (created) {
    app.log.info(`Seeded first user "${config.seedUsername}" (change the password!)`)
  }

  seedDefaultPresets()

  startReconcileLoop()

  try {
    await app.listen({ host: config.host, port: config.port })
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

start()
