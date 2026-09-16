# Keycaps

`modes/keyboard/src/keycaps.ts`, `keycapGeometry.ts`. A platform's top face becomes a board of keys
(ADR 0069). **Visual only**: caps press under every character; they pay nothing (ADR 0081).

## The component

`Keyboard` — on a level node beside its `Collider`; singleton.

| Param | Default | Meaning |
| --- | --- | --- |
| `glyphs` | `A…Z` | alphabet the letters come from |
| `seed` | 1 | deterministic lettering (`glyphAt`); same seed, same board everywhere |

**The geometry is the game's, not the platform's** (ADR 0115). `pitch`, `fill` and `height` are settings in
`content/keyboard/game.json`, one field each in the editor's Game row, read by `GAME_KEYS` (`rules.ts`) and
handed to `drawKeycaps`. A level is thousands of platforms: a pitch per platform is a pitch to change per
platform, and two that disagree cannot align however the grid is anchored. Old components still carrying a
`pitch` are unaffected — `readParams` walks the declarations, not the file's keys, so nothing needed rewriting.

| Setting | Default | Range |
| --- | --- | --- |
| `keyPitch` (m) | 0.9 | 0.05–3 |
| `keyFill` | 0.88 | 0.3–1 |
| `keyHeight` (m) | 0.45 | 0.005–1.5 |

`boardOf(node)` → the board's frame from the box collider; `capsFor(board)` takes the cells of a **shared
world lattice** that fall on the face (ADR 0115). Cell centres are multiples of the pitch measured along the
board's own axis from the world origin (`axisCells`), so no platform decides its own phase and no two can be
out of step — any sizes, any positions.

Centring was the bug: a 5 m board at 0.9 fitted five columns spanning 3.6 m and split the 0.5 m leftover as
margin, so the next board placed edge to edge left 1.4 m between the nearest caps and lining them up needed an
overlap of `width mod pitch`.

**A cell belongs to the board its centre is on** (ADR 0116), over the half-open span `[-half, +half)` so a
centre on a shared edge goes to one board and never both. Every cell of a compound ground therefore gets
exactly one cap, at any sizes and any positions — measured at pitch 1, widths 5, 4, 3.7, 6.25 and 9 all join
with spacing 1.0. The price is at an **outer** rim, where a cap can overhang by up to half its footprint;
cosmetic, since caps are visual only. A platform narrower than a cap gets the cell whose centre lands on it.

Requiring the whole footprint to fit was tried first and reversed: it dropped a cap unless the seam landed
within 5.4 cm of a cell boundary, so 88% of seam positions lost a row and the platforms had to be aligned to
the grid rather than the other way round.

**Axis-aligned only**; two boards with different yaw cannot share a lattice. **Lettering still restarts per
board** (`glyphAt` is keyed on the per-board column and row), left alone deliberately. Caps are drawn as **one `InstancedMesh` per glyph** across the whole level, `castShadow: false`,
`receiveShadow: true`, `DynamicDrawUsage`. Geometry: `keycapGeometry(shape)` — superellipse outline, taper 0.82,
dish 0.28, 12 segments, 2 dish rings (~84 tris); top face UVs into the legend tile, walls sample one flat point
(so the letter is only on top, reads correctly from behind).

## Pressing

`drawKeycaps(client, look, shape, feel)` → `Keycaps { hold, sweep, update, ready, dispose }`.

- `hold(centre, radius)`: every cap under a footprint of `radius` at `centre` is `held` this frame; returns the
  **tops** of caps newly struck (nobody reads them for Experience any more).
- `sweep(from, to, radius)`: `hold` along a path, sampled no wider than `radius` (`sweepPoints`); a jump longer
  than `MAX_SWEEP = 4` m is a teleport and presses nothing. Called per character per frame with the sole's last
  and current position (`lastSole` in `main.ts`).
- `capsUnder(boards, caps, centre, radius, reach = DEFAULT_REACH 0.35)`: the caps whose top is within `reach`
  of the sole's height. The sole is **the torso's height less a rig constant** (`TORSO_ABOVE_GROUND` in
  `main.ts`), not the drawn feet, which float at long strides (ADR 0079 known open).
- `advancePress(cap, feel, dt)` (pure, tested): down toward 1 while `held` or `committed`, up toward 0
  otherwise. A struck cap is `committed` until fully down, so a one-frame footfall still bottoms out.

```ts
DEFAULT_PRESS = { depth: 0.7, downTime: 0.05, upTime: 0.65 }   // depth = fraction of cap height
DEFAULT_KEYCAP_LOOK = { cap: 0xe8e6e1, ink: 0x2b2b31 }
```

`update(dt)` builds the boards on the first frame the level exists (it arrives with the first snapshot), then
animates only active caps and uploads only dirty instance matrices.

## Peers

Every drawn character presses caps (`client.partsOf(id)` for self and each peer). Peers' presses are visual;
their Experience is theirs.
