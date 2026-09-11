# Swing

`modes/swing`. The parkour stack plus a hold-to-swing rope; kept as the proof that a game can own its own
locomotion and send its own state (ADR 0067, 0068). Run: `pnpm dev:swing` (port 5175).

## Rope — `rope.ts`, `swing.ts`, `peerRopes.ts`, `ropeView.ts`

- `createSwing({ host, state, tuning })` is the player's **movement component**, replacing `Locomotion`
  (ADR 0067): it still calls `stepCharacter` every tick (gravity, collisions) but adds the rope force before
  it and zeroes the stick while attached. Held, not toggled: `SWING_ACTION = 'swing'`, bound to
  `ShiftLeft`/`ShiftRight` in `editorMode.ts`.
- Anchor: `castForAnchor(world, from, heading, tuning, exclude)` fans casts at pitches [25, 35, 45, 60, 75]°
  from the shoulder (`SWING_SHOULDER = CHAR_HALF_HEIGHT + CHAR_RADIUS + 0.3`); `bestAnchor`/`scoreAnchor` pick
  one; searched only while held and unattached.
- Force: `ropeForce` — one-sided damped spring plus a pump on stick input.

```ts
DEFAULT_ROPE: RopeTuning = { stiffness: 90, damping: 6, pump: 14, minLength: 4, maxLength: 20, coneDeg: 70, riseDeg: 20 }
```

- State on the wire: `SWINGING_STATE = 'swinging'`, one of the five free flag bits (ADR 0064). Peers re-derive
  the anchor themselves on the rising edge (`peerRopes.ts`, ADR 0068) rather than receiving a position.
- `ropeView.ts` draws self and peer ropes.

## Rules — `rules.ts`

Registry: engine + player + `Locomotion` def + shared set (`content/games/swing.json`: Bumper, Checkpoint,
Goal, Hazard, Track). Session: spawn, die, respawn at spawn; no progression.

## Level

`content/levels/swing.json`: a `swingbeams` group of four beams (z 10/26/40/54) to swing between.

## Tests

`rope.test.ts` (spring, pump, anchor scoring), `peerRopes.test.ts`.

Decisions: ADR 0061, 0064, 0067, 0068.
