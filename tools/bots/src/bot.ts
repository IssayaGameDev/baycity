import { encodeState, MSG_WELCOME, readMessageType } from '@mp/net'

/**
 * A headless load client (client-authoritative, ADR 0011): connects over the
 * standard WebSocket and reports a synthetic circular position at the tick rate
 * (so it actually moves — realistic delta bandwidth), counting bytes received.
 * It synthesizes the position directly rather than running the physics sim: the
 * server does no simulation, so this exercises the relay + snapshot path exactly
 * like a real client. Reuses the same wire.
 */
export interface Bot {
  bytesReceived: () => number
  messages: () => number
  close: () => void
}

const TICK_HZ = 30
const RADIUS = 5

export const createBot = (url: string, phase = 0): Bot => {
  const ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'
  let bytes = 0
  let messages = 0
  let angle = phase
  let stateTimer: ReturnType<typeof setInterval> | null = null

  ws.onmessage = (ev) => {
    if (!(ev.data instanceof ArrayBuffer)) return
    bytes += ev.data.byteLength
    messages += 1
    if (readMessageType(ev.data) === MSG_WELCOME && stateTimer === null) {
      stateTimer = setInterval(() => {
        angle += 0.12
        ws.send(encodeState({ x: Math.cos(angle) * RADIUS, y: 1, z: Math.sin(angle) * RADIUS }))
      }, 1000 / TICK_HZ)
    }
  }

  return {
    bytesReceived: () => bytes,
    messages: () => messages,
    close: () => {
      if (stateTimer !== null) clearInterval(stateTimer)
      ws.close()
    },
  }
}
