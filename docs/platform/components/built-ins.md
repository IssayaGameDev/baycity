# Built-in components

The definitions this package ships, **one component per file** (ADR 0174): `src/engine/`, `src/shared/`, `src/player/`, each
with an `index.ts` holding its set. A game's own components live in `modes/<game>/src/components/`, one per file.
Declaring and running one: [api.md](api.md). Add Component folders (`menu`, ADR 0178): Collider — Physics;
Mesh Renderer, MaterialOverride, Light — Rendering; Spawn, Checkpoint, Hazard, Bumper, Boss — Gameplay; Sequence —
Animation. A game's own components have none, and go under the game's name.

| set | type | params | notes |
|---|---|---|---|
| `ENGINE_COMPONENTS` (`engine/`) | `Collider` | `shape: collider`, `center: vec3`, `trigger: bool` (ADR 0054) | repeatable |
| | `Renderer`, shown as **Mesh Renderer** (ADR 0153) | `model: asset(model)` — an asset id, or a **built-in shape** `builtin:box` / `rounded-box` / `sphere` / `capsule` sized by the node's scale (ADR 0090, `content.md`); `''` draws the colliders. `material: asset(material)` | singleton |
| | `MaterialOverride` | `material: asset(material)` | singleton; cascades down |
| | `Spawn` | — | singleton |
| | `Light` (ADR 0047) | `kind: enum(point\|spot\|directional\|ambient\|hemisphere)`, `color`, `groundColor`, `intensity`, `range`, `decay`, `angle`, `penumbra`, `castShadow` | singleton; in `ENGINE_COMPONENTS` but **not re-exported by name** from `index.ts` |
| `SHARED_COMPONENTS` (`shared/`) | `Checkpoint` | — | `onContact → effects.progress(hit.node)` |
| | `Hazard` | — | `onContact → effects.kill()`; kill plane = Hazard on a trigger (ADR 0053) |
| | `Bumper` | `power: number` (26, 1–60) | `onContact → character.launch(power)` (ADR 0032) |
| | `Sequence` (ADR 0137) | `name`, `clock: enum(shared\|local)`, `axes: enum(object\|level)`, `loop: enum(restart\|yoyo)`, `times: number` (0 = forever), `offset: number` cycles, `stages: stages` | no hook; **repeatable**; loader-evaluated (ADR 0141). Shared: adopted by a game the first time one is added to its level (ADR 0077). Edited as boxes in the Inspector (ADR 0143) |
| | `Boss` (ADR 0095) | `zone: componentRef(Collider)` (ADR 0177), `speed: number` (8, 0.5–60 m/s), `turn: number` (180, 15–720 °/s) | `moves`; chases the living player furthest through its zone. Assembling one has rules — [boss.md](boss.md) |
| `PLAYER_COMPONENTS` (`player/`) | `Death` | `ragdoll: bool`, `assembleStagger`, `assembleFall`, `assembleHeight` | `attachesTo: 'player'`; data read by the client (ADR 0059) |

All shared/player built-ins are `singleton` except `Sequence`.

## Motion (ADR 0137)

`Sequence` has no hook: the loader evaluates it into the frame tree as a pure function of the synced clock,
which is what keeps clock-driven motion off the wire (ADR 0013/0021). What it moves a node by is an
**offset** from the authored transform, as is what a component drives into `self.offset` (ADR 0058), so the
two add and neither has to know about the other. The rules are `sequences.md`.

## Shared set — `packages/components/src/shared/index.ts` (ADR 0077)

`SHARED_COMPONENT_TYPES` = `['Boss', 'Bumper', 'Checkpoint', 'Hazard', 'Sequence']`. `isSharedComponent(type)`. `sharedComponents(types): AnyComponentDef[]` throws on a non-shared name.
