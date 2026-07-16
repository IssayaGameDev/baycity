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

  it('streams moving sphere snapshots to a connected WebSocket client', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`)
    ws.binaryType = 'arraybuffer'
    const xs: number[] = []

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('no snapshots received in time')), 4000)
      ws.onmessage = (ev) => {
        if (!(ev.data instanceof ArrayBuffer)) return
        const sphere = decodeSnapshot(ev.data).entities[0]
        if (sphere) xs.push(sphere.position.x)
        if (xs.length >= 10) {
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

    expect(xs.length).toBeGreaterThanOrEqual(10)
    // The sphere orbits, so x must vary across the received snapshots.
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.01)
  })
})
