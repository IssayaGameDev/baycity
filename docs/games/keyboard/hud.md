# HUD

`modes/keyboard/src/hud.ts` on the client's Pixi overlay (`client.ui`, ADR 0071); `popups.ts` for the
per-step labels (ADR 0072).

## Layout

Bottom-centre, from Kodjo's screenshot of the real game:

| Element | Where | Text |
| --- | --- | --- |
| XP counter | centred above the bar, 40 px bold | `<abbrev> XP` |
| Speed | right of the counter, 22 px | `Speed <studs/s>` (the speed you run at) |
| Level bar | 520×46 px, bottom margin 22 | fill = `into / next` |
| Level | inside the bar, left | `Level N` |
| Progress | inside the bar, right | `<into> / <next>` |
| Wins | left edge, vertically centred, 26 px | `<abbrev> Wins` |

Redrawn only when a value changes (Pixi text is a texture upload). Re-laid-out when `client.ui.width/height`
change, compared per frame (`UiOverlay` has no resize event).

## Scaling

One factor for everything (`hudScale`, `barWidthFor`, tested in `hud.test.ts`):

```
k = clamp(min(width / 960, height / 540), 0.55, 1)
barWidth = min(520 × k, width − 2 × 18 × k)
```

Bar, type sizes and margins all multiply by `k`. Desktop 960×540 and above: 1. iPhone landscape 844×390:
0.72. Portrait 390×844: 0.55.

## Popups

`createPopups(client, feel)`: screen-space labels projected once at spawn with `client.toScreen(world)` from
the feet (`standing(parts)`), then animated in overlay pixels. Pool of 48, longest-lived recycled.

```ts
DEFAULT_POPUP = { life: 0.85, rise: 90, sway: 14, sways: 1.25, pop: 1.45, hold: 0.35, size: 26, color: 0xffe9a8 }
```

Text is `+<value paid>`: `+1` on the ground at the default pad, `+9` on a ×9 treadmill at `perStep` 1, `+N Wins`
from a Wins pad's top.
