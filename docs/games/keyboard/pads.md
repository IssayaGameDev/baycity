# Pads: step pads and treadmills

Both are contact-driven level components (a stay: `onContact` every tick) that report through
`effects.progress(node)`; the session reads their params off the node (ADR 0080, ADR 0082). Both get a sign.

## `StepPad` — `stepPad.ts`

Sets what a step pays. The real game's row of numbered buttons at spawn.

| Param | Kind | Default | Meaning |
| --- | --- | --- | --- |
| `perStep` | number | 1 | what each step pays while this pad is active |
| `requiresWins` | number | 0 | Wins needed to take it |
| `activeMaterial` | asset:material | `''` | worn while its value is the one you are on; empty keeps the Renderer's |
| `idleMaterial` | asset:material | `''` | worn otherwise; empty keeps the Renderer's |

Rules (Kodjo's): stepping on a pad you qualify for (`qualifies(wins, offer)`, `wins >= requiresWins`) makes its
`perStep` yours, **including a lower one**; with no pad ever taken the step pays `curve.perKey`; on a pad you do
not qualify for nothing happens. Saved under `keyboard.perStep`.

Materials: `stylePads()` in `main.ts` runs when `perStep` changes and swaps each pad's meshes
(`client.meshesOf(node)`) to `client.material(id)`; the original material is remembered per mesh for the empty
case. Any material a component parameter names is preloaded with the level (`assetParamIds`, ADR 0082).

The shipped eight (children of `step-pads`, x −12, two rows of four, 3 m apart): 1/0, 2/3, 5/15, 25/100,
50/500, 100/2.5K, 250/15K, 500/50K; active = goal yellow `6bbc0130aff311b5`, idle = checkpoint green
`d67ddcac4f57efc8`.

## `Treadmill` — `treadmill.ts`

Stand on it and earn steps without input.

| Param | Kind | Default | Meaning |
| --- | --- | --- | --- |
| `name` | string | `Treadmill` | the sign's top line |
| `multiplier` | number | 1 | each step pays `perStep × multiplier` |

Cadence is the game's (`stepsPerSecond(level)`, [steps.md](steps.md)); the tier multiplies the payout, not the
rate. `TreadmillTick = { multiplier }`; `treadmillStepValue(perStep, tick)`. The shipped pad `t0` is ×1 at x 6.
No lock or unlock yet (Kodjo: next).

## Signs

`buildSigns()` in `main.ts`, once the level exists: a `worldLabel` per pad and per treadmill (`@mp/render-three`,
ADR 0082), `depth: 'world'` (depth-tested, hidden behind geometry), kept out of the AO prepass with
`client.excludeFromAO(sign)`, 0.9 m tall, no background, 1.1 m above `padTop`.

| Node | Line 1 | Line 2 |
| --- | --- | --- |
| `StepPad` | `+N/step` (44 px, green) | `Requires N Wins` (24 px, cream) |
| `Treadmill` | `name` (44 px, cream) | `×N/step` (24 px, green) |

Built once; a pad edited in the editor's play-test keeps its sign until reload.
