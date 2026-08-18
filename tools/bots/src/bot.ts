import { Client, type Room } from 'colyseus.js'
import { encodeState, NET_CHANNEL, STATE_GROUNDED } from '@mp/net'

/**
 * A headless load client (client-authoritative, ADR 0011/0013): joins a room via the
 * Colyseus SDK and reports a synthetic circular position at the tick rate (so it
 * actually moves — realistic delta bandwidth), counting relayed bytes received. It
 * synthesizes the position rather than running the sim — the server does no simulation,
 * so this exercises the matchmaking + relay + snapshot path exactly like a real client.
 */
export interface Bot {
  bytesReceived: () => number
  messages: () => number
  close: () => void
}

const TICK_HZ = 30
const RADIUS = 5

/**
 * Matchmaking filters rooms by level (`filterBy(['level'])`, ADR 0023), so a bot has to name the same one a
 * browser tab would or it lands in a room of its own — which would silently halve the load test and stop
 * bots being visible from the game. `default` is what an unparameterised page loads (ADR 0027; it was `gym`
 * until that level was deleted, and this is the second time this default has had to follow it).
 */
const LEVEL = process.env['LEVEL'] ?? 'default'

export const createBot = (url: string, phase = 0): Bot => {
  let bytes = 0
  let messages = 0
  let angle = phase
  let room: Room | null = null
  let timer: ReturnType<typeof setInterval> | null = null

  void new Client(url)
    .joinOrCreate('parkour', { name: 'bot', level: LEVEL })
    .then((r) => {
      room = r
      // Count the relayed payload (our snapshot bytes); Colyseus framing is extra.
      r.onMessage(NET_CHANNEL, (m: Uint8Array) => {
        bytes += m.byteLength
        messages += 1
      })
      timer = setInterval(() => {
        angle += 0.12
        // Bots walk a circle on the ground, so they report grounded, a facing along the circle's
        // tangent and a real speed — flags, yaw and speed are all part of the measured payload
        // (v8/v9), and sending zeroes would under-report the delta traffic: a constant facing and a
        // constant speed both quantize to the same byte every tick, which the relay would then skip.
        r.sendBytes(
          NET_CHANNEL,
          new Uint8Array(
            encodeState({
              position: { x: Math.cos(angle) * RADIUS, y: 1, z: Math.sin(angle) * RADIUS },
              flags: STATE_GROUNDED,
              yaw: angle,
              speed: 0.12 * RADIUS * TICK_HZ,
              base: 0,
            }),
          ),
        )
      }, 1000 / TICK_HZ)
    })
    .catch(() => {
      // ignore — a bot that fails to join just contributes nothing
    })

  return {
    bytesReceived: () => bytes,
    messages: () => messages,
    close: () => {
      if (timer !== null) clearInterval(timer)
      void room?.leave()
    },
  }
}
