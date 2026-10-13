# Obstacles and the teleport window

`modes/keyboard/src/components/obstacle.ts` (ADR 0211), `stageGate.ts` (ADR 0202), `teleportWindow.ts` (ADR 0203).
The checkpoints the teleport window sends a player to, and the window.

## `Obstacle`

Singleton. Put on the InterLevel prefab's root, where the stage gate was, pointing at what is inside the prefab (a
level node cannot point inside a placement, `docs/platform/components/api.md`).

| Param | Kind | Default | Meaning |
| --- | --- | --- | --- |
| `teleport` | nodeRef | — | where the teleport lands: that node's position + `STAND_OFFSET`, facing its +Z. Empty: the Obstacle's own node |
| `trigger` | componentRef Collider, `contacts` | — | walking into it reaches the checkpoint. Empty or unresolved: never reached |
| `winsPad` | componentRef WinsPad | — | the pad whose `wins` this sets |
| `wins` | number ≥ 1 | 1 | what that pad pays, over its own (`drives`, ADR 0210) |
| `sign` | componentRef Text | — | the Text this writes |
| `requiredLevel` | number ≥ 0 | 0 | the sign reads `requiresLevelText(X)` = `Requires Level X`. Gates nothing yet |

`drives` sets the pad's `wins` and the sign's `text` as the level loads, so the rules, the drawn sign and the editor
read them. `onContact`: a hit on the trigger's handle → `effects.progress(self.node)` → `keyboardSession` →
`onReached(node)`.

`StageGate` (no params) is kept until the box's levels have swapped theirs for Obstacles (ADR 0211): listed, always open.

## The list

```ts
checkpointsOf(loaded: Pick<LoadedLevel, 'allNodes' | 'findNode'>, standOffset: number): CheckpointStop[]
interface CheckpointStop { number; node: WorldNode; position: Vec3; yaw: number; key: string; alwaysOpen: boolean }
```

Every Obstacle and StageGate node (one with both is its Obstacle) in Hierarchy order — `allNodes`, depth first —
numbered from 1. `key` = the node's id, `#2`, `#3`… on later nodes sharing one. `alwaysOpen` for a gate.

## Reached

`main.ts`: `reach(node)` → the stop's `key` added under `client.levelName` (`withReached`) and `persist()`ed —
`KeyboardSave.reached`, `keyboard.reached` ([progression.md](progression.md)). For good. A trigger walked into before
the client exists waits in `reachedEarly`. Nothing on screen (Kodjo's call).

## The teleport

To a checkpoint: `{ position, yaw }` handed to `keyboardSession` through `requested` (`Teleport`, `@mp/mode`), taken
once the next tick after any cash-out. The client puts the character there, turns it to `yaw` and swings the camera
behind (`OrbitCamera.face`). To Start: the spawn (`spawnOf`), no yaw.

## The window (ADR 0203, Kodjo's calls)

`createTeleportWindow(client, { rows, go })`, wired in `main.ts`: `rows = teleportRows(start, checkpoints, isReached)` —
Start, then `Checkpoint N` per stop — asked as it opens. `TeleportRow { label, to, locked }`: `locked` = not
`alwaysOpen` and not reached — drawn `muted` (greyed), no `onPick`.

| | |
| --- | --- |
| the button | `uiButton` **Teleport**, 84 px square × `hudScale`, left edge 18 px in, vertically centred; toggles |
| T | toggles (not while typing in a field); Esc closes it (the shell's Esc, ADR 0205), leaving the mouse showing |
| open | `client.holdCursor(close)` — the mouse freed without the pause screen; refused (`null`) while it is up. Walking still works (keys are read unlocked); the camera stops turning |
| the box | 300 px wide × `hudScale`, as tall as the rows need (header 58, rows 44, padding 12), at most the overlay less 40 px above and below; vertically centred; its background `eventMode` static, so a tap on it is neither "outside" nor a thumb on the stick |
| the slide | `stepSlide`: progress ± `dt / SLIDE_SECONDS` (0.25), linear, so a reversal is continuous; `x = hidden + (out − hidden) × slideOut(p)`, `out-cubic` — closing is the opening played backwards |
| the list | `uiList` rows of 44 px, 17 px type, an open one with `onPick`: drag or wheel to scroll |
| closes | a pick (teleports, then closes), ✕, T, Esc, a tap outside (`onOutside`), or the pause screen taking over. Closing calls the hold's release, which locks the mouse again — refused after Esc, so the next click locks |

## In the editor

`KEYBOARD_MODE.facingGizmos`: a blue disc and post (`MARKER_COLORS.spawn`) with an arrow along a **StageGate**'s
forward, under the toolbar's Markers toggle. An Obstacle has none.
