import { startServer, type ServerHandle } from '@mp/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createBot } from './bot'

const PORT = 9350

describe('load bots', () => {
  let server: ServerHandle

  beforeAll(async () => {
    server = await startServer({ port: PORT })
  })
  afterAll(async () => {
    await server.stop()
  })

  it('bots connect, exchange traffic, and the server records tick stats', async () => {
    const bots = [
      createBot(`ws://127.0.0.1:${PORT}`, 0),
      createBot(`ws://127.0.0.1:${PORT}`, 1),
    ]
    await new Promise((resolve) => setTimeout(resolve, 800))

    for (const bot of bots) {
      expect(bot.messages()).toBeGreaterThan(0)
      expect(bot.bytesReceived()).toBeGreaterThan(0)
    }
    const stats = server.stats()
    expect(stats.ticks).toBeGreaterThan(0)
    expect(stats.tickMaxMs).toBeLessThan(33) // budget 3 sanity at tiny load

    for (const bot of bots) bot.close()
  })
})
