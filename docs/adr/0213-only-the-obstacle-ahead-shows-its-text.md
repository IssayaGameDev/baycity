# ADR 0213 — Only the obstacle ahead shows its text

Status: accepted. Kodjo's design and calls.

## Decision

- **Two texts per Obstacle**: `requiredLevelText` (was `sign`, renamed — a placement re-picks it once) reads
  "Requires Level X"; `safeZoneText` keeps its own words.
- **Hidden at the start, in the game.** In the editor both show as authored.
- **One at a time — the obstacle ahead's**: its safe zone text, and its required-level text instead while inside its
  trigger. From the spawn, the first Obstacle is ahead.
- **Leaving a trigger says which way** (Kodjo: leaving could be going back): past its pivot along the way its teleport
  point faces, the next one is ahead; short of it, the same one still is.
- **0.3 s linear fades.**
- The platform side: `LoadedLevel.textItemOf(node)`, `LevelTexts.setShown(item, 0–1)` applied at once — a game sets
  it after the frame's sync, and the frame is drawn after both, so a text hidden from the start never shows for one
  frame — and `TpsClient.textShown(node, shown)`, beside `meshesOf`.

## Rejected

- **Exit by any face** — leaving backward would have shown the next obstacle's text.
- **The trigger's own blue arrow as forward** — every trigger turned to the course, where the teleport point already
  faces the way on.
- **Two texts at once while on an obstacle** — Kodjo: only the one ahead.
