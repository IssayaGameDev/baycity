import {
  decodePong,
  decodeSnapshot,
  decodeWelcome,
  encodePing,
  encodeState,
  MSG_PONG,
  MSG_SNAPSHOT,
  MSG_WELCOME,
  readMessageType,
} from '@mp/net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startServer, type ServerHandle } from './index'

const TEST_PORT = 9250

describe('relay end-to-end', () => {
  let server: ServerHandle

  beforeAll(async () => {
    server = await startServer({ port: TEST_PORT })
  })
  afterAll(async () => {
    await server.stop()
  })

  it('assigns ids and relays one client’s state to another', async () => {
    // Client A: on welcome, continuously report a fixed, distinctive position.
    const a = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`)
    a.binaryType = 'arraybuffer'
    let aId = -1
    const A_POS = { x: 7.5, y: 1, z: -3.25 }
    let aTimer: ReturnType<typeof setInterval> | null = null
    a.onmessage = (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) return
      if (readMessageType(ev.data) === MSG_WELCOME) {
        aId = decodeWelcome(ev.data).playerId
        aTimer = setInterval(() => a.send(encodeState(A_POS)), 1000 / 30)
      }
    }

    // Client B: connects after A is reporting; should see A appear in a snapshot.
    const seenA = await new Promise<{ x: number; y: number; z: number }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('B never saw A')), 6000)
      const connectB = (): void => {
        const b = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`)
        b.binaryType = 'arraybuffer'
        let bId = -1
        b.onmessage = (ev) => {
          if (!(ev.data instanceof ArrayBuffer)) return
          const type = readMessageType(ev.data)
          if (type === MSG_WELCOME) {
            bId = decodeWelcome(ev.data).playerId
          } else if (type === MSG_SNAPSHOT) {
            // B's first snapshot is a full, so `changed` holds all peers (just A).
            const snap = decodeSnapshot(ev.data)
            const other = snap.changed.find((e) => e.id !== bId)
            if (other) {
              clearTimeout(timeout)
              b.close()
              resolve(other.position)
            }
          }
        }
        b.onerror = () => {
          clearTimeout(timeout)
          reject(new Error('B socket error'))
        }
      }
      // Give A a moment to be assigned and start reporting.
      setTimeout(connectB, 400)
    })

    if (aTimer) clearInterval(aTimer)
    a.close()

    expect(aId).toBeGreaterThanOrEqual(1000) // players use ids >= 1000
    // B received A's relayed position (quantized, ~1cm tolerance).
    expect(seenA.x).toBeCloseTo(A_POS.x, 2)
    expect(seenA.y).toBeCloseTo(A_POS.y, 2)
    expect(seenA.z).toBeCloseTo(A_POS.z, 2)
  })

  it('answers a clock-sync ping with the echoed time and its server time', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`)
    ws.binaryType = 'arraybuffer'
    const CLIENT_TIME = 424242

    const pong = await new Promise<{ clientTimeMs: number; serverTimeMs: number }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('no pong')), 4000)
      ws.onopen = () => ws.send(encodePing({ clientTimeMs: CLIENT_TIME }))
      ws.onmessage = (ev) => {
        if (!(ev.data instanceof ArrayBuffer)) return
        if (readMessageType(ev.data) !== MSG_PONG) return
        clearTimeout(timeout)
        const p = decodePong(ev.data)
        ws.close()
        resolve(p)
      }
      ws.onerror = () => {
        clearTimeout(timeout)
        reject(new Error('client socket error'))
      }
    })

    expect(pong.clientTimeMs).toBe(CLIENT_TIME) // echoed back for RTT
    expect(pong.serverTimeMs).toBeGreaterThan(0) // server advanced its clock
  })
})
