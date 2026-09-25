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
| `color` | `default` | `string` | `#rrggbb` |
| `enum` | `options: readonly O[]`, `default: O` | `O` (literal union kept) | in options |
| `vec3` | `default: Vec3` | `Vec3` | finite |
| `asset` | `of: 'material' \| 'model'`, `default` (`''` = none) | `string` | string |
| `collider` | `default: ColliderDesc` | `ColliderDesc` | per kind; convex ≥ 4 points |
| `stages` | `default: readonly Stage[]` | a sequence's stages of steps (ADR 0137) | whole, by `stagesProblem` (`sequences.md`) |
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
  retired?: boolean                // still read, never offered: its job moved into another (Mesh, ADR 0153)
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

interface Ctx { tick; dt; timeMs; random(): number /* hash(tick, instance, call) */; character: CharacterAccess; effects: Effects
                players(): readonly PlayerView[] }   // ADR 0095
interface PlayerView { id: number /* 0 = self */; position: Vec3; isSelf: boolean; alive: boolean }
interface Self<D, S> { params: Params<D>; state: S /* never serialized */; node: WorldNode; get(def); find(ref); offset: NodeDrive | undefined }
interface Hit { colliderHandle: number; node: WorldNode }          // no contact normal
interface CharacterAccess { launch(speed) /* max per tick */; position(); velocity(); carry(); grounded(); push(v) /* sums per tick */ }
interface Effects { kill(): void; progress(node: WorldNode): void }
```

`characterAccess(state: CharacterLike)` adapts a character whose pending requests are fields.

**Determinism** (`runtime.ts` header, ADR 0036): hooks are pure functions of (state, synced tick, arguments). `Ctx` withholds wall clock, `Math.random`, network, DOM — use `ctx.tick`/`timeMs`/`random`. Shared cross-client state has no channel in `Ctx`; unsupported by design.

**`ctx.players()` is the one exception, and it is not deterministic** (ADR 0095). Own body first (`id: 0`, `alive` from `io.alive()`), then peers from `io.peers()` — the relayed, ~100 ms interpolated stream, `alive` from `STATE_DEAD` — so two clients can differ by centimetres at the same tick. Legitimate for chasing, aiming, ranking, looking at; never for anything that must be agreed. Safe in this stack because each client decides its own death (ADR 0011), exactly as a `Hazard` does. Self-only where `io.peers` is absent: the editor's play-test and anything offline. Rebuilt once a tick and the array reused, so do not keep it past the hook.

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

= engine + player + the game's code components + the shared names in `content/<game>/game.json`. Same shape in `modes/parkour`, `modes/swing`, `modes/_template`. The editor merges the live data file on top (`registryFor`/`adopt`, `tools/editor/src/main.ts`) since its bundle does not reload on write.
