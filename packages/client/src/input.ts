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

const any = (codes: ReadonlySet<string>, ...candidates: string[]): boolean =>
  candidates.some((c) => codes.has(c))

/**
 * Pure WASD/arrow → movement mapping over **physical key codes** (`KeyboardEvent.code`,
 * e.g. `KeyW`), so it's keyboard-layout-independent (WASD is a position, not letters).
 */
export const keysToMovement = (codes: ReadonlySet<string>): InputState => ({
  x: (any(codes, 'KeyD', 'ArrowRight') ? 1 : 0) - (any(codes, 'KeyA', 'ArrowLeft') ? 1 : 0),
  z: (any(codes, 'KeyS', 'ArrowDown') ? 1 : 0) - (any(codes, 'KeyW', 'ArrowUp') ? 1 : 0),
})
