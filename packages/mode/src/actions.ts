/**
 * Turning held keys into the game's action names (ADR 0061).
 *
 * Here rather than in a host because both hosts need it — the game client and the editor's play-test — and a
 * second copy of a mapping is how the editor and the game came to disagree about post-FX (ADR 0057). It is
 * also the only part of the input path with no DOM in it, so it is the part worth testing.
 */

/** Action name → the physical key `code`s that hold it. What `ModeDescriptor.actions` is. */
export type ActionBindings = Readonly<Record<string, readonly string[]>>

/**
 * Which of a game's actions are held, given the keys that are down.
 *
 * Physical `code`s on both sides, so a binding means the same key on any layout. An action with several codes
 * is held if **any** of them is: that is what a binding list is for (`ShiftLeft` or `ShiftRight`).
 *
 * Returns an empty set for a game with no actions, which is every game the stack ships — so a host can call it
 * unconditionally and hand the result straight to the step.
 */
export const actionsHeld = (bindings: ActionBindings | undefined, keys: ReadonlySet<string>): ReadonlySet<string> => {
  const held = new Set<string>()
  if (bindings === undefined) return held
  for (const [action, codes] of Object.entries(bindings)) if (codes.some((code) => keys.has(code))) held.add(action)
  return held
}
