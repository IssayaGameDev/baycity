# `@mp/content` — schema, loader, tracks, assets

Package `packages/content`. Headless; deps `@mp/core`, `@mp/physics`. Never imports `@mp/components`: takes capabilities as arguments (`TypeInfo`, `ParamChecker`, `ClipSource`), all satisfied structurally by a `Registry`. Public surface `packages/content/src/index.ts`. ADR 0014, ADR 0035.

## Schema — `packages/content/src/types.ts`

```ts
interface Level { id: string; config: LevelConfig; prefabs?: Record<string, Node> /* resolved in memory, not in the file */; nodes: Node[] }
interface Node {
  id: string; name?: string; transform: Transform; components: ComponentData[]; children?: Node[]
  prefab?: string                            // prefab **asset id** (ADR 0091); forbidden inside a prefab
  overrides?: Record<string, NodeOverride>   // keyed by the referenced tree's node ids, any depth
}
interface ComponentData { id: string; type: string; params: Record<string, unknown>; enabled?: boolean }
interface NodeOverride { transform?; name?; params?: Record<compId, Record<string, unknown>>; added?: ComponentData[]; removed?: compId[]; enabled?: Record<compId, boolean> }
interface Transform { position: Vec3; rotation?: Vec3 /* euler rad XYZ */; scale?: Vec3 /* baked into shapes at load */ }
type ColliderDesc = box{halfExtents} | cylinder{halfHeight,radius} | capsule{halfHeight,radius} | ball{radius} | convex{points}
interface Keyframe { t: number /* ms */; position?: Vec3; rotation?: Vec3; easing?: 'linear'|'in'|'out'|'inOut'|'step' }
interface LevelConfig { mode?: { name: string }; environment?: Partial<{ sun: SunConfig; ambient: AmbientConfig; sky: SkyConfig; postfx: PostFXConfig }>; netBounds?: number }
```

- `enabled === false` → loader and runtime skip it.
- No prefab-in-prefab (ADR 0023). Override keys are not checked against the tree; dangling = inert (ADR 0033), and so is a `prefab` no file resolves (ADR 0091).
- Keys are **offsets** from `Transform`, per channel; rotation lerps per component (ADR 0050).
- `environment` absent/partial → renderer defaults; sun is config, not a `Light` (ADR 0048).
- `unlinkPrefab(level, assetId, deps)` / `unlinkedNode(level, node, assetId, deps)` (`prefabs.ts`, ADR 0097): turn placements of one prefab into plain nodes that keep what they were drawing. `deps` carries `types`, `freshId` and `refKeysOf` — a registry is needed for singleton layering and for `nodeRef`s that must follow the re-id, which is why only the editor can do this. The inherited subtree is cloned and re-idded as one forest.
- `netBounds`: half-extent in metres that peer positions are quantized over on the wire (ADR 0093). Absent → `QUANT_BOUND` (1000 m). Step is `2 × netBounds / 65535`. The editor draws it as a box (ADR 0093); a peer outside it stops being relayed (ADR 0092).

## Resolution — `packages/content/src/nodes.ts`

| Export | Role |
|---|---|
| `COLLIDER, MESH, RENDERER, MATERIAL_OVERRIDE, SPAWN, LIGHT, TRACK` | The seven type constants the loader reads. First six = `ENGINE_COMPONENTS`; `Track` is gameplay-owned but loader-evaluated. |
| `TypeInfo { get(type) → { singleton?, moves? } \| undefined }` | What resolution needs from a registry. |
| `effectiveNode(level, node, types): Resolved` | `{ id, name, transform, components, children, inheritedCount }`. Placement keeps own `id`/`transform`; `name` falls back to prefab root's. `bakeOverrides` patches the prefab tree (returns the prefab's own object when unchanged); `layerOwn`: own **singleton** replaces inherited same type, repeatable appends. Children = inherited then own. Unknown prefab key → own layer only. |
| `walkNodes`, `componentsOfType`, `firstOfType`, `numberParam`/`vec3Param`/`stringParam`/`boolParam`, `freeTableKey` | Depth-first walk; untyped readers with fallbacks; table-key dedupe for interning prefabs. |

## Validation — `packages/content/src/validate.ts`

`validateLevel(data: unknown, checker?: ParamChecker): Level` — throws `LevelError` with a JSON-path message. Per-tree helper `validateNodeTree(node, at, { ids, table, insidePrefab, checker? })` and `checkTransform`/`checkComponents`/`checkOverrides`/`validateConfig` are exported for `ops.ts`. Always: ids non-empty, unique per tree; transforms; component ids unique per node; `prefab` key in table and not inside a prefab; override shapes; `config.mode.name` non-empty; `environment` sub-blocks (`#rrggbb`, finite numbers, booleans); `config.netBounds` a positive finite number. Params **only** with `checker` (`Registry.checkParams`). `nodeRef` targets unchecked.

## Loader — `packages/content/src/loader.ts`

```ts
instantiateLevel(world: PhysicsWorld, level: Level, types: TypeInfo, clips?: ClipSource): LoadedLevel
interface ClipSource { keys(assetId): readonly Keyframe[] | undefined }   // absent → no clip resolves
interface WorldNode { id; name; components /* resolved */; position, rotation /* world, at load */
                     colliderHandles: readonly number[] /* opaque */
                     colliders: readonly ColliderDesc[] /* world-scaled, same order as handles (ADR 0095) */
                     scope: number }
interface VisualItem { collider: ColliderDesc /* scale baked in */; position; rotation: Quat; scale: Vec3 /* world, sizes a built-in */; model?: string; material?: string; colliderHandles: number[] }
```

| `LoadedLevel` | Meaning |
|---|---|
| `config` | as authored |
| `markers: WorldMarker[]` | `{ kind: 'spawn'; position }` per `Spawn` node. Only kind. |
| `nodes` | Nodes with ≥1 enabled `Collider`, depth-first. What a mode indexes. |
| `allNodes` | Every node, same order. What the component runtime iterates. |
| `nodeOf(handle)` | Contact → node. Inverse of `colliderHandles`. |
| `findNode(from, id)` | `nodeRef` resolution: `from.scope`, then scope 0 (level). |
| `visuals`, `lights: WorldLight[]` | Draw list, light list; poses mutated by `update`/`render`. |
| `driveOf(node)` | `NodeDrive { position; rotation }` local offset (ADR 0058); only for nodes with a `moves` component. |
| `update(nowMs, ridingHandle?)`, `render(alpha)` | Kinematic tick pose (riding body posed frozen); interpolated render pose. |
| `basePose`, `baseIndex`, `basePoseOf(i, 'render'\|'tick'\|'prev')`, `baseCarry` | Movement-base lookups for the wire (ADR 0021). |

Build rules:
- Frame `animated` if `Track` duration > 0, an enabled `moves` component, or an animated ancestor → kinematic bodies; else fixed.
- `Collider.trigger` → sensor (ADR 0054), still in `colliderHandles`. Shape and `center` scaled by frame scale (box/convex exact, ball/capsule averaged). `cylinder` throws.
- Draw (ADR 0039): `Renderer`+`Mesh.model` → one visual listing all handles; `Renderer` alone → one per collider; else nothing. `MaterialOverride` cascades down over `Renderer.material`; `''` = unsurfaced. `Mesh.model` is an asset id or a **built-in shape** (below).
- Placement with inherited children opens a new `scope` (own id + prefab root id; first writer wins).
- `Track` keys: inline `keys` if non-empty, else `clips.keys(clip)`, else static.

## Ops — `packages/content/src/ops.ts` (ADR 0089)

The unit of a live edit: data, invertible, one implementation for editor, server and every peer.

```ts
interface OwnRef { table?: string; id: string }           // an authored node: the level forest, or level.prefabs[table]
interface InheritedRef { owner: string; node: string }    // a prefab-side node through one placement = the override key pair
type NodeRef = OwnRef | InheritedRef;  refKey(ref)         // 'n:id' | 't:key:id' | 'i:owner:node'
type Op = { table?: string } & (
  | setTransform | setName | setParams{patch, unset?} | setComponentEnabled | addComponent{component, index?} | removeComponent | moveComponent{to}
  | insertNode{parent|null, index, node} | removeNode | moveNode{parent|null, index} | replaceNode{node}
  | internPrefab{key, root} | dropPrefab{key}
  | setOverrideTransform | setOverrideName | setOverrideParams | setOverrideEnabled{enabled|null} | addOverrideComponent | removeOverrideComponent | setOverrideRemoved | setNodeOverride{override|null}
  | setEnvironment{environment|null} | setMode{mode|null} | setNetBounds{netBounds|null} )
invertOp(level, op): Op | null    // before apply; null = changes nothing; throws OpError for what apply would refuse
applyOp(level, op): void          // in place; validates first (structure only), throws OpError having touched nothing
applyBatch(level, ops): { ops /* that changed something */, inverses /* undo order */ }   // all-or-nothing via a scratch clone
touchedRefs(level, op): NodeRef[] // the node, or the subtree (+ inherited refs under placements in it)
```

Rules: ids and table keys are minted by the client and travel in the op; `internPrefab` on an identical entry is
a no-op and on a different one an `OpError`; `dropPrefab` of a referenced key is a no-op; a `table` op may not
insert a second root, remove the root, or touch environment/mode/netBounds; `moveNode` refuses a cycle; `insertNode` /
`replaceNode` refuse an id already in the tree. Validation reuses `validate.ts` (exported `validateNodeTree`,
`checkTransform`, `checkComponents`, `checkOverrides`, `validateConfig`); `LevelError` becomes `OpError`.
Tidying (`children: []`, emptied override records) happens here so every copy writes identical JSON.

## Tracks — `packages/content/src/track.ts` (ADR 0029)

Pure in `(behavior, base, nowMs)`. `poseAt(behavior, base, nowMs): Pose { position; rotation /* euler rad */ }` — base + sampled offset per channel; empty channel returns base. `trackDuration` = max `t`. `trackTime(duration, loop, nowMs, phaseMs)` — flooring modulo; `pingPong` spans 2×; `once` clamps. `easeAt` — `inOut` cosine, `step` = 0; easing belongs to the key a segment leaves. Keys sorted per channel at sample. `isAnimated`. Presets `moveTrack(axis, distance, periodMs)`, `spinTrack(axis, periodMs)` (cardinal axis).

## Built-in shapes — `packages/content/src/primitives.ts` (ADR 0090)

A `Mesh` whose `model` is a `builtin:` id draws a unit shape **sized by the node's world scale**, in the same
slot as an uploaded model. Scale is then the only size: the editor holds such a node's colliders at the unit
shape (`editor.md`), and the loader bakes scale into colliders anyway, so collision follows what is drawn.

```ts
BUILTIN_MODELS = ['builtin:box', 'builtin:rounded-box', 'builtin:sphere', 'builtin:capsule']
BUILTIN_LABELS: Record<BuiltinModel, string>      // 'Box' | 'Rounded box' | 'Sphere' | 'Capsule'
isBuiltinModel(id: unknown): id is BuiltinModel
unitColliderFor(id): ColliderDesc                  // box ½(.5,.5,.5) · ball r .5 · capsule h½ .5 r .5
scaleCollider(c: ColliderDesc, s: Vec3): ColliderDesc          // box/convex exact, ball/capsule averaged
builtinShape(id, scale): { collider: ColliderDesc; rounded: boolean }   // rounded only for builtin:rounded-box
PRIMITIVE_ORDER = ['box','rounded-box','platform','wall','sphere','capsule']; PRIMITIVE_PRESETS, PRIMITIVE_LABELS
```

A built-in is **never** an asset to fetch: `assetIdsIn` (`rendering.md`) and the editor's `Doc.assetIds` leave
it out, and `AssetRuntime.load` ignores one that reaches it anyway.

`scaleCollider` lives here, not in the loader: the loader, the game's `levelView`, the editor viewport and the
Project previews all run it, so what is drawn and what is collided with are one computation. Presets:
`platform` = rounded box at 3 × 0.3 × 3, `wall` = 3 × 2 × 0.3, the rest unit.

**Migration** (`migratePrimitives.ts`, run once by `deploy/editor/migrate-primitives.sh`):
`migrateNode(node) → string | null` moves a drawn box or ball's size into `transform.scale`, sets the collider
to the unit shape, divides `center` by the same factor and inserts the `Mesh`; the string is why it declined.
`migrateLevel(level, at, report)` and `migratePrefabTree(root, at, report)` walk a file into a
`MigrationReport { changed, skipped }`. Declines: a node with children, a capsule, several colliders, a prefab
node a placement overrides. Idempotent — a node that already has a `Mesh` is not a candidate.

## Prefab references — `packages/content/src/prefabs.ts` (ADR 0091)

A level names a prefab by asset id and holds no copy. `Level.prefabs` stays as the one lookup every reader
already does (`effectiveNode`), but it is an **in-memory resolution map**: filled before the level is used,
removed before it is written.

```ts
interface PrefabSource { root: (assetId: string) => Node | undefined }
prefabRefsIn(level): string[]                                    // every reference, first-seen order
hydratePrefabs(level, source): { filled: string[]; missing: string[] }   // in place; by reference, not copied
stripHydrated(level, filled): T                                  // a shallow copy without what was filled
```

Two rules carry the whole design. **Hydration never fills a reference that already resolves**, and **stripping
removes only what hydration filled** — so a level still carrying its own table keeps it, which is what let this
ship before the migration ran and what stops an unmigrated level losing its prefabs on its first write. And the
definition is assigned **by reference**: every level hydrated from one source shares one object, so an edit to a
prefab is in all of their resolutions at once.

A reference no file resolves is inert, not an error: the placement keeps its transform, draws nothing, and the
`missing` ids are what a caller reports. Resolution happens in `loadLevelInto` before `instantiateLevel` (the
game, from a bundled glob), in `openFile` (the editor, from the asset library it already holds) and in
`live.ts` `open` (the server, from the prefab store).

## Fingerprinting a level — `packages/content/src/fingerprint.ts`

Proof that a change to how a level is *stored* did not change what it *is*.

```ts
fingerprintLevel(level, types, { ids?: boolean }): string[]   // one line per resolved node: pose + every component
fingerprintGeometry(level, types): string[]                   // what it draws and collides with, sizes normalised
firstDifference(before, after): { at; before?; after? } | null
```

`fingerprintGeometry` bakes scale into colliders and resolves built-in shapes, so the two ways of writing one
size (ADR 0090) compare equal, and leaves out world scale and a name a placement inherits. It is the gate the
reference migration runs behind.

## Migrating to references — `packages/content/src/migratePrefabRefs.ts` (ADR 0091)

`matchEntry(key, entry, files)` → contents, then the same shape under other node ids (with a remap), then the
name. `migrateLevelRefs(level, at, files, types, report)` re-points every placement, remaps override keys and
completes override transforms from the node they now override — then **throws the rewrite away** unless
`fingerprintGeometry` agrees line for line. Run once by `tools/editor-server/src/migratePrefabRefs.ts` via
`deploy/editor/migrate-prefab-refs.sh`, dry by default.

## Assets — `packages/content/src/assets.ts` (ADR 0026, ADR 0028)

- `AssetKind = 'prefab' | 'texture' | 'model' | 'material' | 'shader' | 'animation' | 'sound' | 'font'`.
- Identity = sidecar `<file>.meta` → `AssetMeta { id; kind }`, written once. References by **id**, never path. Kind comes from the **path** (`kindForPath`: `.mat.json`, `.shader.json`, `.prefab.json`, `.anim.json`, else extension); sidecar `kind` not trusted.
- `AssetEntry { id; kind; path; name }`, `AssetDatabase { entries; byId }`; `buildDatabase`, `entriesFrom`, `entryFor`, `assetsOfKind`, `nameForPath`.
- `MaterialAsset { shader: 'standard' | 'unlit' | assetId; params: Record<string, MaterialValue> }`; `MaterialValue` kinds color/number/vec2/vec3/boolean/texture(`string|null`). `materialDependencies` = texture ids.
- `AnimationAsset { keys }`, `isAnimationAsset`; loop/phase stay on `Track` (ADR 0050).
- `*.prefab.json` = a `Node` root. Placing writes its **asset id** into the level; the definition stays in the file (ADR 0091, below).

## `content/` layout

| Path | Contents |
|---|---|
| `content/assets/{animations,materials,prefabs,textures}/` | `rise-4m-4s.anim.json`; 9 `*.mat.json`; `AlternatingDanger`/`FastElevator`/`Trampoline.prefab.json`; `checker.png`, `warn.png`, `sky_110_2k.webp`. Each with `.meta`. |
| `content/levels/*.json` | `config.mode.name`: parkour → default, level1, Test, FastElevator, mp-demo, mp-cointest; swing → swing; keyboard → keyboard. All set `environment.sun/ambient/sky`; keyboard also `postfx`. Loaded by `?level=<file>`, default `default.json` (ADR 0027). |
| `content/games/<game>.json` | `{ "components": string[], "settings"?: Record<string, number> }` — shared gameplay types the game opts into (ADR 0077) and its tunable numbers (ADR 0087). parkour, swing: all five; keyboard: Bumper, Hazard; `_template`: Hazard. Read by `modes/<game>/src/rules.ts` via `sharedComponents(game.components)`; appended by the editor's `adopt` (`tools/editor/src/main.ts`). |
