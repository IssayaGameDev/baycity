import { startServer } from '@mp/server'

import { createBot } from './bot'

/**
 * Load harness: start a server, connect N bots, run for a window, and report
 * budget 2 (downstream bandwidth/client) and budget 3 (server tick time).
 *
 *   pnpm --filter @mp/bots run load            # 20 bots, 10 s
 *   BOTS=30 DURATION_MS=15000 pnpm --filter @mp/bots run load
 *
 * Single-process (server + bots share the event loop), so tick timings include
 * some contention — a ballpark, not a clean isolated benchmark.
 */
const BOTS = Number(process.env.BOTS ?? 20)
const DURATION_MS = Number(process.env.DURATION_MS ?? 10000)
const PORT = 9300

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const avg = (xs: number[]): number => (xs.length > 0 ? xs.reduce((s, x) => s + x, 0) / xs.length : 0)

const main = async (): Promise<void> => {
  const server = await startServer({ port: PORT })
  const bots = Array.from({ length: BOTS }, (_, i) => createBot(`ws://127.0.0.1:${PORT}`, (i / BOTS) * Math.PI * 2))

  await sleep(1500) // let everyone matchmake, connect (async SDK handshake) and start moving
  const startBytes = bots.map((b) => b.bytesReceived())
  const t0 = performance.now()

  await sleep(DURATION_MS)

  const elapsedSec = (performance.now() - t0) / 1000
  const perBotKBs = bots.map((b, i) => (b.bytesReceived() - startBytes[i]!) / elapsedSec / 1024)
  const stats = server.stats()

  console.log(`\n=== load: ${BOTS} bots, ${elapsedSec.toFixed(1)}s window ===`)
  console.log(
    `budget 2  downstream/client:  avg ${avg(perBotKBs).toFixed(1)} kB/s   max ${Math.max(...perBotKBs).toFixed(1)} kB/s   (target ~20–30 kB/s)`,
  )
  console.log(
    `budget 3  server tick:        avg ${stats.tickAvgMs.toFixed(2)} ms   max ${stats.tickMaxMs.toFixed(2)} ms   (target < 33 ms)`,
  )

  for (const b of bots) b.close()
  await server.stop()
  process.exit(0)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
