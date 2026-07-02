// End-to-end smoke test for the CS2 launcher backend.
//
// Owns the entire lifecycle so it is deterministic and repeatable (unlike
// hand-typed curls against a backgrounded server): it boots the backend on an
// ephemeral port with a throwaway SQLite DB and a fake CS2 binary, drives the
// full login -> launch -> stop -> clear path over real HTTP + WebSocket,
// asserts each step, then tears everything down. Exits non-zero on first
// failure.
//
//   node test/smoke.mjs
//
// Requires Node >= 22.5 (backend uses node:sqlite) and the backend's deps
// installed (tsx + ws are pulled from node_modules).

import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import { WebSocket } from 'ws'

const __dirname = dirname(fileURLToPath(import.meta.url))
const backendDir = resolve(__dirname, '..')

// --- tiny assertion harness --------------------------------------------------
let passed = 0
function ok(cond, label) {
  if (cond) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    throw new Error(`assertion failed: ${label}`)
  }
}

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer()
    s.on('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => res(port))
    })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// signal-0 liveness probe (same technique the backend uses).
function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

// Poll until the predicate holds or we time out — the backend kills async.
async function until(fn, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return true
    await sleep(50)
  }
  return false
}

// Wait for a PID to disappear (process.kill is async on the backend side).
const waitPidDead = (pid) => until(() => !pidAlive(pid))

// Retry a fetch until the server is accepting connections (or time out).
async function waitForBoot(base, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      // Any HTTP response (even 401) means the listener is up.
      await fetch(`${base}/servers`)
      return
    } catch {
      await sleep(150)
    }
  }
  throw new Error('backend did not start within timeout')
}

// Resolve one WS message (or reject on close/timeout).
function wsFirstMessage(url, timeoutMs = 5000) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => {
      ws.terminate()
      rej(new Error('WS message timeout'))
    }, timeoutMs)
    ws.on('message', (data) => {
      clearTimeout(timer)
      ws.close()
      res(JSON.parse(data.toString()))
    })
    ws.on('close', (code) => {
      clearTimeout(timer)
      rej(new Error(`WS closed before message (code ${code})`))
    })
    ws.on('error', () => {
      /* close handler reports the outcome */
    })
  })
}

// Expect the WS handshake to be rejected (used for the no-token case).
function wsExpectClose(url, timeoutMs = 5000) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => {
      ws.terminate()
      rej(new Error('WS close timeout'))
    }, timeoutMs)
    ws.on('message', () => {
      clearTimeout(timer)
      ws.close()
      rej(new Error('WS unexpectedly received a message'))
    })
    ws.on('close', (code) => {
      clearTimeout(timer)
      res(code)
    })
    ws.on('error', () => {})
  })
}

async function main() {
  const workdir = mkdtempSync(join(tmpdir(), 'cs2-smoke-'))
  const dbPath = join(workdir, 'test.db')
  let fakePid // PID of the fake CS2 process, captured after launch

  // Fake CS2 binary: ignore all argv (the backend passes +game_type etc.) and
  // stay alive so the process shows up as "running" until we kill it.
  const fakeBin = join(workdir, 'fake-cs2.sh')
  writeFileSync(fakeBin, '#!/bin/sh\nexec sleep 3600\n', { mode: 0o755 })

  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const wsBase = `ws://127.0.0.1:${port}`

  // Launch via `node --import tsx` rather than the .bin/tsx shim: the shim's
  // execute bit is sometimes missing after install/copy (EACCES), whereas
  // process.execPath (node itself) is always runnable.
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: backendDir,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      JWT_SECRET: 'smoke-test-secret',
      SEED_USERNAME: 'admin',
      SEED_PASSWORD: 'test123',
      CS2_BIN: fakeBin,
      DB_PATH: dbPath,
      FIREWALL: 'off'
    },
    stdio: ['ignore', 'inherit', 'inherit']
  })

  let childExited = false
  child.on('exit', () => {
    childExited = true
  })

  const cleanup = () => {
    if (!childExited) child.kill('SIGKILL')
    // The fake CS2 process is detached (backend unref()s it), so reap it
    // directly in case a check failed before the stop step killed it.
    if (fakePid && pidAlive(fakePid)) {
      try {
        process.kill(fakePid, 'SIGKILL')
      } catch {}
    }
    try {
      rmSync(workdir, { recursive: true, force: true })
    } catch {}
  }

  try {
    await waitForBoot(base)
    console.log('backend up, running checks:')

    // 1. login: wrong creds -> 401
    let r = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrong' })
    })
    ok(r.status === 401, 'login with wrong password -> 401')

    // 2. login: correct creds -> token
    r = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'test123' })
    })
    ok(r.status === 200, 'login with correct password -> 200')
    const { token } = await r.json()
    ok(typeof token === 'string' && token.length > 0, 'login returns a token')
    const auth = { authorization: `Bearer ${token}` }

    // 3. protected route without token -> 401
    r = await fetch(`${base}/servers`)
    ok(r.status === 401, 'GET /servers without token -> 401')

    // 4. protected route with token -> empty list
    r = await fetch(`${base}/servers`, { headers: auth })
    ok(r.status === 200, 'GET /servers with token -> 200')
    let list = await r.json()
    ok(Array.isArray(list) && list.length === 0, 'server list starts empty')

    // 5. launch: missing field -> 400
    r = await fetch(`${base}/servers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ gameType: '0' })
    })
    ok(r.status === 400, 'launch with missing fields -> 400')

    // 6. launch: valid -> success with id + port
    r = await fetch(`${base}/servers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({
        gameType: '0',
        gameMode: '1',
        modeName: 'Competitive',
        map: 'de_dust2',
        mapLabel: 'Dust II'
      })
    })
    ok(r.status === 200, 'launch with valid body -> 200')
    const launch = await r.json()
    ok(launch.success === true, 'launch reports success')
    ok(typeof launch.id === 'string', 'launch returns an id')
    ok(typeof launch.port === 'number', 'launch returns a port')
    const serverId = launch.id

    // 7. list now shows one running server
    r = await fetch(`${base}/servers`, { headers: auth })
    list = await r.json()
    ok(list.length === 1, 'server list has one entry after launch')
    ok(list[0].status === 'running', 'launched server is running')
    ok(list[0].map === 'de_dust2', 'launched server has the right map')

    // The launched PID must be a real, live process (proves spawn worked).
    fakePid = list[0].pid
    ok(pidAlive(fakePid), 'launched process is actually alive')

    // 8. WS with no token -> closed (1008)
    const closeCode = await wsExpectClose(`${wsBase}/events`)
    ok(closeCode === 1008, 'WS without token closes with 1008')

    // 9. WS with token -> immediate snapshot
    const msg = await wsFirstMessage(`${wsBase}/events?token=${token}`)
    ok(msg.type === 'servers-updated', 'WS pushes servers-updated on connect')
    ok(Array.isArray(msg.servers) && msg.servers.length === 1, 'WS snapshot has the running server')

    // 10. stop the server
    r = await fetch(`${base}/servers/${serverId}/stop`, { method: 'POST', headers: auth })
    ok(r.status === 200, 'stop existing server -> 200')

    // The real proof stop worked: the underlying process is gone.
    ok(await waitPidDead(fakePid), 'stopped process is actually dead')

    // 11. stopping an unknown id -> 404
    r = await fetch(`${base}/servers/does-not-exist/stop`, { method: 'POST', headers: auth })
    ok(r.status === 404, 'stop unknown server -> 404')

    // 12. list shows the server stopped
    r = await fetch(`${base}/servers`, { headers: auth })
    list = await r.json()
    ok(list.length === 1 && list[0].status === 'stopped', 'server is marked stopped')

    // 13. clear stopped -> empty list
    r = await fetch(`${base}/servers/stopped`, { method: 'DELETE', headers: auth })
    ok(r.status === 200, 'clear stopped -> 200')
    r = await fetch(`${base}/servers`, { headers: auth })
    list = await r.json()
    ok(list.length === 0, 'server list empty after clear')

    console.log(`\nSMOKE PASSED (${passed} checks)`)
  } finally {
    cleanup()
  }
}

main().catch((err) => {
  console.error(`\nSMOKE FAILED: ${err.message}`)
  process.exit(1)
})
