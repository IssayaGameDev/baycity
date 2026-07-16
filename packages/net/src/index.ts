/**
 * @mp/net — wire protocol: schemas, binary serialization, quantization,
 * clock sync. Binary only; no JSON on the hot path (SEED §2).
 *
 * Scaffold placeholder; real modules land per SEED §7 build order (M2+).
 */

/** Protocol version byte, carried by every message from day one (SEED §2). */
export const PROTOCOL_VERSION = 1 as const
