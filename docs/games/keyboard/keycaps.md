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
`content/keyboard/game.json`, one field each in the editor's Game row, read by `keyGeometryFrom(settings)`
(`keycaps.ts`; `GAME_KEYS` in `rules.ts` is that applied to the bundled file) and handed to `drawKeycaps`. A level is thousands of platforms: a pitch per platform is a pitch to change per
platform, and two that disagree cannot align however the grid is anchored. Old components still carrying a
`pitch` are unaffected — `readParams` walks the declarations, not the file's keys, so nothing needed rewriting.

| Setting | Default | Range |
| --- | --- | --- |
| `keyPitch` (m) | 0.9 | 0.05–3 |
| `keyFill` | 0.88 | 0.3–1 |
| `keyHeight` (m) | 0.45 | 0.005–1.5 |
| `keyBudget` (caps per board) | 20 000 | 1 000–100 000 |

`KeyGeometry = { pitch, fill, height, maxKeys }` (`maxKeys` ← `keyBudget`).

`boardGrid(size, geometry)` → `SurfaceGrid | null`: the cell grid a box face carries, **whole cells only and
the leftover split between the two edges**, so each platform's board is centred on itself. `null` for a face
with no room for one whole cell, and for a board of more than `maxKeys` cells or a non-finite size — **no
caps at all**, in the game and in the preview (ADR 0142). `boardOf(node)` builds the runtime board's frame on it; `capsFor(board)` tiles
the caps.

One copy of that arithmetic on purpose: the editor previews the same grid (ADR 0120) through
`keyboardGridOf` — this game's `ModeDescriptor.surfaceGrid`, which decides from the node's own components
whether a surface is a board and reads the pitch from the settings the editor currently holds. A test asserts
`boardGrid` and `boardOf` agree cell for cell, because a preview computing its own answer is a preview that can
lie about where the keys go.

Two platforms edge to edge therefore do not continue each other. A world lattice was tried and reverted
(ADR 0118): it moved the caps off centre on every platform, and a clean join then needed platforms sized and
placed to the grid instead of the other way round — either a missing row at 88% of seam positions, or caps
overhanging an outer rim by half a key. What came out of that attempt and stayed: the geometry as a game
setting, and corner snapping in the editor (ADR 0117), which is what makes a box's edges land on the grid at
all.

Caps are drawn as **one `InstancedMesh` per glyph** across the whole level, `castShadow: false`,
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
