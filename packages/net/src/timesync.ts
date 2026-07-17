import { MSG_PING, MSG_PONG, PROTOCOL_VERSION, readHeader } from './messages'

/** Clock-sync ping (client → server): the client's send timestamp, echoed back. */
export interface Ping {
  clientTimeMs: number // u32
}

/** Clock-sync pong (server → client): the echoed client time + the server's time. */
export interface Pong {
  clientTimeMs: number // u32 (echoed)
  serverTimeMs: number // u32
}

const LE = true

export const encodePing = (p: Ping): ArrayBuffer => {
  const buffer = new ArrayBuffer(6)
  const view = new DataView(buffer)
  view.setUint8(0, PROTOCOL_VERSION)
  view.setUint8(1, MSG_PING)
  view.setUint32(2, p.clientTimeMs >>> 0, LE)
  return buffer
}

export const decodePing = (buffer: ArrayBuffer): Ping => {
  readHeader(buffer, MSG_PING)
  return { clientTimeMs: new DataView(buffer).getUint32(2, LE) }
}

export const encodePong = (p: Pong): ArrayBuffer => {
  const buffer = new ArrayBuffer(10)
  const view = new DataView(buffer)
  view.setUint8(0, PROTOCOL_VERSION)
  view.setUint8(1, MSG_PONG)
  view.setUint32(2, p.clientTimeMs >>> 0, LE)
  view.setUint32(6, p.serverTimeMs >>> 0, LE)
  return buffer
}

export const decodePong = (buffer: ArrayBuffer): Pong => {
  readHeader(buffer, MSG_PONG)
  const view = new DataView(buffer)
  return { clientTimeMs: view.getUint32(2, LE), serverTimeMs: view.getUint32(6, LE) }
}
