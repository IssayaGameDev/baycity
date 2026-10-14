# ADR 0221 — Rebirth

Status: accepted. Kodjo's design, every call his; `world-1.md` held the outline: resets XP and Level, keeps Wins and
every multiplier, a Level per rebirth (10, 50, …), a permanent XP multiplier per rebirth (×2, ×5, …), a menu icon.

## Decision

- **Two curves in the game's settings**, with the rest of the balance (Kodjo: "something we need to have control
  over"): the Level each rebirth needs, and the XP multiplier after it. The multiplier curve holds the **whole**
  multiplier, so whether rebirths stack is what the designer draws. Ratio segments that extend: there is always a next.
- **The cost is the Level only**; no Wins are paid.
- **Nothing else resets**: Wins, the step pad, the checkpoints reached, the position.
- **A window from a button on the left edge, under Teleport** — where every button of the game goes. It shows the
  Level needed, the multiplier now and after, that it resets your Level, your Level against the one needed, and the
  Rebirth button, greyed until the Level is reached. A rebirth closes it. Our own look, after a Roblox screenshot.
- **Saved through the game's adapter**, `keyboard.rebirths`.
- **The simulator rebirths by the same curves**; its scenario's rebirth table is gone.

## Rejected

- **A stack-or-replace switch**: the multiplier curve already says which.
- **A table setting kind** (rows of Level and multiplier): a new kind of field in the games window, where the curve
  editor already edits this shape.
