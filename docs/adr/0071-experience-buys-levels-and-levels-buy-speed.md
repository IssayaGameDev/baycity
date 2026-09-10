# ADR 0071 — Experience buys Levels, and Levels buy Speed

Status: accepted. `modes/keyboard` has the incremental loop: striking a keycap earns Experience, Experience
buys Levels, and a Level raises the speed cap. A HUD shows the first two.

## Context

The game being cloned shows two numbers and its own name for the first one is wrong for us.

An earlier reading of the research had **one** number: "+1 Speed per step", which also drove how fast you
moved. That produced a model where a player would be moving at 345,510 — and a whole analysis of tick rates and
tunneling that followed from it.

Kodjo's screenshot of his own save settled it. **345.51K Speed, Level 45, 33.84K / 46.85K** toward the next
level, and in the corner **"Your Max Speed: 100 / Current speed: 100"** with a box to type into. So:

- the big number is a **currency**, not a velocity;
- **Level** is derived from it and is what gates the worlds;
- **Max Speed** is derived from Level and is the actual velocity;
- and the player *chooses* a current speed up to that cap, which is the precision-versus-reach tension made
  explicit.

## Decision

**Three values, and only one of them is a speed.** Named accordingly, which is Kodjo's call and the reason this
ADR is not called "speed":

| | |
| --- | --- |
| **Experience** | The currency. +1 per keycap struck, times multipliers. `XP` on screen. |
| **Level** | Derived from Experience. Cannot be bought. |
| **Max Speed** | `baseMaxSpeed + maxSpeedPerLevel × Level`, in studs/s. The velocity. |

The word "speed" now means a velocity everywhere in the game's code. The currency is `Experience` in code and
docs and **`XP` in the UI**, because a counter is read at a glance and the long word crowds out the number that
is the whole point.

### The curve is fitted to a real save, not invented

Level costs escalate geometrically. From the screenshot: levels 1–45 cost ~311,670 between them while level 46
alone costs 46,850, which fits **×1.15 per level with level 1 at ~100**. Max Speed is **exactly** linear — two
readings, level 45 → 100 and level 46 → 102, so `10 + 2 × Level`.

Both directions are closed form. Level 400 is a real target in this genre, and summing four hundred terms every
frame to fill a progress bar would be four hundred terms too many.

Kodjo's save is the **test fixture**, which is a better one than any invented case: a curve that cannot
reproduce those numbers is not the game's curve. Tolerances are deliberately loose, because the curve was
*fitted* to one screenshot and agreeing exactly would mean it had been reverse-engineered rather than fitted.

### Level owns `moveSpeed`, and says so

`moveSpeed` had two would-be owners: the debug pane binds it live, and Level writes it every frame. Rather than
let them fight (ADR 0057), the game keeps **its own** `CharacterTuning` object — not `DEFAULT_TUNING`, which
every other game in the build shares — and the pane's `move speed` slider is documented as the one dead control
here. One dead slider beats two owners quietly overwriting each other.

`groundAccelTime`, `groundStopTime` and `airControl` are deliberately *not* scaled with it. Leaving them fixed
while `moveSpeed` climbs is what makes a fast character floaty and hard to steer, which is the game's skill
curve rather than a bug in it.

### Experience is the game's own save

Its own `localStorage` key, not `PlayerProgress` — that holds a checkpoint index and belongs to the platform's
save shape. Experience is this game's stat, so it lives in this game, the same reasoning that put the rope in
`modes/swing` rather than on `ModeDescriptor` (ADR 0065). Written on a 3-second timer rather than per key,
because a struck cap is a `localStorage` write and there are several a second.

### The HUD needed one platform handle

`TpsClient.ui` — the 2D overlay. The same Pixi layer the pause screen and touch controls are on (ADR 0015),
because a second Pixi application would mean a second canvas, a second stacking order and a second resize to
keep in step. `@mp/render-pixi` re-exports `Container` and `Graphics` for it, the way `@mp/render-three`
re-exports THREE, so a game drawing a HUD shares one pinned Pixi.

Layout is from the screenshot: the counter big and centred with the Level bar directly under it. Redrawn only
when a number changes — Pixi text is a texture upload per change. It re-places itself by comparing the
overlay's size, because `UiOverlay` has no resize *event*, only a `resize()` the shell calls.

## Consequences

- The loop plays: walk on keys, XP climbs, the bar fills, Level ticks, the character gets faster.
- Level 1 gives 12 studs/s ≈ **3.4 m/s**, slower than the shipped 5.5. Deliberate — it is what makes the first
  levels feel like progress — and it catches up around level 5.
- **Only the local player's presses earn.** Every character's keys go down; one player's are paid for.
- 11 tests, fixtured on the real save.
- Sliders for the whole curve, plus a reset.

### A bug the tests caught

On an exact level boundary the log-inverse returned 3.9999999 and floored to **3** — the player would see the
previous level with a completely full bar at the instant they bought the next one. Nudged before flooring.

## Rejected

**One number.** The mistake this replaces.

**Speed 1:1 with velocity.** What "+1 Speed" implies, and what the save disproves. Had it been true, our 30 Hz
tick would have needed substepping — Roblox runs physics at 240 Hz and bumps fast bodies there precisely to
stop them tunneling. Max Speed 100 at level 45 is 0.93 m per tick, so the question does not arise until roughly
World 3's level 400.

**A sublinear mapping from the currency to velocity.** Would have solved a problem that turned out not to
exist.

**Adding `speed` to `PlayerProgress`.** A game's stat in the platform's save shape.

**Letting both the pane and Level write `moveSpeed`.** Two sources for one value (ADR 0057).

## Known open

- **No speed picker.** The player always runs at Max Speed; the real game lets you dial it down for precision,
  which is half the tension.
- **No ceiling.** Kodjo's call for now. Nothing resets Experience and nothing caps it.
- **No multipliers, Wins, rebirth or treadmills**, all of which the real game stacks on `perKey`.
- **Level gates nothing**, there being one stage.
- **Nothing migrates an old save.** The key was renamed with the concept.

## Correction

**Max Speed never reached the character.** `main.ts` wrote `moveSpeed` into the game's own `CharacterTuning` —
the object on the descriptor — every frame. `startTpsClient` copies that object on the way in (ADR 0057) and
the controller reads the copy, so the write landed on an object nobody read. Kodjo reached level 52 at the
shipped 5.5 m/s and asked. An earlier "yes, it works" was given without checking.

Fix: `TpsClient.tuning` is the live copy, and the game writes there. The "Level owns `moveSpeed`" section above
describes the intent; the mechanism it describes (the game's own object, the pane binding it) was wrong about
which object the pane and the controller share. The game no longer keeps a named tuning object of its own — the
descriptor carries a starting copy of `DEFAULT_TUNING`, and the live one is the client's.
