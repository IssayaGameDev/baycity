# ADR 0205 — Esc steps back one state

Status: accepted. Amends ADR 0015/0065 (pointer lock is the pause state). Kodjo's calls: Esc while playing shows
the mouse; Esc with the mouse showing opens the pause screen; Esc there goes back to the mouse; a click on empty
space plays again, and a click on a button only presses it.

## Context

A HUD button could only be clicked with the mouse out, and the only way to get it out was Esc — which opened the
pause screen, to be closed again before the button could be reached. The teleport button (ADR 0203) made it daily.

## Decision

- **Losing the lock is the mouse showing**, never the pause screen; a second Esc opens it.
- **The shell owns Esc** (`escapeAction`): a game window closes first, then the pause screen, then the mouse brings it
  up. The Esc that let the lock go is ignored for 250 ms, however the browser orders that key and the lock change.
- A click on empty space locks again, as before; on a widget it is the widget's.

## Rejected

- **The mouse always out, the camera on a right-drag (Roblox's)**: changes how the game plays; Kodjo keeps the
  locked camera.
- **Hold Alt to show the mouse**: a second key to learn, beside browser shortcuts that use Alt.
