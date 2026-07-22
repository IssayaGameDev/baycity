# ADR 0015 — PixiJS for all game UI

Status: accepted. Builds on the renderer split (SEED §2: Three.js world + PixiJS 2D on a
stacked canvas), which existed but was unused by the game until now.

## Context

The game is a Three.js 3D world; Three.js has no 2D UI system. We need real UI (HUD, menus,
a pause popup, later naming/chat). The choice is **DOM/HTML** vs **canvas (PixiJS)**. `@mp/render-pixi`
is already in the stack for exactly this. For canvas/2D-framework web games (Pixi/Phaser/Cocos),
in-engine canvas UI is the industry norm; DOM overlays are mainly a workaround in engines that
lack a UI layer.

## Decision

- **All game UI is PixiJS** — a transparent 2D canvas (`@mp/render-pixi`, `createHud`) stacked
  over the Three.js canvas. One rendering paradigm, UI consistent with the game's look, and
  GPU effects/particles available *on the HUD*.
- **DOM is not used for game UI.** Two bounded exceptions, neither of which is visible UI:
  1. **Dev-only tweakpane** debug panel — a tool, not shipped UI.
  2. **Hidden/transient DOM helpers** borrowed for native-only capabilities: text entry (an
     overlaid `<input>` synced to a Pixi-rendered field), clipboard, file picker, opening links.
     The UI layer never shows DOM; these are off-screen helpers.
- **Widgets are hand-rolled** on Pixi primitives (`Graphics`/`Text`/`Sprite`) for now. `@pixi/ui`
  (official component lib) is **not adopted** — it would be a new runtime dependency; revisit
  only when richer components (layout, scroll, inputs) justify it.
- **Input routing** (handled when the first interactive UI lands): the Pixi HUD canvas coexists
  with the Three canvas's pointer-lock mouselook — non-UI pointer events forward to the game, and
  a modal (pause menu) releases pointer lock while open and re-acquires it on close.

## Technical calls

- **Text input pattern:** Pixi renders the field; on focus, a transient hidden DOM `<input>`
  captures typing (native keyboard, IME, mobile soft-keyboard, clipboard, selection) and mirrors
  its value to the Pixi `Text`. This is the same mechanism `@pixi/ui`'s `Input` uses. Generalizes
  to any native-only need: draw in Pixi, borrow a hidden DOM element, sync the value.

## Consequences

- No HTML/CSS UI to maintain; UI ships as part of the render layer, resolution-scaled with the game.
- We own widgets/layout/text handling — the normal cost of canvas UI.
- **Accessibility** (screen readers / keyboard nav) and rich-text selection/reflow are unavailable
  in canvas; a hybrid DOM panel is the escape hatch *only if* we hit that wall (e.g. heavy settings).
- `@mp/render-pixi` moves from scaffolded/unused to the active UI layer.

## Rejected

- **DOM/HTML as the primary UI** — free widgets, layout, text, input, and accessibility, but a
  second paradigm beside the game canvas, an inconsistent look, and no HUD-integrated effects; off
  the canvas-UI norm for this class of game. Kept only as dev-only (tweakpane) + hidden helpers.
- **`@pixi/ui` now** — deferred (new dependency) until component needs justify it; hand-rolled
  widgets cover the near-term MVP (pause button + popup).
