# `@mp/components` — declarations, hooks, runtime, registry

What the built-ins are: [built-ins.md](built-ins.md). The one component with its own page: [boss.md](boss.md).

Package `packages/components`. Headless; deps `@mp/content`, `@mp/core` (`@mp/physics` in tests). Content never imports it; a `Registry` is passed in as `TypeInfo`/`ParamChecker`. Public surface `packages/components/src/index.ts`. ADR 0035 (schema), ADR 0036 (runtime).

## Parameter kinds — `packages/components/src/params.ts`

`ParamSpec` union. Every spec: optional `label`, `when: { param, is[] }` (Inspector visibility only; `visibleParams`).

| kind | declares | value | check |
|---|---|---|---|
| `number` | `default`, `min?`/`max?`/`step?` (hints, **not enforced**) | `number` | finite |
| `bool` | `default` | `boolean` | |
| `string` | `default` | `string` | |
| `color` | `default`, `optional?` (ADR 0182: `''` allowed, read as auto) | `string` | `#rrggbb`, or `''` when optional |
| `enum` | `options: readonly O[]`, `default: O` | `O` (literal union kept) | in options |
| `vec3` | `default: Vec3` | `Vec3` | finite |
| `asset` | `of: 'material' \| 'model' \| 'data'`, `dataType?` (a data field's type, ADR 0181), `default` (`''` = none) | `string` | string |
| `collider` | `default: ColliderDesc` | `ColliderDesc` | per kind; convex ≥ 4 points |
| `stages` | `default: readonly Stage[]` | a sequence's stages of steps (ADR 0137) | whole, by `stagesProblem` (`sequences.md`) |
| `string` `multiline` (ADR 0189) | `multiline?: true` | `string` | the Inspector draws a text area: Enter a new line, leaving it saves |
| `list` (ADR 0182) | `item: ParamDecls` (a row's fields), `default: rows` | `readonly Params<item>[]` — each row read and defaulted as parameters are | an array of objects, each row by `readParams(item)`, naming `key[n].field` |
| `nodeRef` | — | `string \| null`, default `null` | target unchecked |
| `componentRef` (ADR 0177) | `of: string` — the component type it takes | `ComponentRef \| null` = `{ node, component }` (a node id, found in the reference's scope as a `nodeRef` is, and one of its components by id), default `null` | shape; target unchecked. A bare node id — the old shape, until the box's content is migrated — reads as `{ node, component: '' }`: the node's first of the type |

`readParams(decls, raw, at): Params<D>` — absent key → default; unknown key dropped; throws `ComponentError`. `defaultsOf`, `Params<D>`, `ParamDecls`, `RawParams`.

## Data types — `packages/components/src/data.ts` (ADR 0181)

```ts
defineDataType<const D extends ParamDecls>(def: DataTypeDef<D>): DataTypeDef<D>
interface DataTypeDef<D> { type: string; label?: string; menu?: string /* New data path, 'Keyboard/Keyboard Style' */; fields: D }
newDataAsset(def): DataAsset                       // every field at its default — what New data writes
readData(def, asset, at): Params<D> | undefined     // typed, defaulted; undefined for none or another type; throws on a bad value
dataMenuPath(def): string[]                        // menu split on '/', else [label ?? type]
```

Unity's ScriptableObject classes. Fields are `ParamSpec`s, read and defaulted as a component's; `nodeRef`,
`componentRef`, `stages` and `collider` mean nothing without a scene and are not drawn. A game declares its own
(`ModeDescriptor.dataTypes`); a data asset of one lives only in that game's library.

## Definition — `packages/components/src/define.ts`

```ts
defineComponent<const D extends ParamDecls, S = undefined>(spec: ComponentSpec<D, S>): ComponentDef<D>
interface ComponentSpec<D, S> {
  type: string; params: D; label?: string
  menu?: string                    // its Add Component folder (ADR 0178): Physics | Rendering | Gameplay | Animation; absent = its game's
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
| `onContact` | `contact(handles)` — every node owning a handle from `touching()`/`collisions()`/`overlaps()` (each once), **every tick of contact** (a stay). Touching is the character's touch skin (ADR 0188): ridden, pushing or landed on counts, whichever moved |
| `onDetach` | `detach`, reverse order |

Order: `loaded.allNodes` depth-first, component order within node, player's components last. Player node: no colliders (never `onContact`), `position` zero, `offset` undefined.

```ts
createComponentRuntime(loaded: LoadedLevel, registry: Registry, io: { character: CharacterAccess; effects: Effects; player?: PlayerEntity }): ComponentRuntime
interface PlayerEntity { id: string; components: readonly ComponentData[]; defs?: readonly AnyComponentDef[] /* session defs, tried before registry */ }
interface ComponentRuntime { attach(tick, timeMs, dt); fixedUpdate(tick, timeMs, dt); locomote(tick, timeMs, dt, cmd); contact(handles); detach(); count() }

interface Ctx { tick; dt; timeMs; random(): number /* hash(tick, instance, call) */; character: CharacterAccess; effects: Effects
                players(): readonly PlayerView[] }   // ADR 0095
interface PlayerView { id: number /* 0 = self */; position: Vec3; isSelf: boolean; alive: boolean }
interface Self<D, S> { params: Params<D>; state: S /* never serialized */; node: WorldNode; get(def); find(ref); findComponent(ref, def); offset: NodeDrive | undefined }
// findComponent(ref: ComponentRef | null, def: ComponentDef<O>) → { node: WorldNode; params: Params<O>; collider: ColliderDesc | undefined } | undefined
//   (ADR 0177): the node as `find` finds it, then its enabled components of def's type by id ('' = the first); for a
//   Collider, `collider` is its world-scaled shape — the same index into `node.colliders`. Undefined when off, gone, or another type.
interface Hit { colliderHandle: number; node: WorldNode }          // no contact normal
interface CharacterAccess { launch(speed) /* max per tick */; position(); velocity(); carry(); grounded(); push(v) /* sums per tick */ }
interface Effects { kill(): void; progress(node: WorldNode): void }
```

`characterAccess(state: CharacterLike)` adapts a character whose pending requests are fields.

**Determinism** (`runtime.ts` header, ADR 0036): hooks are pure functions of (state, synced tick, arguments). `Ctx` withholds wall clock, `Math.random`, network, DOM — use `ctx.tick`/`timeMs`/`random`. Shared cross-client state has no channel in `Ctx`; unsupported by design.

**`ctx.players()` is the one exception, and it is not deterministic** (ADR 0095). Own body first (`id: 0`, `alive` from `io.alive()`), then peers from `io.peers()` — the relayed, ~100 ms interpolated stream, `alive` from `STATE_DEAD` — so two clients can differ by centimetres at the same tick. Legitimate for chasing, aiming, ranking, looking at; never for anything that must be agreed. Safe in this stack because each client decides its own death (ADR 0011), exactly as a `Hazard` does. Self-only where `io.peers` is absent: anything offline. Rebuilt once a tick and the array reused, so do not keep it past the hook.

## Registry — `packages/components/src/registry.ts`

```ts
createRegistry(defs: readonly AnyComponentDef[]): Registry   // throws on duplicate type
interface Registry { has(type); get(type); all() /* declaration order = add-menu order */; defaults(type); checkParams(type, raw, at) }
```

`DEFAULT_REGISTRY` (`defaults.ts`) = engine + gameplay; fallback for unassigned/unknown-game levels and tests, not what a game runs on.

## Reading — `packages/components/src/read.ts`

`componentOn(components, def): Params<D> | undefined` (first enabled, defaults filled). `hasComponent(components, def)`. `assetParamIds(nodes, registry, of?)` — every non-empty `asset` value (preload list, ADR 0082).

## Composing a game's registry

`modes/keyboard/src/rules.ts`:

```ts
import game from '../../../content/keyboard/game.json'
export const KEYBOARD_REGISTRY = createRegistry([...ENGINE_COMPONENTS, ...PLAYER_COMPONENTS, LOCOMOTION_DEF, STEPPER_DEF, Keyboard, WinsPad, Treadmill, StepPad, ...sharedComponents(game.components)])
```

= engine + player + the game's code components + the shared names in `content/<game>/game.json`. Same shape in `modes/_template`. The editor merges the live data file on top (`registryFor`/`adopt`, `tools/editor/src/main.ts`) since its bundle does not reload on write.
