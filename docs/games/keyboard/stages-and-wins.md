# Stages and Wins

`modes/keyboard/src/wins.ts`, `rules.ts` (ADR 0073).

## A stage is not a thing

No component, node or list declares a stage. A stage is whatever platforms sit between the spawn and a
`WinsPad`. No checkpoints: **falling anywhere is the level's spawn**. Nothing locks a stage. Both Kodjo's calls.

## `WinsPad`

| Param | Default | Meaning |
| --- | --- | --- |
| `wins` | 1 | paid on touch |

`onContact → effects.progress(node)` every tick stood on it. `keyboardSession` reads `WinsPad` off the node,
sets a pending teleport to the spawn, and calls `opts.onCashOut(wins, node)` **once** (further contacts before
the teleport is consumed are swallowed). The client applies `takeTeleport()` on the next tick: position set,
velocity zeroed, `grounded` false, no death (ADR 0073 added `ModeSession.takeTeleport?`).

`padTop(node)`: the pad's top face (centre + box half-height), where the `+N Wins` popup spawns.

## Wins

`let wins` in `main.ts`; `loadWins`/`saveWins` under `keyboard.wins`. Shown on the HUD's left edge. Spent on
nothing yet except gating `StepPad`s ([pads.md](pads.md)). Debug grant: Progression folder.

## Death

`Hazard` on a kill plane under the level (`kill` node, box 80×0.5×80 at y −12, trigger) → `effects.kill()` →
`takeDeath()` → the platform's ragdoll and reassembly (`Death` player component, defaults) → `respawnAt()` =
spawn. `Hazard` is a shared component listed in `content/keyboard/game.json`.

## The session

```ts
keyboardSession(loaded, opts: KeyboardSessionOptions): ModeSession
interface KeyboardSessionOptions extends ModeSessionOptions {
  onCashOut?: (wins: number, node: WorldNode) => void
  onTreadmill?: (on: TreadmillTick) => void       // per tick
  onStepPad?: (offer: StepPadOffer, node: WorldNode) => void  // per tick
}
```

`effects.progress(node)` dispatches on the node's component: `StepPad` → `onStepPad`; `Treadmill` →
`onTreadmill`; `WinsPad` → cash-out. `progress()` is always `-1`: nothing persists through the platform.

## Level

`content/keyboard/levels/keyboard.level.json`: spawn `m0` at (0, 1.75, 0); boards `b0`–`b4` along +z (z 0, 20.5, 29.5, 39.5,
51.5); Wins pad `w0` at z 56 (1 Win); treadmill `t0` at x 6; `step-pads` parent at x −12 with eight children;
Kodjo's trampoline (Bumper prefab); kill plane. The whole run fits the wire's `QUANT_BOUND` of ±1000 m
(ADR 0092); it did not at ±40, and peers past the last two boards were clamped.

`WinsPad.stage` (number, default 0 = unnumbered): the pad's place in the world's sequence, 1-based — what the simulator and a future HUD read (ADR 0088). Wins per stage for World 1: [world-1.md](world-1.md).
