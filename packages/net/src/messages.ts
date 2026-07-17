/** Protocol version — first byte of every message from day one (SEED §2). */
export const PROTOCOL_VERSION = 2 as const

/** Message-type discriminators (second byte). */
export const MSG_SNAPSHOT = 1 as const // server -> client
export const MSG_WELCOME = 2 as const // server -> client (on connect)
export const MSG_INPUT = 3 as const // client -> server

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
