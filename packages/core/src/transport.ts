/**
 * Transport interface. `@mp/core` knows only these shapes; concrete transports
 * live in the packages that need them (uWebSockets.js in `@mp/server`, standard
 * WebSocket in `@mp/client`). This is the seam that lets a UDP-like transport be
 * swapped in later (SEED §2) without touching the rest of the stack.
 */

/** Binary payload. ArrayBuffer keeps browser/Node WebSocket and uWS zero-conversion. */
export type Bytes = ArrayBuffer

/** One connected peer, seen from the accepting (server) side. */
export interface Connection {
  readonly id: number
  send: (data: Bytes) => void
  close: () => void
  onMessage: (handler: (data: Bytes) => void) => void
  onClose: (handler: () => void) => void
}

/** Accepts connections. */
export interface ServerTransport {
  onConnection: (handler: (conn: Connection) => void) => void
  close: () => void
}

/** Client side of a transport. */
export interface ClientTransport {
  send: (data: Bytes) => void
  close: () => void
  onOpen: (handler: () => void) => void
  onMessage: (handler: (data: Bytes) => void) => void
  onClose: (handler: () => void) => void
}
