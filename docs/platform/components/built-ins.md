# Built-in components

The definitions this package ships. Declaring and running one: [api.md](api.md).

| set | type | params | notes |
|---|---|---|---|
| `ENGINE_COMPONENTS` (`engine.ts`) | `Collider` | `shape: collider`, `center: vec3`, `trigger: bool` (ADR 0054) | repeatable |
| | `Mesh` | `model: asset(model)` — an asset id, or a **built-in shape** `builtin:box` / `rounded-box` / `sphere` / `capsule` sized by the node's scale (ADR 0090, `content.md`) | singleton |
| | `Renderer` | `material: asset(material)` | singleton |
| | `MaterialOverride` | `material: asset(material)` | singleton; cascades down |
| | `Spawn` | — | singleton |
| | `Light` (ADR 0047) | `kind: enum(point\|spot\|directional\|ambient\|hemisphere)`, `color`, `groundColor`, `intensity`, `range`, `decay`, `angle`, `penumbra`, `castShadow` | singleton; in `ENGINE_COMPONENTS` but **not re-exported by name** from `index.ts` |
| `GAMEPLAY_COMPONENTS` = shared (`gameplay.ts`) | `Checkpoint` | — | `onContact → effects.progress(hit.node)` |
| | `Goal` | — | no hook |
| | `Hazard` | — | `onContact → effects.kill()`; kill plane = Hazard on a trigger (ADR 0053) |
| | `Bumper` | `power: number` (26, 1–60) | `onContact → character.launch(power)` (ADR 0032) |
| | `Track` | `clip: asset(animation)`, `keys{clip:'clip'}`, `loop: enum`, `phaseMs` | no hook; loader-evaluated (ADR 0050) |
| | `Boss` (ADR 0095) | `zone: nodeRef`, `speed: number` (8, 0.5–60 m/s), `turn: number` (180, 15–720 °/s) | `moves`; chases the living player furthest through its zone. Assembling one has rules — [boss.md](boss.md) |
| `PLAYER_COMPONENTS` | `Death` | `ragdoll: bool`, `assembleStagger`, `assembleFall`, `assembleHeight` | `attachesTo: 'player'`; data read by the client (ADR 0059) |

All gameplay/player built-ins are `singleton`.

## Shared set — `packages/components/src/shared.ts` (ADR 0077)

`SHARED_COMPONENT_TYPES` = `['Boss', 'Bumper', 'Checkpoint', 'Goal', 'Hazard', 'Track']`. `isSharedComponent(type)`. `sharedComponents(types): AnyComponentDef[]` throws on a non-shared name.
