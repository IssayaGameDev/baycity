import { startServer, type ServerHandle } from '@mp/server'
import { Client, type Room } from 'colyseus.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Matchmaking is filtered by level (`filterBy(['level'])`, ADR 0023), and that is a correctness
 * property, not a convenience: two clients on different levels share neither geometry nor the
 * movement-base numbering a rider replicates (assigned in instance order at load, ADR 0021), so a
 * room holding both would place riders on whatever piece happens to sit at that index.
 *
 * The only test in the repo that boots a real server and joins it — which is also why vitest runs
 * `pool: 'forks'`.
 */
const PORT = 9317
const URL = `ws://127.0.0.1:${PORT}`

describe('matchmaking separates levels', () => {
  let server: ServerHandle
  const joined: Room[] = []

  const join = async (level?: string): Promise<Room> => {
    const room = await new Client(URL).joinOrCreate('parkour', {
      name: 'test',
      ...(level !== undefined ? { level } : {}),
    })
    joined.push(room)
    return room
  }

  beforeAll(async () => {
    server = await startServer({ port: PORT })
  })

  afterAll(async () => {
    for (const r of joined) r.leave(false)
    await server.stop()
  })

  it('puts two clients naming the same level in one room', async () => {
    const a = await join('gym')
    const b = await join('gym')
    expect(b.roomId).toBe(a.roomId)
  })

  it('puts a client on a different level in a different room', async () => {
    const gym = await join('gym')
    const other = await join('some-authored-level')
    expect(other.roomId).not.toBe(gym.roomId)
  })

  it('treats an omitted level as a wildcard, which is why every client here names one', async () => {
    // Not a wish — the behaviour. `RegisteredHandler.getFilterOptions` only constrains a field the
    // options actually carry (`options.hasOwnProperty(field)`), so omitting `level` matches *any*
    // room, including one on another level. The bots harness used to join exactly like this; it now
    // names the gym, because landing in an authored level's room is the mismatch this filter exists
    // to prevent.
    const gym = await join('gym')
    const unfiltered = await join()
    expect(unfiltered.roomId).toBe(gym.roomId)
  })
})
