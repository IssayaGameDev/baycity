# World 1 — the design values

Kodjo's numbers from the real game, the reference for building and balancing World 1 (ADR 0087). A stage is a
**speed gate**: below the speed its obstacle needs you fall and restart the level; at or above it you clear it.
Length is the course's business, not a balance value. Level at each speed is read off the default speed curve
(`10 + 2 × Level` studs/s, [balance.md](balance.md)); it moves if the curve does.

| Stage | Obstacle | Speed needed (studs/s) | Level (default curve) | Wins paid |
| --- | --- | --- | --- | --- |
| 1 | Floor gaps, timed jumps | 1 · at 65+ run straight across, no jumping | 0 | 1 |
| 2 | Boss arena, run past one side | 8 | 0 | 3 |
| 3 | Rolling ball on a slope | 10 | 0 | 10 |
| 4 | Parkour path | 15 · at 100+ one jump skips it, 250+ run straight through | 3 | 20 |
| 5 | Disappearing bridge with countdown | 20 | 5 | 50 |
| 6 | Chocolate tsunami | 30 | 10 | 100 |
| 7 | Opening/closing walls, timed gate | 35 | 13 | 150 |
| 8 | Descending obstacle, straight speed check | 45 | 18 | 300 |
| 9 | Mixed jumps and runs | 55, comfortable at 60+ | 23 | 500 |
| 10 | Boss chase | 70, hard gate | 30 | 1 000 |
| 11 | Spiral with wall shortcut | 70–110 | 30–50 | 2 500 |
| 12 | Boss chase, 5-second head start | 70–110 | 30–50 | 10 000 |
| 13 | Precision gap jumps, gravity zone | 100–120 | 45–55 | 25 000 |
| 14 | Fast tsunami | 110, hard gate | 50 | 50 000 |
| 15 | Door opening sequence, mixed obstacles | 120+ | 55 | not given |

Fixed alongside:

- **Step pads at spawn**: the current eight, +1 at 0 Wins to +500 at 50K Wins ([pads.md](pads.md)). The last
  pad unlocks with stage 14.
- **Treadmills**: only ×1 is free; the other tiers are bought with real money, so they sit outside the XP balance.
- **Worlds**: World 2 opens at Level 120, World 3 at 400. A world is a pair of multipliers on the global curves:
  measured World 2 ≈ ×550 XP per step and ×⅓ speed at Level 219 (300 → 99 studs/s, 1.35 B → 741 B per step).
- **Rebirth**: resets XP and Level, keeps Wins and every multiplier; allowed at a Level per rebirth (10, 50, …),
  pays a permanent XP multiplier per rebirth (×2, ×5, …). Built: [rebirth.md](rebirth.md), these as the curves' defaults.
- **Trails**: 15 of them, one equipped, bought with Wins: from ×1.5 XP at 500 Wins to ×3 M XP at 250 B Wins. Not built.
- **Auras**: one equipped, bought with Wins: from ×1.2 XP at 1 M Wins to ×8.5 XP at 1 B Wins. Not built.
- **Per step**: `1 × stepPad × treadmill × world × rebirth × trail × aura × item`.
- **No checkpoints** in any world: a fall is the start of the level.
- **Surfaces**: a world is entered through a **portal** in the level, not built; a rebirth is triggered from a **menu
  icon** on screen, the Rebirth button.
- **Time per clear**: 5 to 45 seconds a stage, shrinking with the player's speed.

Machine copy for the simulator: `modes/keyboard/balance.world1.json` (`balance.test.ts` asserts it matches this
table). Open: Wins for stage 15 (irrelevant for now); the required speeds are read by eye from play and will move
with the speed curve.
