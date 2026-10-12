# Stage gates

`modes/keyboard/src/components/stageGate.ts` (ADR 0202), `teleportWindow.ts` (ADR 0203). The places the teleport
window sends a player to, and the window.

## `StageGate`

No params. Singleton. No collider needed. Placed on an empty object where a player should stand (its position
is the feet), turned the way they should face (its +Z). Put once in a prefab — the `InterLevel` stage-break —
every placement has one.

Not the shared `Checkpoint` (Kodjo's call): that one's meaning, a respawn point, and any settings it grows are
every game's. A gate does not change where you respawn: falling is still the spawn ([stages-and-wins.md](stages-and-wins.md)).

Every gate is open for now. Later, Kodjo's plan: reached by passing through a trigger, and a Wins price to unlock.

## The list

```ts
stageGatesOf(loaded: Pick<LoadedLevel, 'allNodes'>, standOffset: number): StageGateStop[]
interface StageGateStop { number: number; position: Vec3; yaw: number }
```

Hierarchy order — `allNodes`, depth first, parents before children — numbered from 1, so a gate inside a
placement is numbered where the placement sits. `position` = the node's world position + `standOffset`
(`STAND_OFFSET`, as a spawn is). `yaw` = `yawOf(rotation)`, the character's convention.

## The teleport

To a gate: `{ position, yaw }` handed to `keyboardSession` through `requested` (`Teleport`, `@mp/mode`), taken once
the next tick after any cash-out. The client puts the character there, turns it to `yaw` and swings the camera
behind (`OrbitCamera.face`), so forward is the way on. To Start: the spawn (`spawnOf`), no yaw.

## The window (ADR 0203, Kodjo's calls)

`createTeleportWindow(client, { rows, go })`, wired in `main.ts`: `rows = teleportRows(start, gates)` — Start, then
`Checkpoint N` per gate — asked as it opens; `gates` and `start` read in the session factory as each level loads;
`go` sets the request `requested` hands over.

| | |
| --- | --- |
| the button | `uiButton` **Teleport**, 84 px square × `hudScale`, left edge 18 px in, vertically centred; toggles |
| T | toggles (not while typing in a field); Esc closes it (the shell's Esc, ADR 0205), leaving the mouse showing |
| open | `client.holdCursor(close)` — the mouse freed without the pause screen; refused (`null`) while it is up. Walking still works (keys are read unlocked); the camera stops turning |
| the box | 300 px wide × `hudScale`, as tall as Start + the gates need (header 58, rows 44, padding 12), at most the overlay less 40 px above and below; vertically centred; its background `eventMode` static, so a tap on it is neither "outside" nor a thumb on the stick |
| the slide | `stepSlide`: progress ± `dt / SLIDE_SECONDS` (0.25), linear, so a reversal is continuous; `x = hidden + (out − hidden) × slideOut(p)`, `out-cubic` — closing is the opening played backwards |
| the list | `uiList` rows of 44 px, 17 px type, each with `onPick`: drag or wheel to scroll |
| closes | a pick (teleports, then closes), ✕, T, Esc, a tap outside (`onOutside`), or the pause screen taking over. Closing calls the hold's release, which locks the mouse again — refused after Esc, so the next click locks |

## In the editor

`KEYBOARD_MODE.facingGizmos`: a blue disc and post (`MARKER_COLORS.spawn`) with an arrow along the gate's
forward, under the toolbar's Markers toggle.
