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
}
