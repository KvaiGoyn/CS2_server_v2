import { Socket } from 'node:net'

const PACKET_TYPE_AUTH = 3
const PACKET_TYPE_AUTH_RESPONSE = 2
const PACKET_TYPE_EXECCOMMAND = 2
const PACKET_TYPE_RESPONSE_VALUE = 0

interface PendingExec {
  requestId: number
  mirrorId: number
  chunks: string[]
  resolve: (value: string) => void
  reject: (err: Error) => void
  timeout: NodeJS.Timeout
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
 * small, so it's implemented directly here. Multi-packet responses are
 * detected with the standard "mirror packet" trick: a second, empty
 * EXECCOMMAND is sent right after the real one, and everything received
 * before its echo comes back belongs to the real response.
 */
export class RconManager {
  private socket: Socket | null = null
  private authPromise: Promise<void> | null = null
  private authResolved: { resolve: () => void; reject: (err: Error) => void } | null = null
  private buffer = Buffer.alloc(0)
  private nextId = 1
  private pendingExecs = new Map<number, PendingExec>()
  private readonly host = '127.0.0.1'
  private readonly execTimeoutMs = 8000

  constructor(
    private readonly port: number,
    private readonly password: string
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

    for (const pending of this.pendingExecs.values()) {
      if (id === pending.requestId) {
        pending.chunks.push(body)
        return
      }
      if (id === pending.mirrorId) {
        clearTimeout(pending.timeout)
        this.pendingExecs.delete(pending.requestId)
        pending.resolve(pending.chunks.join(''))
        return
      }
    }
  }

  async execute(command: string): Promise<string> {
    await this.ensureConnected()
    const socket = this.socket
    if (!socket) throw new Error('RCON socket not available')

    const requestId = this.nextId++
    const mirrorId = this.nextId++

    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingExecs.delete(requestId)
        reject(new Error(`RCON command timed out: ${command}`))
      }, this.execTimeoutMs)

      this.pendingExecs.set(requestId, { requestId, mirrorId, chunks: [], resolve, reject, timeout })

      socket.write(encodePacket(requestId, PACKET_TYPE_EXECCOMMAND, command))
      socket.write(encodePacket(mirrorId, PACKET_TYPE_EXECCOMMAND, ''))
    })
  }

  close(): void {
    this.failAll(new Error('RCON connection closed'))
    this.socket?.destroy()
    this.socket = null
    this.authPromise = null
  }
}
