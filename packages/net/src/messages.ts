/** Protocol version — first byte of every message from day one (SEED §2). */
export const PROTOCOL_VERSION = 3 as const

/** Message-type discriminators (second byte). */
export const MSG_SNAPSHOT = 1 as const // server -> client
export const MSG_WELCOME = 2 as const // server -> client (on connect)
export const MSG_INPUT = 3 as const // client -> server
export const MSG_PING = 4 as const // client -> server (clock sync)
export const MSG_PONG = 5 as const // server -> client (clock sync)
export const MSG_FIRE = 6 as const // client -> server (lag-compensated hit claim)
export const MSG_HIT = 7 as const // server -> client (broadcast hit result)

/** Read the message-type byte without fully decoding. */
export const readMessageType = (buffer: ArrayBuffer): number => new DataView(buffer).getUint8(1)

/** Validate the leading version + type bytes; throws on mismatch. */
export const readHeader = (buffer: ArrayBuffer, expectedType: number): void => {
  const view = new DataView(buffer)
  const version = view.getUint8(0)
  if (version !== PROTOCOL_VERSION) {
    throw new Error(`unsupported protocol version ${version} (expected ${PROTOCOL_VERSION})`)
  }
  const type = view.getUint8(1)
  if (type !== expectedType) {
    throw new Error(`unexpected message type ${type} (expected ${expectedType})`)
  }
}
