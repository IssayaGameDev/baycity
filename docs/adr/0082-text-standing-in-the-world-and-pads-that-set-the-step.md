# ADR 0082 — Text standing in the world, and pads that set the step

Status: accepted. `@mp/render-three` has `worldLabel`, a billboard text sprite in world units; the nametag is a
caller. `modes/keyboard` has `StepPad`: step on one you have the Wins for and every step pays its number.

## Context

The game being cloned has a row of numbered pads at spawn, each with a sign over it — `+1/step`, `Requires 0
Wins`; `+2/step`, `Requires 3 Wins`; on up to `+500/step` at 50K Wins (Kodjo's screenshot). Step on one you
qualify for and that is what each step pays from then on.

Two things the stack lacked: the pad, and **text standing in the world**. The only in-world text was the
nametag in `@mp/tps` — a canvas drawn to a texture on a billboard sprite, on the overlay layer, drawn after
post-FX so a lit sprite does not get an AO ghost. One line, at head height, off a rig.

## Decision

### `worldLabel` lives in `@mp/render-three`

Kodjo asked where this belongs, and the first answer — `@mp/tps`, because the nametag is there — was wrong.
The drawing is pure rendering: a canvas, a texture, a sprite, the overlay layer. It knows nothing of humanoids
or games. `@mp/render-three` already owns the overlay layer and the render step that draws it, so the
primitive sits beside them. The nametag becomes a one-line caller with its head-height offset.

`worldLabel(lines, opts)`: lines each with text, size, colour and weight, so a two-size sign is one label;
`heightM` for how tall it stands. **Sized by the world, not the screen** — it shrinks with distance like a sign
does. Screen-space text pinned with `toScreen` (ADR 0072) is the other tool, for numbers that must stay
readable at any range; the two are different things and both are wanted.

`layoutLabel` is the half with no canvas in it, and is tested; happy-dom has no 2D context.

**Two depths.** The first signs went on the overlay layer like the nametag and Kodjo saw them drawn over
everything — over the pads, over the character, unhidden by walls. Right for a nametag, wrong for a sign. So
`depth: 'over' | 'world'`: `'over'` is the nametag's overlay layer; `'world'` puts the label in the world pass,
depth-tested against the level, tone mapping and bloom off the text. A world label writes no depth, but the AO
prepass draws with an override material and would see it as a tilted quad — the ghost that sent nametags to the
overlay in the first place — so **`TpsClient.excludeFromAO(object)`** keeps it out of that prepass, alongside
the surfaces wearing the camera's cutout (ADR 0055). The signs use it; the nametag stays `'over'`.

A `Label` engine component — text authored in the editor on any node — would use the same primitive. Not built;
the pads derive their text from their own parameters.

### `StepPad`

Two parameters, `perStep` and `requiresWins`. Contact every tick through `effects.progress(node)` like
`WinsPad` and `Treadmill` (ADR 0073, ADR 0080); the session reports the offer; the game holds the Wins and
decides. Kodjo's calls:

- Stepping on a lower pad you qualify for **switches you down**, as in the real game.
- With no pad ever touched the step pays the curve's `perKey`, 1.
- On a pad you do not qualify for, **nothing happens**.

The chosen value is saved with the game's other stats and shown on every popup: `+2` a step is what the pad
promised.

Each `StepPad` gets a sign above it from `worldLabel`, built once the level exists: `+N/step` large and green,
`Requires N Wins` smaller beneath, from the pad's own numbers. Not authored twice. Each `Treadmill` gets one
too — its `name` (a new string parameter, `Treadmill` by default; the real game's tiers are named) and
`×N/step` — so the two things you stand on at spawn both say what they do.

### The active pad is yellow

Kodjo asked for the chosen pad in one material and the rest in another, as in the screenshot. That needed the
game to reach a level node's **drawn meshes**, which nothing exposed: the level view kept a collider-handle →
meshes map for the camera's cutout and told nobody. `LevelView.meshesOf(handle)`, passed through `LevelHost`,
becomes **`TpsClient.meshesOf(node)`** — the same "hand over a fact" move as `partsOf` (ADR 0066): the game
swaps a material, the platform never learns what a pad is.

**Which materials is the editor's, not the code's.** A first build hard-coded a yellow and a green in the game.
Kodjo's rule, stated then and standing: anything he would plausibly tweak is a component parameter, editable in
the Inspector, never a constant. So `StepPad` has `activeMaterial` and `idleMaterial`, asset parameters picked
like a Renderer's; empty keeps the pad's own material. That needed one platform piece: the level preloaded only
the materials Renderers named, so `assetParamIds` (in `@mp/components`) now collects every asset any component
parameter names and the level loads them too, and `TpsClient.material(id)` hands a loaded one back. Every
future "pick a material on a component" is free.

## Consequences

- All eight pads from the screenshot, left of spawn, as children of one `step-pads` node: 1/0, 2/3, 5/15,
  25/100, 50/500, 100/2.5K, 250/15K, 500/50K. Two rows of four, 3 m apart.
- Every earning path pays `perStep`: ground steps at `perStep`, treadmill steps at `perStep × multiplier`.
- The nametag draws exactly as before through the new primitive.
- The pad whose value you are on wears its `activeMaterial`, the rest their `idleMaterial`, restyled the frame
  the value changes. The shipped pads name the goal yellow and the checkpoint green.
- Signs hide behind walls and players; nametags still read through the crowd.
- 8 tests: label layout (3), the gate, the session reporting a pad's offer and paying no Wins for it, and
  `assetParamIds` collecting and filtering.

## Rejected

**The primitive in `@mp/tps`.** Proposed first; the drawing has nothing of the humanoid in it.

**Screen-space signs via `toScreen`.** Constant pixel size at any distance and never occluded: a HUD, not a sign.

**Eight components.** Two numbers apart.

## Known open

- Signs are built once and never rebuilt; a pad edited live in the editor's play-test keeps its old sign until
  reload.
- `Label` as an editor-authored component, when something needs text that is not derived from data.
