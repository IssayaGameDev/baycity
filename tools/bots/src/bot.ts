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

export const createBot = (url: string, phase = 0): Bot => {
  let bytes = 0
  let messages = 0
  let angle = phase
  let room: Room | null = null
  let timer: ReturnType<typeof setInterval> | null = null

  void new Client(url)
    .joinOrCreate('parkour', { name: 'bot' })
    .then((r) => {
      room = r
      // Count the relayed payload (our snapshot bytes); Colyseus framing is extra.
      r.onMessage(NET_CHANNEL, (m: Uint8Array) => {
        bytes += m.byteLength
        messages += 1
      })
      timer = setInterval(() => {
        angle += 0.12
        // Bots walk a circle on the ground, so they report grounded — the flags byte is part of
        // the measured payload (v8), and sending 0 would under-report the delta traffic.
        r.sendBytes(
          NET_CHANNEL,
          new Uint8Array(
            encodeState({ position: { x: Math.cos(angle) * RADIUS, y: 1, z: Math.sin(angle) * RADIUS }, flags: STATE_GROUNDED }),
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
