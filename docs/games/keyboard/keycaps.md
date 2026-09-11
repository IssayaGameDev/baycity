# Keycaps

`modes/keyboard/src/keycaps.ts`, `keycapGeometry.ts`. A platform's top face becomes a board of keys
(ADR 0069). **Visual only**: caps press under every character; they pay nothing (ADR 0081).

## The component

`Keyboard` — on a level node beside its `Collider`; singleton.

| Param | Default | Meaning |
| --- | --- | --- |
| `pitch` (m) | 0.9 | centre-to-centre spacing |
| `fill` | 0.88 | cap footprint as a fraction of the pitch |
| `height` (m) | 0.45 | cap height above the face |
| `glyphs` | `A…Z` | alphabet the letters come from |
| `seed` | 1 | deterministic lettering (`glyphAt`); same seed, same board everywhere |

`boardOf(node)` → the board's frame from the box collider; `capsFor(board)` tiles whole caps only and centres
the leftover. Caps are drawn as **one `InstancedMesh` per glyph** across the whole level, `castShadow: false`,
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
