import { STATE_GAME_BITS, STATE_GAME_MASK, STATE_GAME_SHIFT } from './state'

/**
 * Packing a game's own states into the spare bits of the state byte, and reading them back (ADR 0064).
 *
 * Here, in the netcode, because it is purely "given these names in this order, which bits" — the wire
 * format's own business, and nothing in it knows that a name might mean a dash. Not in a host, because the
 * sender and every viewer have to agree, and a second copy of a mapping is how the editor and the game came
 * to disagree about post-FX (ADR 0057).
 *
 * Order is bit order. Appending a state is safe; reordering one silently reinterprets every peer's bits, which
 * is why `statesOf` is the only thing that assigns them.
 */

/** How many game states can travel. Five: what is spare in a byte already being sent. */
export const MAX_GAME_STATES = STATE_GAME_BITS

/** Thrown when a game declares more states than the wire has room for. A loud failure beats a silent truncation. */
export class TooManyStatesError extends Error {
  constructor(count: number) {
    super(`a game may declare at most ${MAX_GAME_STATES} wire states, not ${count}`)
    this.name = 'TooManyStatesError'
  }
}

/**
 * The bits for the states that are currently set.
 *
 * A name the game never declared is ignored rather than throwing: `playerStates` is called every tick from
 * game code, and a typo there should cost an animation, not the session.
 */
export const packStates = (declared: readonly string[] | undefined, active: ReadonlySet<string>): number => {
  if (declared === undefined || declared.length === 0) return 0
  if (declared.length > MAX_GAME_STATES) throw new TooManyStatesError(declared.length)
  let bits = 0
  declared.forEach((name, i) => {
    if (active.has(name)) bits |= 1 << (STATE_GAME_SHIFT + i)
  })
  return bits
}

/**
 * Which of a game's states a peer's flags say are set.
 *
 * Only the game's half of the byte is read, so a future platform flag cannot appear as somebody's dash.
 */
export const unpackStates = (declared: readonly string[] | undefined, flags: number): ReadonlySet<string> => {
  const out = new Set<string>()
  if (declared === undefined || declared.length === 0) return out
  const game = (flags & STATE_GAME_MASK) >>> STATE_GAME_SHIFT
  declared.forEach((name, i) => {
    if (i < MAX_GAME_STATES && (game & (1 << i)) !== 0) out.add(name)
  })
  return out
}
