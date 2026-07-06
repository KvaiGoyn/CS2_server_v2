import { Socket } from 'node:net'

const PACKET_TYPE_AUTH = 3
const PACKET_TYPE_AUTH_RESPONSE = 2
const PACKET_TYPE_EXECCOMMAND = 2
const PACKET_TYPE_RESPONSE_VALUE = 0

interface PendingExec {
  requestId: number
  chunks: string[]
  resolve: (value: string) => void
  reject: (err: Error) => void
  timeout: NodeJS.Timeout
  quietTimer: NodeJS.Timeout | null
}

function encodePacket(id: number, type: number, body: string): Buffer {
  const bodyBuf = Buffer.from(body, 'utf-8')
  const payloadSize = 4 + 4 + bodyBuf.length + 2
  const buf = Buffer.alloc(4 + payloadSize)
  buf.writeInt32LE(payloadSize, 0)
  buf.writeInt32LE(id, 4)
  buf.writeInt32LE(type, 8)
  bodyBuf.copy(buf, 12)
  buf.writeUInt8(0, 12 + bodyBuf.length)
  buf.writeUInt8(0, 12 + bodyBuf.length + 1)
  return buf
}

/**
 * Minimal Source RCON client. The `rcon` npm package can't be installed in
 * this environment (registry access is blocked) and the wire protocol is
 * small, so it's implemented directly here.
 *
 * Multi-packet responses are collected with a "quiet period" approach: every
 * SERVERDATA_RESPONSE_VALUE packet matching a pending request's id resets a
 * short timer, and the response resolves once no more packets arrive for
 * quietMs. This avoids the classic "mirror packet" trick (send an empty
 * EXECCOMMAND right after and wait for its echo), which is unreliable here —
 * CS2 does not guarantee it processes/replies to queued commands in the order
 * they were sent, so the empty marker's response can race ahead of the real
 * command's data and get misread as "response complete, no data".
 */
export class RconManager {
  private socket: Socket | null = null
  private authPromise: Promise<void> | null = null
  private authResolved: { resolve: () => void; reject: (err: Error) => void } | null = null
  private buffer = Buffer.alloc(0)
  private nextId = 1
  private pendingExecs = new Map<number, PendingExec>()
  private readonly execTimeoutMs = 8000
  private readonly quietMs = 150

  constructor(
    private readonly port: number,
    private readonly password: string,
    private readonly host: string = '127.0.0.1'
  ) {}

  private ensureConnected(): Promise<void> {
    if (this.authPromise) return this.authPromise

    this.authPromise = new Promise<void>((resolve, reject) => {
      const socket = new Socket()
      socket.setNoDelay(true)
      this.authResolved = { resolve, reject }

      socket.on('data', (chunk) => this.onData(chunk))
      socket.once('error', (err) => this.failAll(err))
      socket.once('close', () => {
        this.failAll(new Error('RCON connection closed'))
        this.socket = null
        this.authPromise = null
      })
      socket.connect(this.port, this.host, () => {
        this.socket = socket
        socket.write(encodePacket(0, PACKET_TYPE_AUTH, this.password))
      })
    })

    return this.authPromise
  }

  private failAll(err: Error): void {
    if (this.authResolved) {
      this.authResolved.reject(err)
      this.authResolved = null
    }
    for (const pending of this.pendingExecs.values()) {
      clearTimeout(pending.timeout)
      pending.reject(err)
    }
    this.pendingExecs.clear()
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])

    while (this.buffer.length >= 4) {
      const size = this.buffer.readInt32LE(0)
      if (this.buffer.length < 4 + size) break

      const packet = this.buffer.subarray(4, 4 + size)
      this.buffer = this.buffer.subarray(4 + size)

      const id = packet.readInt32LE(0)
      const type = packet.readInt32LE(4)
      const body = packet.subarray(8, packet.length - 2).toString('utf-8')
      this.handlePacket(id, type, body)
    }
  }

  private handlePacket(id: number, type: number, body: string): void {
    if (type === PACKET_TYPE_AUTH_RESPONSE) {
      if (!this.authResolved) return
      const { resolve, reject } = this.authResolved
      this.authResolved = null
      if (id === -1) {
        reject(new Error('RCON authentication failed (wrong password)'))
      } else {
        resolve()
      }
      return
    }

    if (type !== PACKET_TYPE_RESPONSE_VALUE) return

    const pending = this.pendingExecs.get(id)
    if (!pending) return

    pending.chunks.push(body)

    // Reset the quiet-period timer: as long as packets keep arriving for
    // this request, keep waiting. Resolve once nothing arrives for
    // quietMs, since CS2 gives no explicit "end of response" marker.
    if (pending.quietTimer) clearTimeout(pending.quietTimer)
    pending.quietTimer = setTimeout(() => {
      clearTimeout(pending.timeout)
      this.pendingExecs.delete(id)
      pending.resolve(pending.chunks.join(''))
    }, this.quietMs)
  }

  async execute(command: string): Promise<string> {
    await this.ensureConnected()
    const socket = this.socket
    if (!socket) throw new Error('RCON socket not available')

    const requestId = this.nextId++

    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingExecs.get(requestId)
        if (pending?.quietTimer) clearTimeout(pending.quietTimer)
        this.pendingExecs.delete(requestId)
        reject(new Error(`RCON command timed out: ${command}`))
      }, this.execTimeoutMs)

      this.pendingExecs.set(requestId, { requestId, chunks: [], resolve, reject, timeout, quietTimer: null })

      socket.write(encodePacket(requestId, PACKET_TYPE_EXECCOMMAND, command))
    })
  }

  close(): void {
    this.failAll(new Error('RCON connection closed'))
    this.socket?.destroy()
    this.socket = null
    this.authPromise = null
  }
}
