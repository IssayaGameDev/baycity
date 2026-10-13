/**
 * The simulation tick (ADR 0062).
 *
 * Here because it is the **platform's** clock, not any character's. It lived in `@mp/character` — so the
 * editor, the viewer and the game client all imported a package called `character` to find out how fast the
 * world runs, and a game with no character at all would have had to as well.
 *
 * Everything that keeps time against it already lives in this package: `createSimClock` slews to it,
 * `startFixedLoop` runs at it, and the local controller render-interpolates between its ticks.
 *
 * **One number for every game.** A per-game tick rate is not a knob this stack has: peers share a room and a
 * synced clock (ADR 0006), and the movement-base indices on the wire are assigned per tick (ADR 0021), so two
 * games at two rates would not be two games — they would be two protocols.
 */

/** Fixed simulation steps per second. */
export const TICK_RATE_HZ = 60

/** Seconds per fixed step. */
export const TICK_DT = 1 / TICK_RATE_HZ
