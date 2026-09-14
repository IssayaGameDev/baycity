/** Protocol version — first byte of every message from day one (SEED §2).
 * v6: client-authoritative. Clients send STATE (their own position), the server
 * relays it. INPUT / FIRE / HIT (server-auth + lag-comp) removed (ADR 0011).
 * v7: rooms on Colyseus; adds ROSTER (peer id -> name) (ADR 0013).
 * v8: STATE and snapshot entities carry a flags byte — the animation state a viewer
 * cannot derive from position (see `STATE_GROUNDED`).
 * v9: they also carry facing and locomotion speed (f32 upstream, a byte each on relay). Both are
 * things only the owner knows: facing follows the *input* direction, and a position curve cannot
 * separate walking from being carried by a platform. +2 B per snapshot entity.
 * v10: they also carry the clock-driven piece being ridden, and while it is non-zero the position and
 * facing are expressed **in that piece's frame** — relative-to-base replication (ADR 0021), which is
 * what stops a rider sliding across a platform for everyone but its owner. +1 B per snapshot entity.
 * v11: no layout change — `QUANT_BOUND` widens from ±40 m to ±1000 m (ADR 0092). The same three u16s
 * mean different metres, so a v10 peer would place everyone at a twenty-fifth of their distance. The
 * bump exists only to make that mismatch a refused frame instead of a silently wrong world. */
export const PROTOCOL_VERSION = 11 as const

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
