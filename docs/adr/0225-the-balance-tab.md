# ADR 0225 — The Balance tab: the simulated run against the targets

Status: accepted. Step 3 of shaping Keyboard's balance (ADR 0222, ADR 0223): targets to shape against, in the editor.

## Context

The simulator (ADR 0223) said when each stage, rebirth and world lands, but only as a command-line report, and nothing
said when they should land. Kodjo wants to change a number and see every milestone against his intent, without playing.

## Decision

- **A target is minutes into the game, where its moment is set** (Kodjo's call): a `target` column on each World stage
  row (its first clear) and `targetToEnter` on the World (entering it); rebirths in a game setting beside the rebirth
  curves, `rebirthTargets`, row n rebirth n. 0 is none.
- **A Balance tab in the games window** (Kodjo's call, beside Settings), for a game whose descriptor has `balance`
  (`BalanceDecl`, `@mp/mode`): the game's options and a `report(settings, levels, options)` of moments, the window's
  only to draw. A table a world, then Rebirths: target, simulated, how far off.
- **On target within 10 %** (Kodjo's call), else early or late, coloured; a target never reached is *not reached*.
- **The player is editable there** (Kodjo's call): moving %, what a failed run costs, the seconds back to a stage, each
  from today's default, kept while the editor is open. Not saved: they are a question asked of the numbers, not one.
- **It re-runs on every change**: an option (once a frame while dragged), a setting (anyone's). The levels are read when
  the tab shows — the open one live, the rest the server's copy. The run stops once every stage and every rebirth with
  a target has come, and at 24 h of play otherwise (65 ms).

## Rejected

- **One target table in Settings for everything**: a stage there is a number, which a reordered World silently
  re-points.
- **A chart**: harder to read an exact time from, and more to build; a table first.
- **Targets taken from the Roblox game**: not a build question — it is which numbers are typed.
