import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import websocket from '@fastify/websocket'
import { config } from './config.js'
import { authenticate, seedFirstUser } from './auth.js'
import {
  clearStopped,
  events,
  getServers,
  launchServer,
  startReconcileLoop,
  stopServer,
  type LaunchInput
} from './manager.js'
import type { ServerRow } from './db.js'

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

  const result = launchServer({
    gameType: body.gameType as string,
    gameMode: body.gameMode as string,
    modeName: body.modeName as string,
    map: body.map as string,
    mapLabel: body.mapLabel as string
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

    send(getServers())
    const listener = (servers: ServerRow[]): void => send(servers)
    events.on('servers-updated', listener)

    socket.on('close', () => {
      events.off('servers-updated', listener)
    })
  })
})

// --- Boot ---
async function start(): Promise<void> {
  const created = await seedFirstUser()
  if (created) {
    app.log.info(`Seeded first user "${config.seedUsername}" (change the password!)`)
  }

  startReconcileLoop()

  try {
    await app.listen({ host: config.host, port: config.port })
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

start()
