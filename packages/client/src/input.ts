/**
 * Input abstraction (SEED §3): one interface behind keyboard/mouse and touch.
 * The interface and the pure key→movement mapping are headless (bots use a manual
 * source); the DOM adapters live in `@mp/client/dom`.
 */
export interface InputState {
  /** Horizontal movement intent, components in [-1, 1]. */
  x: number
  z: number
}

export interface InputSource {
  movement: () => InputState
}

/** A source you set programmatically — for bots, tests, or merged sources. */
export interface ManualInputSource extends InputSource {
  set: (state: InputState) => void
}

export const createManualInputSource = (initial: InputState = { x: 0, z: 0 }): ManualInputSource => {
  let state = initial
  return {
    movement: () => state,
    set: (s) => {
      state = s
    },
  }
}

const any = (keys: ReadonlySet<string>, ...candidates: string[]): boolean =>
  candidates.some((k) => keys.has(k))

/** Pure WASD/arrow → movement mapping (lowercased key names). */
export const keysToMovement = (keys: ReadonlySet<string>): InputState => ({
  x: (any(keys, 'd', 'arrowright') ? 1 : 0) - (any(keys, 'a', 'arrowleft') ? 1 : 0),
  z: (any(keys, 's', 'arrowdown') ? 1 : 0) - (any(keys, 'w', 'arrowup') ? 1 : 0),
})
