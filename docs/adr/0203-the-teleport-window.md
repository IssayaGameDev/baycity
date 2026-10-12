# ADR 0203 — The teleport window

Status: accepted. Kodjo's calls: a square Teleport button on the left edge, where the Wins counter was, which moves
to the top centre; T opens it with the mouse freed, a tap on touch; a box that slides in from the left in 0.25 s —
not full height; Start then every stage gate; a pick teleports and closes; ✕, T, Esc or a tap outside close it;
walking still works while it is open.

## Context

Stage gates (ADR 0202) need a way in. On a mouse the game hides the cursor — pointer lock is how the camera turns,
and losing it is the pause screen — so nothing on the HUD could be clicked mid-run. On touch, a tap on the left
edge landed in the move stick's zone and was also read as a thumb on it.

## Decision

- **`Shell.holdCursor(onOutside)`**: a game's window frees the mouse without pausing; a tap outside is
  `onOutside`; its release locks again. Refused while the pause screen is up, ended by it opening.
- **`UiOverlay.widgetAt`**, and the touch controls ignore a pointer that starts on a widget (`ignoreAt`).
- **`uiList` rows can be picked**, and the list drags as well as wheels.
- The window itself is Keyboard's (`teleportWindow.ts`), on these.

## Rejected

- **The mouse always free, Roblox-style**: changes how the whole game plays.
- **Full height**: covers the move stick on a phone.
- **The window over the pause screen, or a pause for it**: the world never pauses, and two screens over each other
  answer the same keys.
