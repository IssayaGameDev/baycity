# Obstacles and the teleport window

`modes/keyboard/src/components/obstacle.ts` (ADR 0211), `teleportWindow.ts` (ADR 0203). `StageGate` (ADR 0202) is gone (ADR 0217).
The checkpoints the teleport window sends a player to, and the window.

## `Obstacle`

Singleton. Put on the InterLevel prefab's root, pointing at what is inside the prefab — or on a level node, pointing
into a placement (`<placement>/<node>`, ADR 0219).

| Param | Kind | Default | Meaning |
| --- | --- | --- | --- |
| `teleport` | nodeRef | — | where the teleport lands: that node's position + `STAND_OFFSET`, facing its +Z. Empty: the Obstacle's own node |
| `trigger` | componentRef Collider, `contacts` | — | walking into it reaches the checkpoint. Empty or unresolved: never reached |
| `winsPad` | componentRef WinsPad | — | the pad whose `wins` this sets |
| `wins` | number ≥ 1 | 1 | what that pad pays, over its own (`drives`, ADR 0210) |
| `requiredLevelText` | componentRef Text | — | the Text this writes: `requiresLevelText(X)` = `Requires Level X` |
| `requiredLevel` | number ≥ 0 | 0 | X. Gates nothing yet |
| `safeZoneText` | componentRef Text | — | a Text of its own words, shown while this is the obstacle ahead |

`drives` sets the pad's `wins` and the required-level text's `text` as the level loads, so the rules, the drawn sign and the editor
read them. `onContact`: a hit on the trigger's handle → `effects.progress(self.node)` → `keyboardSession` →
`onReached(node)`.

## The list

```ts
checkpointsOf(loaded: Pick<LoadedLevel, 'allNodes' | 'findNode'>, standOffset: number): CheckpointStop[]
interface CheckpointStop { number; node: WorldNode; position: Vec3; yaw: number; key: string; pivot: Vec3; safeZoneText; requiredLevelText }
```

Every Obstacle node in Hierarchy order — `allNodes`, depth first — numbered from 1. `key` = the node's id, `#2`,
`#3`… on later nodes sharing one.

## Reached

`main.ts`: `reach(node)` → the stop's `key` added under `client.levelName` (`withReached`) and `persist()`ed —
`KeyboardSave.reached`, `keyboard.reached` ([progression.md](progression.md)). For good. A trigger walked into before
the client exists waits in `reachedEarly`. Nothing on screen (Kodjo's call).

## The obstacle you are on (ADR 0212)

`KeyboardSession.currentObstacle(): WorldNode | null` — the last Obstacle whose trigger was walked into (set on its
`progress`), or the stop the window landed on (`KeyboardTeleport.obstacle`). `null` at the start and after a death
(`takeDeath`), a cash-out, `respawnAt` (respawn, Restart) and a teleport to Start. The player's own: not sent, not saved,
drawn nowhere yet.

## The text ahead (ADR 0213, Kodjo's calls)

In the game every Obstacle's two texts start hidden (`client.textShown(node, 0)`); in the editor they show as authored.
One shows at a time — `shownText(stops, current, inside, feet)`:

| | shows |
| --- | --- |
| from the spawn (no current obstacle) | the first Obstacle's safe zone text |
| inside the current one's trigger (reported within 3 ticks, as the treadmill) | its required-level text |
| out of it, past its `pivot` (the trigger's object, else the landing) along its teleport's facing | the next stop's safe zone text |
| out of it, short of that | its own safe zone text again |

Each text fades toward 1 or 0 at `1 / TEXT_FADE_SECONDS` (0.3 s) a second, linear
(`main.ts`, every frame, from the feet of the drawn rig).

## The teleport

To a checkpoint: `{ position, yaw, obstacle }` handed to `keyboardSession` through `requested` (`KeyboardTeleport` =
`Teleport` + `obstacle: WorldNode | null`), taken
once the next tick after any cash-out. The client puts the character there, turns it to `yaw` and swings the camera
behind (`OrbitCamera.face`). To Start: the spawn (`spawnOf`), no yaw, `obstacle: null`.

## The window (ADR 0203, Kodjo's calls)

`createTeleportWindow(client, { rows, go })`, wired in `main.ts`: `rows = teleportRows(start, checkpoints, isReached)` —
Start, then `Checkpoint N` per stop — asked as it opens, and again when one is reached while it is open
(`TeleportWindow.refresh()`, from `reach`): the rows set in place, the list's scroll kept. `TeleportRow { label, to,
locked }`: `locked` = not reached, unless the debug pane's `unlock checkpoints` is on ([debug.md](debug.md)) — drawn
`muted` (greyed), no `onPick`.

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

No marker: `KEYBOARD_MODE` sets no `facingGizmos`.
