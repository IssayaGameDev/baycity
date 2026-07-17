import {
  decodePong,
  decodeSnapshot,
  decodeWelcome,
  encodeInput,
  encodePing,
  MSG_PONG,
  MSG_SNAPSHOT,
  MSG_WELCOME,
  readMessageType,
} from '@mp/net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startServer, type ServerHandle } from './index'

const TEST_PORT = 9250

describe('prediction end-to-end', () => {
  let server: ServerHandle

  beforeAll(async () => {
    server = await startServer({ port: TEST_PORT })
  })
  afterAll(async () => {
    await server.stop()
  })

  it('assigns a player, drives it from inputs, and echoes the processed sequence', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`)
    ws.binaryType = 'arraybuffer'
    let playerId = -1
    let ackSeq = 0
    let seq = 0
    const playerX: number[] = []
    let inputTimer: ReturnType<typeof setInterval> | null = null

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timeout waiting for movement')), 6000)
      const done = (): void => {
        clearTimeout(timeout)
        if (inputTimer) clearInterval(inputTimer)
        ws.close()
        resolve()
      }
      ws.onmessage = (ev) => {
        if (!(ev.data instanceof ArrayBuffer)) return
        const type = readMessageType(ev.data)
        if (type === MSG_WELCOME) {
          playerId = decodeWelcome(ev.data).playerId
          inputTimer = setInterval(() => ws.send(encodeInput({ seq: ++seq, moveX: 1, moveZ: 0 })), 1000 / 30)
        } else if (type === MSG_SNAPSHOT) {
          const snap = decodeSnapshot(ev.data)
          ackSeq = snap.lastProcessedInputSeq
          // the moving player is in `changed` every tick (full or delta)
          const me = snap.changed.find((e) => e.id === playerId)
          if (me) playerX.push(me.position.x)
          if (playerX.length >= 20) done()
        }
      }
      ws.onerror = () => {
        clearTimeout(timeout)
        reject(new Error('client socket error'))
      }
    })

    expect(playerId).toBeGreaterThanOrEqual(1000) // players use ids >= 1000
    expect(ackSeq).toBeGreaterThan(0) // server processed inputs and echoed the seq
    expect(playerX.length).toBeGreaterThanOrEqual(20)
    // Driving +x moves the authoritative player right over the sampled window.
    expect(playerX[playerX.length - 1]! - playerX[0]!).toBeGreaterThan(0.3)
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
