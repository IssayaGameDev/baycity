/** Protocol version — first byte of every message from day one (SEED §2).
 * v6: client-authoritative. Clients send STATE (their own position), the server
 * relays it. INPUT / FIRE / HIT (server-auth + lag-comp) removed (ADR 0011).
 * v7: rooms on Colyseus; adds ROSTER (peer id -> name) (ADR 0013).
 * v8: STATE and snapshot entities carry a flags byte — the animation state a viewer
 * cannot derive from position (see `STATE_GROUNDED`). */
export const PROTOCOL_VERSION = 8 as const

/** The single Colyseus message channel our whole binary protocol rides on (ADR 0013).
 * Colyseus never inspects the payload; we dispatch on the version+type header inside. */
export const NET_CHANNEL = 'n' as const

/** Message-type discriminators (second byte). */
export const MSG_SNAPSHOT = 1 as const // server -> client (relayed peer states)
export const MSG_WELCOME = 2 as const // server -> client (on connect)
export const MSG_STATE = 3 as const // client -> server (owner-authoritative position)
export const MSG_PING = 4 as const // client -> server (clock sync)
export const MSG_PONG = 5 as const // server -> client (clock sync)
export const MSG_ROSTER = 6 as const // server -> client (peer id -> display name, on join/leave)

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
