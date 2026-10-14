# Rebirth

`modes/keyboard/src/rebirthWindow.ts`, the curves in `progression.ts`, wired in `main.ts` (ADR 0221, Kodjo's calls).

## The curves

Two of the game's curves ([progression.md](progression.md)), edited in the editor's games window (Settings) with the
rest of the balance, stored in `content/keyboard/game.json` `settings`:

| Key | Label | x | y | Shape | Default |
| --- | --- | --- | --- | --- | --- |
| `rebirthLevel` | Rebirth Level | rebirth (1 the first) | Level it needs | ratio, extends, log y, ≥ 1 | 1 → 10, 2 → 50 |
| `rebirthMultiplier` | Rebirth XP multiplier | rebirth | XP × after it — the whole, not on top of the last | ratio, extends, log y, ≥ 1 | 1 → 2, 2 → 5 |

Past the last point each carries on at its last segment's ratio, so there is always a next rebirth (on the
defaults: 250 for ×12.5). `rebirthLevelAt(n)` rounds to a whole Level, at least 1; `rebirthMultiplierAt(0)` = 1.

## What it does

The cost is the Level and nothing else (no Wins). At `rebirthLevelAt(rebirths + 1)`, a rebirth sets `experience = 0`
(Level 0, and Max Speed with it) and `rebirths += 1`, then `persist()` — `keyboard.rebirths` through the adapter.
**Nothing else resets** (Kodjo's call): Wins, the step pad's `perStep`, the checkpoints reached, where you stand.

Every step pays `perStep × rebirthMultiplierAt(rebirths)` on the ground, and the treadmill's value times it
(`main.ts` `payOut`); the popup says what it paid (`shortAmount`). The simulator rebirths by the same curves
([balance.md](balance.md)).

## The window

```ts
rebirthView(level, rebirths, curve): { level, need, now, next, ready, fraction }   // pure; ready = level >= need
createRebirthWindow(client, { view, rebirth, onOpen }): { close, dispose }
```

| | |
| --- | --- |
| the button | `uiButton` **Rebirth**, purple, 84 px square × `hudScale`, the left edge's second slot (`sideButtonY(1)`, under Teleport — every button of this game goes down that edge, `sideButtons.ts`); toggles |
| the box | 320 × 300 px × `hudScale`, vertically centred, sliding in from the left as Teleport's does (`stepSlide`, `slideOut`); its background static, so a tap on it is not "outside" |
| in it | **Rebirth** and ✕; `Level <need>` (yellow); `×<now> XP  →  ×<next> XP` (`multiplierText`); "Rebirth resets your Level"; a bar of `level / need` reading `Level <level> / <need>`; the action |
| the action | green **Rebirth** when ready; grey **Need Level <need>**, which does nothing, until then. Taken: rebirths and closes |
| live | `view()` asked every frame while it is out; repainted when it changes — the Level climbs while you walk |
| closes | a rebirth, ✕, the button, Esc or a tap outside (the hold's `onOutside`), or the teleport window opening (`onOpen`, both ways: one box on the left edge at a time) |
