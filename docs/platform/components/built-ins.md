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
| | `Track` | `clip: asset(animation)`, `keys{clip:'clip'}`, `loop: enum`, `phaseMs` | no hook; loader-evaluated (ADR 0050). **Superseded by `Mover`/`Spinner`** (ADR 0103); still read while content migrates |
| | `Mover` (ADR 0103) | `move: vec3` metres from rest, `speed: number` m/s averaged over a leg, `smooth: bool`, `offset: number` cycles | no hook; loader-evaluated. **Repeatable** — offsets add, so two make a circle |
| | `Spinner` (ADR 0103) | `axis: enum` (±X ±Y ±Z), `speed: number` °/s, `offset: number` turns | no hook; loader-evaluated. Singleton, and cardinal axes only: the offset is euler radians |
| | `Boss` (ADR 0095) | `zone: nodeRef`, `speed: number` (8, 0.5–60 m/s), `turn: number` (180, 15–720 °/s) | `moves`; chases the living player furthest through its zone. Assembling one has rules — [boss.md](boss.md) |
| `PLAYER_COMPONENTS` | `Death` | `ragdoll: bool`, `assembleStagger`, `assembleFall`, `assembleHeight` | `attachesTo: 'player'`; data read by the client (ADR 0059) |

All gameplay/player built-ins are `singleton` except `Mover`.

## Motion (ADR 0103)

`Mover` and `Spinner` have no hooks. The loader reads them with `motionsOf` and evaluates
`motionOffset(motions, nowMs)` into the frame tree, which is what keeps clock-driven motion off the wire
(ADR 0013/0021). Every source of movement is an **offset** from the node's authored transform — what a
`Track` sampled, what the movers and the spinner compute, and what a component drove into `self.offset`
(ADR 0058) — so they add, and none has to know about the others.

A cycle length is **derived**: a leg takes `distance / speed` seconds, so `speed` is the average over a leg
whatever `smooth` does. `offset` is therefore a fraction of the cycle, not a time.

`movesAtAll(motions)` decides whether the node earns a kinematic body and a place in the per-tick pose pass,
alongside `isAnimated` and a `moves` declaration. A mover with no distance or no speed leaves the body fixed.

Two `Spinner`s are refused, and `axis` is an enum rather than a vec3, for one reason: euler angles about two
axes do not compose by adding, and a turn about a slanted axis is not a straight line through euler space.

## Shared set — `packages/components/src/shared.ts` (ADR 0077)

`SHARED_COMPONENT_TYPES` = `['Boss', 'Bumper', 'Checkpoint', 'Goal', 'Hazard', 'Track']`. `isSharedComponent(type)`. `sharedComponents(types): AnyComponentDef[]` throws on a non-shared name.
