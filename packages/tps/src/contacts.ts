import type { CharacterBody } from '@mp/physics'

/**
 * Everything the capsule is in contact with where it stands now: the solids its touch skin overlaps, whichever of
 * the two moved (ADR 0188); those its own move ran into; and the triggers it is standing inside (ADR 0054) — a
 * sensor resolves no movement, so it never appears in `collisions` and has to be asked for.
 *
 * **Read after every slice of a tick, not once at its end** (ADR 0208). A sliced tick moves the capsule several
 * times, and each of these answers for the last move only. Read once, a touch made and left inside the tick is
 * never seen: landing on lava in one slice and jumping off it in the next, with jump held, lived through it.
 */
export const contactsNow = (body: CharacterBody): number[] => [...body.touching(), ...body.collisions(), ...body.overlaps()]
