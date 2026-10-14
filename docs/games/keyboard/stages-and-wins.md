# Stages and Wins

`modes/keyboard/src/components/wins.ts`, `rules.ts` (ADR 0073).

## A stage is not a thing

No component, node or list declares a stage. A stage is whatever platforms sit between the spawn and a
`WinsPad`. No checkpoints: **falling anywhere is the level's spawn**. Nothing locks a stage. Both Kodjo's calls.
A checkpoint ([obstacles.md](obstacles.md)) is a place to teleport to, not a respawn point.

## `WinsPad`

| Param | Default | Meaning |
| --- | --- | --- |
| `wins` | 1 | paid on touch — unless an `Obstacle` points at the pad: then its `wins` (ADR 0211) |

`onContact → effects.progress(node)` every tick stood on it. `keyboardSession` reads `WinsPad` off the node,
sets a pending teleport to the spawn (`{ position }`, no yaw: you keep facing as you were), and calls
`opts.onCashOut(wins, node)` **once** (further contacts before the teleport is consumed are swallowed). The client
applies `takeTeleport()` on the next tick: position set, velocity zeroed, `grounded` false, no death (ADR 0073 added
`ModeSession.takeTeleport?`).

`padTop(node)`: the pad's top face (centre + box half-height), where the `+N Wins` popup spawns.

## Wins

`let wins` in `main.ts`, saved through the game's save adapter under `keyboard.wins` ([progression.md](progression.md)). Shown on the HUD's left edge. Spent on
nothing yet except gating `StepPad`s ([pads.md](pads.md)). Debug grant: Progression folder.

## Death

`Hazard` on a kill plane under the level (`kill` node, box 80×0.5×80 at y −12, trigger) → `effects.kill()` →
`takeDeath()` → the platform's ragdoll and reassembly (`Death` player component, defaults) → `respawnAt()` =
spawn. `Hazard` is a shared component listed in `content/keyboard/game.json`.

## The session

```ts
keyboardSession(loaded, opts: KeyboardSessionOptions): KeyboardSession   // + currentObstacle() (ADR 0212)
interface KeyboardSessionOptions extends ModeSessionOptions {
  onCashOut?: (wins: number, node: WorldNode) => void
  onTreadmill?: (on: TreadmillTick) => void       // per tick
  onStepPad?: (offer: StepPadOffer, node: WorldNode) => void  // per tick
  requested?: () => KeyboardTeleport | null       // a teleport the game asks for (ADR 0202), + the stop it lands on
  onReached?: (node: WorldNode) => void          // an Obstacle's trigger walked into (ADR 0211)
}
```

`effects.progress(node)` dispatches on the node's component: `Obstacle` → `onReached` (its trigger, [obstacles.md](obstacles.md)); `StepPad` → `onStepPad`; `Treadmill` →
`onTreadmill`; `WinsPad` → cash-out. `progress()` is always `-1`: nothing persists through the platform.
`takeTeleport()`: the cash-out's if one waits, else `opts.requested?.()` — so a request on a cash-out's tick lands
the tick after ([obstacles.md](obstacles.md)).

## Level

`content/keyboard/levels/keyboard.level.json`: spawn `m0` at (0, 1.75, 0); boards `b0`–`b4` along +z (z 0, 20.5, 29.5, 39.5,
51.5); Wins pad `w0` at z 56 (1 Win); treadmill `t0` at x 6; `step-pads` parent at x −12 with eight children;
Kodjo's trampoline (Bumper prefab); kill plane. The whole run fits the wire's `QUANT_BOUND` of ±1000 m
(ADR 0092); it did not at ±40, and peers past the last two boards were clamped.

A stage's number and Wins are its row in the level's World ([world.md](world.md), ADR 0222); `WinsPad.stage` is gone. Wins per stage for World 1: [world-1.md](world-1.md).
