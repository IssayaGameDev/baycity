import { encodeInput, MSG_WELCOME, readMessageType } from '@mp/net'

/**
 * A headless load client: connects over the standard WebSocket, drives synthetic
 * circular movement at the tick rate (so its player actually moves — realistic
 * delta bandwidth), and counts bytes received. Reuses the same wire as real clients.
 */
export interface Bot {
  bytesReceived: () => number
  messages: () => number
  close: () => void
}

const TICK_HZ = 30

export const createBot = (url: string, phase = 0): Bot => {
  const ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'
  let bytes = 0
  let messages = 0
  let seq = 0
  let angle = phase
  let inputTimer: ReturnType<typeof setInterval> | null = null

  ws.onmessage = (ev) => {
    if (!(ev.data instanceof ArrayBuffer)) return
    bytes += ev.data.byteLength
    messages += 1
    if (readMessageType(ev.data) === MSG_WELCOME && inputTimer === null) {
      inputTimer = setInterval(() => {
        angle += 0.12
        ws.send(encodeInput({ seq: ++seq, moveX: Math.cos(angle), moveZ: Math.sin(angle), jump: false }))
      }, 1000 / TICK_HZ)
    }
  }

  return {
    bytesReceived: () => bytes,
    messages: () => messages,
    close: () => {
      if (inputTimer !== null) clearInterval(inputTimer)
      ws.close()
    },
  }
}
