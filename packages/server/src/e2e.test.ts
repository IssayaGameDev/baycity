import { decodeSnapshot } from '@mp/net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startServer, type ServerHandle } from './index'

const TEST_PORT = 9250

describe('walking skeleton end-to-end', () => {
  let server: ServerHandle

  beforeAll(async () => {
    server = await startServer({ port: TEST_PORT })
  })
  afterAll(async () => {
    await server.stop()
  })

  it('streams the physics world (falling balls) to a connected WebSocket client', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`)
    ws.binaryType = 'arraybuffer'
    const firstBallY: number[] = []
    let entityCount = 0

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('no snapshots received in time')), 4000)
      ws.onmessage = (ev) => {
        if (!(ev.data instanceof ArrayBuffer)) return
        const snap = decodeSnapshot(ev.data)
        entityCount = snap.entities.length
        const ball = snap.entities[0]
        if (ball) firstBallY.push(ball.position.y)
        if (firstBallY.length >= 10) {
          clearTimeout(timeout)
          ws.close()
          resolve()
        }
      }
      ws.onerror = () => {
        clearTimeout(timeout)
        reject(new Error('client socket error'))
      }
    })

    expect(firstBallY.length).toBeGreaterThanOrEqual(10)
    expect(entityCount).toBe(8) // all dynamic balls replicated
    // Physics is running: the ball's height changes (it falls) across snapshots.
    expect(Math.max(...firstBallY) - Math.min(...firstBallY)).toBeGreaterThan(0.05)
  })
})
