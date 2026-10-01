# Keycaps

`modes/keyboard/src/components/keyboard.ts` (the component), `keycaps.ts`, `keycapGeometry.ts`. A platform's top face becomes a board of keys
(ADR 0069). **Visual only**: caps press under every character; they pay nothing (ADR 0081).

## The component

`Keyboard` — on a level node beside its `Collider`; singleton.

| Param | Default | Meaning |
| --- | --- | --- |
| `glyphs` | `A…Z` | alphabet the letters come from |
| `seed` | 1 | deterministic lettering (`glyphAt`); same seed, same board everywhere |
| `style` | none | a Keyboard Style data asset (ADR 0181), shared by the boards naming it: its key colours (below); none, the plain look |
| `facing` | `forward` | which way the letters' tops point, along the node's own axes: forward blue +Z, right red +X, back, left (ADR 0182) |

**The geometry is the game's, not the platform's** (ADR 0115). `pitch`, `fill` and `height` are settings in
`content/keyboard/game.json`, one field each in the editor's games window (Settings), read by `keyGeometryFrom(settings)`
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
setting. Corner snapping (ADR 0117) came out of it too and has gone: a move snaps a box's centre (ADR 0179), so
an odd-sized platform's edges fall between grid lines.

Caps are drawn as **one `InstancedMesh` per glyph** across the whole level, `castShadow: false`,
`receiveShadow: true`, `DynamicDrawUsage` — the **still** boards'. A board whose visual is `animated` (a sequence
drives it or anything above it) is carried instead (below). Geometry: `keycapGeometry(shape)` — superellipse outline, taper 0.82,
dish 0.28, 12 segments, 2 dish rings (~84 tris); top face UVs into the legend tile, walls sample one flat point
(so the letter is only on top, reads correctly from behind). The letters' facing is the cap's own turn about its
board's up, `facingTurns(facing)` quarter turns (`capsFor`); a press re-composes from the decomposed turn.

**Key colours (ADR 0182).** The legend texture is a **stencil** (`glyphTexture`: white letter on black, the wall tile
black, `NoColorSpace`); each mesh's geometry carries two instance attributes, `capColor` and `inkColor` (linear, from
the sRGB hex), and `paintShader` replaces `map_fragment` with `diffuseColor.rgb *= mix(vCapColor, vInkColor, stencil)`
— still meshes and riding ones (`paintShader` then `rideShader`). No extra draw call for any palette.
`keyColoursAt(style, seed, col, row, plain)` (`keyColours.ts`, pure, tested) picks each key's row by weight with
`cellHash(seed, col, row, salt)` — `glyphAt`'s mixing, salted — takes its letter colour or `autoInk(cap)` (whichever of
`AUTO_DARK` 0x2b2b31 / `AUTO_LIGHT` 0xf2f0ea contrasts more, WCAG), and moves the cap's brightness by up to
±`jitter`. No style, no rows or no weight: the plain look, `DEFAULT_KEYCAP_LOOK`. A board's style is read by
`main.ts`'s `styleOf(id)` = `readData(KeyboardStyle, client.data(id))`, one that will not read warned and left plain.

| Keyboard Style field | | |
| --- | --- | --- |
| `keys` | list: `cap` colour, `letter` colour (optional, `''` auto), `weight` (≥ 0) | default one row, `#e8e6e1` / `#2b2b31` / 1 — the plain look |
| `jitter` | number 0–0.3 | each cap's brightness ±this fraction; 0 off |

## Pressing

`drawKeycaps(client, look, shape, feel, keyGeometry, styleOf)` → `Keycaps { hold, sweep, update, ready, dispose }`.

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
follows the carried boards and animates only active caps, uploading only dirty instance matrices.

## Carried boards (ADR 0154)

A board a sequence carries has its caps built where it was at load into **riding** meshes, one per glyph, each
cap tagged with its board's slot (`boardSlot`). `state`, a float `DataTexture` of `STATE_TEXELS = 5` texels per
board (the transform since load, by column, then the opacity), is written by `follow()` each frame and uploaded
only when a row changed.

| | |
| --- | --- |
| `carry(visual, restInverse, delta, toRest)` | pure: `delta` = the visual's pose now (position, rotation, `drawScale` — the level view's) × the pose at load inverted; `toRest` its inverse. `false` when not drawn (`!visible`, or `fades` at opacity 0), and `delta` folds every cap to a point |
| `rideShader(shader)` | `MeshStandardMaterial`'s sources, patched: `boardSlot` → a row → `#define instanceMatrix boardInstance` at the top of `main`, so every chunk that places by it (`defaultnormal_vertex`, `project_vertex`, `worldpos_vertex`) is carried; `diffuseColor.a *= vBoardOpacity` after `color_fragment`. Throws if three's sources lose either hook |
| riding material | `transparent` from the start; shares the glyph's texture with the still mesh |
| riding mesh | not frustum-culled; the cap geometry's attributes shared, not copied |
| footfalls | `Board.moving = { toRest, hidden }`: `capsUnder` skips a hidden board and takes the foot through `toRest` first; a struck cap's top goes back out through `delta` |

The cost is a few texel fetches per vertex of a carried cap and up to 26 draw calls; none of it per cap on the
CPU, and nothing for a still board.

## Peers

Every drawn character presses caps (`client.partsOf(id)` for self and each peer). Peers' presses are visual;
their Experience is theirs.
