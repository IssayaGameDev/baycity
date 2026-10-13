# Keyboard Escape

`modes/keyboard`. A clone of Roblox's `+1 Speed Keyboard Escape`: an incremental simulator wearing an obby's
clothes. Hold a direction and you earn Experience by the step; Experience buys Levels; Levels buy Max Speed and
step cadence. Stages are keyboard-topped platforms ending on a Wins pad. Wins buy step multipliers.

Run: `pnpm dev:keyboard` (port 5177) with `pnpm dev:server`. Share: `pnpm share keyboard`.

| File | What |
| --- | --- |
| [progression.md](progression.md) | Experience → Level → Max Speed; the curve, its fixture, the save keys |
| [balance.md](balance.md) | The three curves, the curve editor, the gate simulator and its CLI |
| [world-1.md](world-1.md) | The design values: stages as speed gates, Wins per stage, worlds, rebirth, the per-step formula |
| [steps.md](steps.md) | What a step is, the cadence curve by Level, the `Stepper` component |
| [keycaps.md](keycaps.md) | The `Keyboard` component, instanced caps, the press animation, the sweep |
| [stages-and-wins.md](stages-and-wins.md) | `WinsPad`, the teleport, Wins |
| [obstacles.md](obstacles.md) | `Obstacle` (and `StageGate` until replaced) and the teleport window: the checkpoints, reaching them, their order |
| [pads.md](pads.md) | `StepPad` and `Treadmill`: params, materials, signs |
| [hud.md](hud.md) | What is drawn where, and how it scales |
| [debug.md](debug.md) | The debug pane's folders and controls |
| [known-open.md](known-open.md) | What is missing or unresolved |

Source map (`modes/keyboard/src/`): `editorMode.ts` (the `ModeDescriptor`), `rules.ts` (registry + session),
`main.ts` (the composition: `startTpsClient`, earning, pads, signs, HUD, pane), `progression.ts`, `save.ts` (the save's adapter), `balance.ts` + `balance.cli.ts`,
`keycaps.ts` + `keycapGeometry.ts` + `keyColours.ts`, `hud.ts`, `popups.ts`, `teleportWindow.ts`; the game's components, one per file (ADR 0174), in `components/`:
`keyboard.ts`, `wins.ts`, `treadmill.ts`, `stepPad.ts`, `steps.ts`, `obstacle.ts`, `stageGate.ts`; its data types in `data/`: `keyboardStyle.ts` (Keyboard Style,
New data › Keyboard › Keyboard Style — key colours and shade jitter, ADR 0181/0182).
Level: `content/keyboard/levels/keyboard.level.json`. Shared components: `content/keyboard/game.json`.

Decisions: ADR 0069 (keyboard is one node), 0071 (Experience/Level/Speed), 0072 (`toScreen`, popups),
0073 (stages, Wins), 0080 (treadmill), 0081 (a step), 0082 (world text, step pads), 0087 (settings), 0088 (curves, gate simulator), 0075 (debug folders),
0078/0079 (movement and animation caps this game sets), 0202 (stage gates), 0203 (the teleport window), 0211 (the Obstacle; its platform side 0210).
