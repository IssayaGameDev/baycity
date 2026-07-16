/** Protocol version — first byte of every message from day one (SEED §2). */
export const PROTOCOL_VERSION = 1 as const

/** Message-type discriminator (second byte). More types arrive per milestone. */
export const MSG_SNAPSHOT = 1 as const
