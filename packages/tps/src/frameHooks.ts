/**
 * Per-rendered-frame callbacks a game registered (ADR 0066).
 *
 * Its own function rather than three lines inline, because the iteration rule is the whole of it and is easy
 * to get silently wrong: a hook that **removes itself while running** — a rope that lets go, a hit marker that
 * finishes fading — must not disturb the pass it is inside. Iterating a live `Set` while deleting from it skips
 * the next entry, which would look like a second effect flickering rather than like a bug in here.
 */
export interface FrameHooks {
  /** Register, and get back the call that unregisters. Adding the same function twice adds it once. */
  add: (fn: (dt: number) => void) => () => void
  /** Run every hook with this frame's delta, in registration order. */
  run: (dt: number) => void
  /** Drop them all — what teardown does, before anything they read is taken away. */
  clear: () => void
  /** How many are registered. For a caller that wants to skip the pass entirely. */
  size: () => number
}

export const createFrameHooks = (): FrameHooks => {
  const hooks = new Set<(dt: number) => void>()
  return {
    add: (fn) => {
      hooks.add(fn)
      return () => {
        hooks.delete(fn)
      }
    },
    // A copy per pass. The cost is one array allocation on a path that is already allocating; the alternative
    // is an edge case that only shows up once something removes itself, which is exactly when it is hardest to
    // recognise.
    run: (dt) => {
      for (const fn of [...hooks]) fn(dt)
    },
    clear: () => hooks.clear(),
    size: () => hooks.size,
  }
}
