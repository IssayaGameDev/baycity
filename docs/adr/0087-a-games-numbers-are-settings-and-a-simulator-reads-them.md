# ADR 0087 — A game's numbers are settings, and a simulator reads them

Status: accepted. `ModeDescriptor.settings` declares a game's tunable numbers; the editor edits them in the
Game row; they live in `content/games/<game>.json` under `settings`; `readSettings` lays the file over the
defaults. Keyboard declares its whole progression curve this way. `modes/keyboard/src/balance.ts` simulates a
player through the curve and prints when each Level, pad and stage arrives.

## Context

Kodjo wants to solidify the balance, then lay content out for it. The curve's numbers were fitted to the real
game one at a time and were code constants: a change meant a commit and a deploy, and nothing showed the
numbers together — nobody could say when a new player reaches Level 10 or affords the ×2 pad. The reference
data is "extremely far from complete", so the numbers will move.

## Decision

- **Settings are data, declared by the game.** `SettingDecl { label, default, min?, max?, step?, hint? }` per
  key on the descriptor; the editor renders one field per declaration, generic across games, and writes the
  game's file whole (components and settings together — writing the list alone dropped the settings, and
  `adopt` now spreads the file). Keyed by name, so a renamed key is a new setting with its default, and an
  undeclared key in the file is ignored.
- **Not components.** A curve is game-wide, not a node's. The game file already existed for game-wide data
  (ADR 0077).
- **The file is not seeded.** No `settings` block is written until the editor changes one; defaults live in
  code. Adding keys to `content/games/keyboard.json` from master would be the one write both branches make
  (ADR 0083), so it is not made.
- **The simulator uses the game's own functions**, never a second model. It adds time. A CLI reads the curve
  from the game file and the pads from the level; stage lengths are Kodjo's input because the path a level
  runs is not something the level file states.

## Rejected

- A debug-pane readout of the simulation in-game. Later if wanted; the table is the tool now.
- Settings on the level. The curve is the game's, not a level's; two levels with two curves is not the game.

## Consequences

- `docs/games/keyboard/balance.md` owns the table of settings and the simulator.
- `GAME_CURVE` (`rules.ts`) replaces `DEFAULT_CURVE` in `main.ts` and `editorMode.ts`; the headless
  `STEPPER_DEF` keeps `DEFAULT_CURVE`.
- The hosted editor needs a redeploy to show the fields; the game needs none to read a saved value.
