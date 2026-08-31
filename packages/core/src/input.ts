/**
 * A single client movement sample. `moveX`/`moveZ` are a world-space horizontal
 * direction (the client rotates raw WASD by the camera before applying), so the
 * simulation is camera-agnostic. Client-authoritative (ADR 0011): this drives the
 * client's own sim locally and is never sent on the wire — the client sends its
 * resulting position as STATE (see `state.ts`). No sequence number: with no
 * server reconciliation there is nothing to acknowledge.
 */
export interface InputCommand {
  moveX: number // -1..1 (world-space)
  moveZ: number // -1..1 (world-space)
  jump: boolean
  /**
   * Whatever else this game's controls do, by **game-defined name** (ADR 0061).
   *
   * Two axes and a jump is a third-person platformer's whole vocabulary, and it was every game's whole
   * vocabulary because this type was the only one there is. A dash, a grapple, a crouch, a second jump
   * button — none of them had anywhere to go, so a game could change how fast it moved and not what its
   * controls *were*.
   *
   * Names rather than more fields, because the platform has no business knowing them: the host fills this
   * from its own key bindings and the game's own locomotion component reads the names it declared. Nothing in
   * between needs a list.
   *
   * Optional, so the three fields above stay the whole of an ordinary command and no existing caller changes.
   * Held-this-tick, not pressed-this-tick: a press that has to survive being shorter than a tick is what
   * `jump`'s buffer inside `stepCharacter` exists for, and a game wanting the same for its own action does the
   * same thing in its own component.
   */
  actions?: ReadonlySet<string>
}
