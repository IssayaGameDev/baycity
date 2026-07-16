import type { Bytes, ClientTransport } from '@mp/core'

/**
 * Standard-WebSocket client transport. Works in the browser and in Node ≥ 22
 * (global `WebSocket`), so the same code path drives real clients and headless
 * bots (SEED §6, law 2).
 */
export const createWebSocketClientTransport = (url: string): ClientTransport => {
  const ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'

  let openHandler: (() => void) | null = null
  let messageHandler: ((data: Bytes) => void) | null = null
  let closeHandler: (() => void) | null = null

  ws.onopen = () => openHandler?.()
  ws.onclose = () => closeHandler?.()
  ws.onmessage = (ev: MessageEvent) => {
    if (ev.data instanceof ArrayBuffer) messageHandler?.(ev.data)
  }

  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    onOpen: (h) => {
      openHandler = h
    },
    onMessage: (h) => {
      messageHandler = h
    },
    onClose: (h) => {
      closeHandler = h
    },
  }
}
