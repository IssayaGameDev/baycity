# ADR 0223 — The simulator plays the World

Status: accepted. Step 2 of shaping Keyboard's balance (ADR 0222): the simulator reads only what the designer sets.

## Context

The simulator of ADR 0088 read its own scenario file — a stage table from the Roblox game, trails and auras that do not
exist — and played a player who ran the furthest passable stage, cleared in a fixed 45-to-5 seconds. Its World 1 took 7
minutes, and nothing in it was the level being built.

## Decision

- **Its inputs are the game's**: the curves and the pad table from `game.json`, each world from its level's `World`.
  The scenario file is gone; with no World anywhere, a World's defaults.
- **A run is a row's**: its run time at the gate, shrinking with speed, never under its floor — a 19-second door stays
  19 s. The gate is its Level's Max Speed times the world's multiplier.
- **A run fails** with the row's chance (Kodjo's call: a fail % over a count of falls); a failed run costs half a run
  and the trip back, both visible options (`--fail-cost`, `--overhead`).
- **The player pushes the next stage when it can, else farms the reached stage paying the most Wins a minute**
  (Kodjo's call, over the furthest passable).
- **Only what is built**: pads, rebirth, world base XP and speed. Trails and auras join when they exist.

## Rejected

- **A count of falls per clear**: Kodjo thinks in a chance of failing.
- **Geometry-measured run times**: a timer or a door is no path length (Kodjo).
- **Recorded playtests as the player model**: too little data, stale on every edit, and the level answering to the
  data rather than to the design.
