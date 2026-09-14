# `@mp/components` — declarations, runtime, built-ins

Package `packages/components`. Headless; deps `@mp/content`, `@mp/core` (`@mp/physics` in tests). Content never imports it; a `Registry` is passed in as `TypeInfo`/`ParamChecker`. Public surface `packages/components/src/index.ts`. ADR 0035 (schema), ADR 0036 (runtime).

## Parameter kinds — `packages/components/src/params.ts`

`ParamSpec` union. Every spec: optional `label`, `when: { param, is[] }` (Inspector visibility only; `visibleParams`).

| kind | declares | value | check |
|---|---|---|---|
| `number` | `default`, `min?`/`max?`/`step?` (hints, **not enforced**) | `number` | finite |
| `bool` | `default` | `boolean` | |
| `string` | `default` | `string` | |
| `color` | `default` | `string` | `#rrggbb` |
| `enum` | `options: readonly O[]`, `default: O` | `O` (literal union kept) | in options |
| `vec3` | `default: Vec3` | `Vec3` | finite |
| `asset` | `of: 'material' \| 'model' \| 'animation'`, `default` (`''` = none) | `string` | string |
| `collider` | `default: ColliderDesc` | `ColliderDesc` | per kind; convex ≥ 4 points |
| `keys` | `clip?` (name of sibling `asset` param) | `readonly Keyframe[]`, default `[]` | `t` finite |
| `nodeRef` | — | `string \| null`, default `null` | target unchecked |

`readParams(decls, raw, at): Params<D>` — absent key → default; unknown key dropped; throws `ComponentError`. `defaultsOf`, `Params<D>`, `ParamDecls`, `RawParams`.

## Definition — `packages/components/src/define.ts`

```ts
defineComponent<const D extends ParamDecls, S = undefined>(spec: ComponentSpec<D, S>): ComponentDef<D>
interface ComponentSpec<D, S> {
  type: string; params: D; label?: string
  singleton?: boolean              // one per node; placement's copy replaces prefab's (effectiveNode)
  moves?: boolean                  // kinematic body + live self.offset (ADR 0058); must be declared
  attachesTo?: 'node' | 'player'   // default 'node'; 'player' hidden from the add menu (ADR 0059); not enforced at load
  init?(params, ctx): S
  onAttach?(self, ctx); onFixedUpdate?(self, ctx); onLocomote?(self, ctx, cmd: InputCommand); onContact?(self, ctx, hit: Hit); onDetach?(self, ctx)
}
```

`ComponentDef` = same minus hooks, plus `hooks?: ErasedHooks` (absent → data-only, runner skips). `HOOK_NAMES` is the one list both sides read.

## Hooks — `packages/components/src/runtime.ts`

| hook | runs on |
|---|---|
| `init` | `attach`, once; returns `self.state` |
| `onAttach` | `attach`, after `init`, tree order |
| `onFixedUpdate` | `fixedUpdate`, every sim tick, before the host's physics steps |
| `onLocomote` | `locomote` — the **movement slot** (ADR 0061): between the host's two physics half-steps, given the tick's `InputCommand` |
| `onContact` | `contact(handles)` — every node owning a handle from `collisions()`/`overlaps()`, **every tick of contact** (a stay) |
| `onDetach` | `detach`, reverse order |

Order: `loaded.allNodes` depth-first, component order within node, player's components last. Player node: no colliders (never `onContact`), `position` zero, `offset` undefined.

```ts
createComponentRuntime(loaded: LoadedLevel, registry: Registry, io: { character: CharacterAccess; effects: Effects; player?: PlayerEntity }): ComponentRuntime
interface PlayerEntity { id: string; components: readonly ComponentData[]; defs?: readonly AnyComponentDef[] /* session defs, tried before registry */ }
interface ComponentRuntime { attach(tick, timeMs, dt); fixedUpdate(tick, timeMs, dt); locomote(tick, timeMs, dt, cmd); contact(handles); detach(); count() }

interface Ctx { tick; dt; timeMs; random(): number /* hash(tick, instance, call) */; character: CharacterAccess; effects: Effects }
interface Self<D, S> { params: Params<D>; state: S /* never serialized */; node: WorldNode; get(def); find(ref); offset: NodeDrive | undefined }
interface Hit { colliderHandle: number; node: WorldNode }          // no contact normal
interface CharacterAccess { launch(speed) /* max per tick */; position(); velocity(); carry(); grounded(); push(v) /* sums per tick */ }
interface Effects { kill(): void; progress(node: WorldNode): void }
```

`characterAccess(state: CharacterLike)` adapts a character whose pending requests are fields.

**Determinism** (`runtime.ts` header, ADR 0036): hooks are pure functions of (state, synced tick, arguments). `Ctx` withholds wall clock, `Math.random`, network, DOM — use `ctx.tick`/`timeMs`/`random`. Shared cross-client state has no channel in `Ctx`; unsupported by design.

## Registry — `packages/components/src/registry.ts`

```ts
createRegistry(defs: readonly AnyComponentDef[]): Registry   // throws on duplicate type
interface Registry { has(type); get(type); all() /* declaration order = add-menu order */; defaults(type); checkParams(type, raw, at) }
```

`DEFAULT_REGISTRY` (`defaults.ts`) = engine + gameplay; fallback for unassigned/unknown-game levels and tests, not what a game runs on.

## Built-ins

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
| `PLAYER_COMPONENTS` | `Death` | `ragdoll: bool`, `assembleStagger`, `assembleFall`, `assembleHeight` | `attachesTo: 'player'`; data read by the client (ADR 0059) |

All gameplay/player built-ins are `singleton`.

## Shared set — `packages/components/src/shared.ts` (ADR 0077)

`SHARED_COMPONENT_TYPES` = `['Bumper', 'Checkpoint', 'Goal', 'Hazard', 'Track']`. `isSharedComponent(type)`. `sharedComponents(types): AnyComponentDef[]` throws on a non-shared name.

## Reading — `packages/components/src/read.ts`

`componentOn(components, def): Params<D> | undefined` (first enabled, defaults filled). `hasComponent(components, def)`. `assetParamIds(nodes, registry, of?)` — every non-empty `asset` value (preload list, ADR 0082).

## Composing a game's registry

`modes/keyboard/src/rules.ts`:

```ts
import game from '../../../content/games/keyboard.json'
export const KEYBOARD_REGISTRY = createRegistry([...ENGINE_COMPONENTS, ...PLAYER_COMPONENTS, LOCOMOTION_DEF, STEPPER_DEF, Keyboard, WinsPad, Treadmill, StepPad, ...sharedComponents(game.components)])
```

= engine + player + the game's code components + the shared names in `content/games/<game>.json`. Same shape in `modes/parkour`, `modes/swing`, `modes/_template`. The editor merges the live data file on top (`registryFor`/`adopt`, `tools/editor/src/main.ts`) since its bundle does not reload on write.
