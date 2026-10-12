# `@mp/content` — schema, loader, tracks, assets

Package `packages/content`. Headless; deps `@mp/core`, `@mp/physics`. Never imports `@mp/components`: takes capabilities as arguments (`TypeInfo`, `ParamChecker`), both satisfied structurally by a `Registry`. Public surface `packages/content/src/index.ts`. ADR 0014, ADR 0035.

## Schema — `packages/content/src/types.ts`

```ts
interface Level { id: string; config: LevelConfig; prefabs?: Record<string, Node> /* resolved in memory, not in the file */; nodes: Node[] }
interface Node {
  id: string; name?: string; transform: Transform; components: ComponentData[]; children?: Node[]
  enabled?: boolean                          // absent = on; false = this node and its subtree are not built (ADR 0099)
  prefab?: string                            // prefab **asset id** (ADR 0091); forbidden inside a prefab
  overrides?: Record<string, NodeOverride>   // keyed by the referenced tree's node ids, any depth
}
interface ComponentData { id: string; type: string; params: Record<string, unknown>; enabled?: boolean }
interface NodeOverride { transform?; name?; params?: Record<compId, Record<string, unknown>>; added?: ComponentData[]; removed?: compId[]; enabled?: Record<compId, boolean>
                         nodeEnabled?: boolean; removedNodes?: string[]; addedChildren?: Node[]; childOrder?: string[]
                         sequences?: Record<compId, SequenceOverride> /* sequences.md, ADR 0139 */ }
interface Transform { position: Vec3; rotation?: Vec3 /* euler rad XYZ */; scale?: Vec3 /* baked into shapes at load */ }
type ColliderDesc = box{halfExtents} | cylinder{halfHeight,radius} | capsule{halfHeight,radius} | ball{radius} | convex{points}
interface Keyframe { t: number /* ms */; position?: Vec3; rotation?: Vec3; easing?: 'linear'|'in'|'out'|'inOut'|'step' }
interface LevelConfig { mode?: { name: string }; environment?: Partial<{ sun: SunConfig; ambient: AmbientConfig; sky: SkyConfig; postfx: PostFXConfig }>; netBounds?: number; cameraSeeThrough?: boolean }
```

- `enabled === false` → loader and runtime skip it.
- No prefab-in-prefab (ADR 0023). Override keys are not checked against the tree; dangling = inert (ADR 0033), and so is a `prefab` no file resolves (ADR 0091).
- Keys are **offsets** from `Transform`, per channel; rotation lerps per component (ADR 0050).
- `environment` absent/partial → renderer defaults; sun is config, not a `Light` (ADR 0048).
- `unlinkPrefab(level, assetId, deps)` / `unlinkedNode(level, node, assetId, deps)` (`prefabs.ts`, ADR 0097; one placement at a time through `Doc.unlinkNode`, ADR 0111): turn placements of one prefab into plain nodes that keep what they were drawing. `deps` carries `types`, `freshId` and `refKeysOf` — a registry is needed for singleton layering and for the reference parameters (`nodeRef`, `componentRef`) that must follow the re-id, which is why only the editor can do this. `retargetRef(value, to)` re-points one: a node id, or a `componentRef`'s node — its component keeps its id, as a copy's components do (ADR 0177). The inherited subtree is cloned and re-idded as one forest; `nodeRef`s and sequence step targets follow the map, in that forest **and** on the placement's own components (a root sequence targets the root's children, ADR 0139).
- `netBounds`: half-extent in metres that peer positions are quantized over on the wire (ADR 0093). Absent → `QUANT_BOUND` (1000 m). Step is `2 × netBounds / 65535`. The editor draws it as a box (ADR 0093); a peer outside it stops being relayed (ADR 0092).
- `cameraSeeThrough`: `true` = the game camera holes what is in its way and keeps its distance (ADR 0055); absent = it is stopped by it (ADR 0020). Only `true` is written (ADR 0148).

## Resolution — `packages/content/src/nodes.ts`

| Export | Role |
|---|---|
| `COLLIDER, MESH, RENDERER, MATERIAL_OVERRIDE, SPAWN, LIGHT, SEQUENCE` | The type constants the loader reads. First six = `ENGINE_COMPONENTS`; `Sequence` is gameplay-owned but loader-evaluated (ADR 0141), declared in `sequenceData.ts` and re-exported here; `patchComponents` applies a placement's `sequences` record to its `stages` (ADR 0139). |
| `TypeInfo { get(type) → { singleton?, moves? } \| undefined }` | What resolution needs from a registry. |
| `effectiveNode(level, node, types): Resolved` | `{ id, name, transform, components, children, inheritedCount }`. Placement keeps own `id`/`transform`; `name` falls back to prefab root's. `bakeOverrides` patches the prefab tree (returns the prefab's own object when unchanged); `layerOwn`: own **singleton** replaces inherited same type, repeatable appends. Children = inherited then own. Unknown prefab key → own layer only. |
| `walkNodes`, `componentsOfType`, `firstOfType`, `numberParam`/`vec3Param`/`stringParam`/`boolParam`, `freeTableKey` | Depth-first walk; untyped readers with fallbacks; table-key dedupe for interning prefabs. |

## Validation — `packages/content/src/validate.ts`

`validateLevel(data: unknown, checker?: ParamChecker): Level` — throws `LevelError` with a JSON-path message. Per-tree helper `validateNodeTree(node, at, { ids, table, insidePrefab, checker? })` and `checkTransform`/`checkComponents`/`checkOverrides`/`validateConfig` are exported for `ops.ts`. Always: ids non-empty, unique per tree; transforms; component ids unique per node; `prefab` key in table and not inside a prefab; override shapes; `config.mode.name` non-empty; `environment` sub-blocks (`#rrggbb`, finite numbers, booleans); `config.netBounds` a positive finite number; `config.cameraSeeThrough` a boolean. Params **only** with `checker` (`Registry.checkParams`). `nodeRef` targets unchecked.

## Loader — `packages/content/src/loader.ts`

```ts
instantiateLevel(world: PhysicsWorld, level: Level, types: TypeInfo): LoadedLevel
interface WorldNode { id; name; components /* resolved */; position, rotation /* world, at load */
                     colliderHandles: readonly number[] /* opaque */
                     colliders: readonly ColliderDesc[] /* world-scaled, same order as handles (ADR 0095) */
                     scope: number }
interface VisualItem { collider: ColliderDesc /* scale baked in */; position /* a model's: the node's pivot, ADR 0207 */; rotation: Quat; scale: Vec3 /* world, sizes a built-in and a model */; model?: string; material?: string; colliderHandles: number[]
                      visible: boolean; opacity: number; drawScale: Vec3 /* mutated per tick by sequences */; fades: boolean; animated: boolean /* at load; animated = a sequence drives it or above, ADR 0154 */ }   // ADR 0141
interface WorldLight { …; position; rotation; visible: boolean /* off while its node is disabled */ }
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
| `update(nowMs, ridingHandle?, opensTick = true)`, `render(alpha)` | Kinematic tick pose (riding body posed frozen); interpolated render pose, from where the **tick** began: a tick's later slices pass `opensTick: false` and move only `curr` (ADR 0185). Sequences (ADR 0141): `shared` on `nowMs`, `local` on `nowMs −` the first `update`'s; collider shapes re-set when the scale changed, bodies switched with `shown && solid`; `render` interpolates `drawScale` and `opacity` too. |
| `texts` | Every enabled `Text` (ADR 0189): `TextItem` = `textOf`'s `TextDesc` (its `font` an asset id, `''` Roboto; `textFontRefusal(path)` refuses a woff2, ADR 0190) + `node`, `position`/`rotation` (the node's origin), `scale` (world, at load), `drawScale`, `visible`, `opacity` — mutated by `update`/`render` through a dynamic of its own when the frame is animated, as a light's |
| `shove(character)` | ADR 0186: pushes the character out of every solid, shown mover that came into it over the last `update` — each swept from its last slice's pose (`slicePos`/`sliceRot`) by the motion it gave the capsule's centre (its turn there as well as its travel), `touchedBy` → the rest of that motion + `SHOVE_SKIN` 0.02 m, summed, one `push` ignoring those movers. Already inside at the slice's start (`0`) pushes nothing: pinned, it passes through (Kodjo's call). The ridden base pushes too — the ride places by an absolute point, so a push first is not added to. Turns are swept in pieces of at most `SHOVE_TURN` 5° (a sweep is a straight line at a fixed facing). Called after `update` and **before** the step: the pushers are then posed frozen (`poseFrozen`), because the character controller otherwise pushes again by a touched body's whole last step (ADR 0188) |
| `basePose`, `baseIndex`, `basePoseOf(i, 'render'\|'tick'\|'prev')`, `baseCarry` | Movement-base lookups for the wire (ADR 0021). `baseIndex` is `undefined` for a piece a `local` sequence moves (ADR 0141); `basePose` still carries a rider on it here. |

Build rules:
- Frame `animated` if a sequence moves it (below), an enabled `moves` component, or an animated ancestor → kinematic bodies; else fixed.
- `Collider.trigger` → sensor (ADR 0054), still in `colliderHandles`. Shape and `center` scaled by frame scale (box/convex exact, ball/capsule averaged). `cylinder` throws.
- Draw (ADR 0153): an enabled `Renderer` with a model → one visual listing all handles, **at the node's pivot** and sized by its world scale (ADR 0207) — it rides the first body when that body sits on the pivot, else a body-less dynamic of its own; with none → one per collider; no `Renderer` → nothing. The model is `modelOf(components)` (`nodes.ts`): the enabled `Renderer`'s `model`. There is no `Mesh` component any more; a file naming one does not load. `MaterialOverride` cascades down over `Renderer.material`; `''` = unsurfaced. A model is an asset id or a **built-in shape** (below).
- Placement with inherited children opens a new `scope` (own id + prefab root id; first writer wins).
- **Sequences** (ADR 0141, `sequences.md`): each enabled `Sequence` compiled once. A frame is moved by its own aimed at `SELF` and its parent's aimed at its id. Any ⇒ `animated`. Posed at level time 0 while building, so what starts off is built off. Flags fixed at load: `scaling` (a scale track here or above ⇒ colliders re-shaped), `fading` (a fade here ⇒ `VisualItem.fades`), `localOnly` (a `local` sequence moving it or above ⇒ no `baseIndex`). Per tick: `shown` (not disabled here **or above**), `solid` (collider not switched off **here**), `drawScale` = world scale ÷ load scale, `opacity` = the fade here.

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
  | setOverrideNodeEnabled | setOverrideNodeRemoved | insertOverrideChild | setOverrideChildOrder
  | setOverrideSequence{componentId, override|null}
  | setEnvironment{environment|null} | setMode{mode|null} | setNetBounds{netBounds|null} | setCameraSeeThrough{seeThrough /* false removes the key */}
  | setNodeEnabled{id,enabled} | setOverrideNodeEnabled{owner,node,enabled|null} )
invertOp(level, op): Op | null    // before apply; null = changes nothing; throws OpError for what apply would refuse
applyOp(level, op): void          // in place; validates first (structure only), throws OpError having touched nothing
applyBatch(level, ops): { ops /* that changed something */, inverses /* undo order */ }   // all-or-nothing via a scratch clone
touchedRefs(level, op): NodeRef[] // the node, or the subtree (+ inherited refs under placements in it)
```

Rules: ids and table keys are minted by the client and travel in the op; `internPrefab` on an identical entry is
a no-op and on a different one an `OpError`; `dropPrefab` of a referenced key is a no-op; a `table` op may not
insert a second root, remove the root, or touch environment/mode/netBounds/cameraSeeThrough; `moveNode` refuses a cycle; `insertNode` /
`replaceNode` refuse an id already in the tree. Validation reuses `validate.ts` (exported `validateNodeTree`,
`checkTransform`, `checkComponents`, `checkOverrides`, `validateConfig`); `LevelError` becomes `OpError`.
Tidying (`children: []`, emptied override records) happens here so every copy writes identical JSON.

**A placement can differ from its prefab in any way a node can** (ADR 0135), and each difference is recorded
on the **piece** it applies to, which is what makes it work at any depth: values and components (ADR 0098),
the node switched off (ADR 0099), the piece **removed** (`removedNodes`, ADR 0133), children **added**
(`addedChildren`, ADR 0130 generalised), the child **order** (`childOrder`), and a sequence's stages and steps
(`sequences`, keyed by component id — `sequences.md`, ADR 0139).

An added child is an ordinary authored node that lives in an override record — at the placement's own level
in the record of the prefab's **root** (one storage, ADR 0151; `children` and `components` on a placement are
ADR 0130's storage, still read, no longer written). `childrenFor(node, over, overrides)` is the one place a
placement's children are resolved (prefab's, minus removed, plus added, in `childOrder`), exported so
`bakeOverrides` and the editor's tree walk cannot disagree. `childOrder` is a preference: missing ids are
skipped and unnamed children keep their place at the end, so a prefab gaining a piece does not invalidate it.

**The one walk and the one list** — `tree.ts` (ADR 0151), types-only imports:

```ts
childListsOf(n): Node[][]        // n.children, then every record's addedChildren
forEachNode(roots, visit)        // depth-first over both
idsUnder(n): string[];  addedIdsOf(placement): Set<string>
OVERRIDE_FIELDS                  // every NodeOverride field → 'value' | 'map' | 'list'; a Record over the type's keys, so a new field must be listed
overrideFieldEmpty(over, f); overrideFieldsSet(over): OverrideField[]
```

Every walker uses them: `find`/`idsIn`/`subtreeIds`/`contains`/`refersTo`/`touchedRefs` (`ops.ts`),
`prefabRefsIn` and `unlinkPrefab` (`prefabs.ts`), the server's holds (`live.ts`), and the editor's re-id,
copy, paste, reference count and component-type scans. `tidyOverride` drops every empty field from the table.
In `ops.ts`, `find` reports the **record** holding an added child: `removeNode`'s inverse is then
`insertOverrideChild` back into it, and `moveNode` refuses one (its undo could not address the record).
`checkOverrides(value, at, checker, ctx?)` validates `addedChildren` as nodes of the tree in `ctx` (ids unique
level-wide) and `removedNodes` / `childOrder` as id lists. `unlinkedNode` keeps the ids of what the placement
added, re-minting only the prefab's.

## Motion — `sequences.md` (ADR 0137)

A node moves by its sequences; how the loader runs them is `sequences.md`. What a node adds is an **offset**
from its authored transform, and a component's drive (`NodeDrive`, ADR 0058) adds to it.

`motionSlices(fromMs, toMs, maxStep)`: how many equal slices a tick needs so nothing travels more than
`maxStep` between two of them (ADR 0104). `1` when still or slow; capped at 8. Position only; a frame's
sequences add. Level-wide: one fast mover slices every tick for the whole level, so a slice must never move
where `render` blends from (`update`'s `opensTick`, ADR 0185). A sequence restarting in the span adds nothing.

**A restart is a cut** (ADR 0206). `update` marks a frame `cut` when one of its sequences `restartsBetween` the
last `update`'s clocks and these — or its parent is cut (parents come first in `frames`). A cut dynamic is posed
frozen (`setPosition`, so Rapier derives no velocity), its slice pose and its blend-from pose are set to where it
is now — `shove` sweeps nothing, `render` draws it at the start at once, `baseCarry` gives a rider nothing — and
the next `update` moves on as usual. Whoever is where it reappears is inside it, as with any teleport.
`cut(colliderHandle)` says so for a body; the host drops a rider on one (`leaveBase`, Kodjo's call: left behind).

## Built-in shapes — `packages/content/src/primitives.ts` (ADR 0090)

A `Renderer` whose `model` is a `builtin:` id draws a unit shape **sized by the node's world scale**, in the same
slot as an uploaded model. Scale is then the only size: the editor holds such a node's colliders at the unit
shape (`editor.md`), and the loader bakes scale into colliders anyway, so collision follows what is drawn.

```ts
BUILTIN_MODELS = ['builtin:box', 'builtin:rounded-box', 'builtin:sphere', 'builtin:capsule', 'builtin:quad']
BUILTIN_LABELS: Record<BuiltinModel, string>      // 'Box' | 'Rounded box' | 'Sphere' | 'Capsule' | 'Quad'
isBuiltinModel(id: unknown): id is BuiltinModel
unitColliderFor(id): ColliderDesc                  // box ½(.5,.5,.5) · ball r .5 · capsule h½ .5 r .5 · quad ½(.5,.5,QUAD_HALF_DEPTH .005)
scaleCollider(c: ColliderDesc, s: Vec3): ColliderDesc          // box/convex exact, ball/capsule averaged
builtinShape(id, scale): { collider: ColliderDesc; rounded: boolean }   // rounded only for builtin:rounded-box
PRIMITIVE_ORDER = ['box','rounded-box','platform','wall','sphere','capsule','quad']; PRIMITIVE_PRESETS, PRIMITIVE_LABELS
```

A built-in is **never** an asset to fetch: `assetIdsIn` (`rendering.md`) and the editor's `Doc.assetIds` leave
it out, and `AssetRuntime.load` ignores one that reaches it anyway.

`scaleCollider` lives here, not in the loader: the loader, the game's `levelView`, the editor viewport and the
Project previews all run it, so what is drawn and what is collided with are one computation. Presets:
`platform` = rounded box at 3 × 0.3 × 3, `wall` = 3 × 2 × 0.3, the rest unit. A **quad** (ADR 0189) is Unity's: one
face toward +Z, drawn one-sided as a plane its scale sizes, colliding as a box a centimetre thick — a texture on
its material shows once.

**Component fields** (`migrateComponentRefs.ts`, run once by `deploy/editor/migrate-component-refs.sh`, ADR 0177):
`migrateLevelComponentRefs(level, at, deps, report)` / `migratePrefabComponentRefs(root, at, deps, report)` turn a
component field saved as a bare node id — Boss's `zone`, an object field until then — into `{ node, component }`:
the node's first enabled box Collider (what the old read took), else its first of the type; resolved as the runtime
scopes it (a prefab in itself, a level's own node among its own, a placement's record among its pieces then the
level's). `deps` = `{ refsOf(type), prefabOf(id) }`; `report` = `{ changed, left }`, the runner writes nothing while
anything is left.

**Migration** (`migratePrimitives.ts`, run once by `deploy/editor/migrate-primitives.sh`):
`migrateNode(node) → string | null` moves a drawn box or ball's size into `transform.scale`, sets the collider
to the unit shape, divides `center` by the same factor and sets the `Renderer`'s `model` (a `Mesh` when it ran, ADR 0153); the string is why it declined.
`migrateLevel(level, at, report)` and `migratePrefabTree(root, at, report)` walk a file into a
`MigrationReport { changed, skipped }`. Declines: a node with children, a capsule, several colliders, a prefab
node a placement overrides. Idempotent — a node that already draws a model is not a candidate.

## Prefab references — `packages/content/src/prefabs.ts` (ADR 0091)

A level names a prefab by asset id and holds no copy. `Level.prefabs` stays as the one lookup every reader
already does (`effectiveNode`), but it is an **in-memory resolution map**: filled before the level is used,
removed before it is written.

```ts
interface PrefabSource { root: (assetId: string) => Node | undefined }
prefabRefsIn(level): string[]                                    // every reference, first-seen order
relinkPrefabs(level, hasAsset): string[]                          // in place: drop entries shadowing an asset (ADR 0204)
hydratePrefabs(level, source): { filled: string[]; missing: string[] }   // in place; by reference, not copied
stripHydrated(level, filled): T                                  // a shallow copy without what was filled
```

`relinkPrefabs` runs first wherever a level is read to be **used** — the server's live documents and the game's
loader: an entry under an existing asset's id is a frozen copy of that asset, and yields to it. The editor reads
the server's resolution and does not run it.

Two rules carry the whole design. **Hydration never fills a reference that already resolves**, and **stripping
removes only what hydration filled** — so a level still carrying its own table keeps it, which is what let this
ship before the migration ran and what stops an unmigrated level losing its prefabs on its first write. (A table
entry under an asset's id is not the level's own: `relinkPrefabs` takes it out first.) And the
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

- `AssetKind = 'prefab' | 'texture' | 'model' | 'material' | 'shader' | 'sound' | 'font' | 'data'`. `animation` was retired with the keyframe model (ADR 0103).
- Identity = sidecar `<file>.meta` → `AssetMeta { id; kind }`, written once. References by **id**, never path. Kind comes from the **path** (`kindForPath`: `.mat.json`, `.shader.json`, `.prefab.json`, `.data.json`, else extension); sidecar `kind` not trusted.
- `AssetEntry { id; kind; path; name }` — `path` from `content/`, starting with its library (`assets/…`, `<game>/assets/…`, ADR 0161); `AssetDatabase { entries; byId }`; `buildDatabase`, `entriesFrom`, `entryFor`, `assetsOfKind`, `nameForPath`.
- `MaterialAsset { shader: 'standard' | 'unlit' | assetId; params: Record<string, MaterialValue> }`; `MaterialValue` kinds color/number/vec2/vec3/boolean/texture(`string|null`). `materialDependencies` = texture ids.
- `DataAsset { type: string; fields: Record<string, unknown> }` (ADR 0181), `isDataAsset(json)`: Unity's ScriptableObject — a file naming its data type and holding its field values; the type is a game's code (`defineDataType`, `components/api.md`), as a material's fields are its shader's. Lives only in the declaring game's library.
- `*.prefab.json` = a `Node` root. Placing writes its **asset id** into the level; the definition stays in the file (ADR 0091, below).

## Which levels use which asset — `packages/content/src/usage.ts` (ADR 0161)

```ts
assetsUsedBy(json, isAssetId, contentsOf): Set<string>      // a level's (or any asset's) ids, and through each prefab and material, theirs
levelsUsing([[name, json]…], isAssetId, contentsOf): Map<id, string[]>   // asset → level names, sorted; unused assets absent
usersOf(id, levels, assets, isAssetId, contentsOf): { levels, assets }   // who uses one, level names and asset ids, sorted (ADR 0165)
```

A reference is **a string value equal to a known id**, anywhere in the file (an id is 64 random bits): a game's own
components' fields, the settings and a frozen copy's contents included; keys are not references. `contentsOf(id)` is
a prefab's or material's JSON to follow (a material's textures and shader, a prefab's materials and models). A
frozen copy is followed into the asset file too, so a level may count as using a little more than it draws, never
less.

## What a page downloads for one level — `packages/content/src/levelNeeds.ts` (ADR 0169)

```ts
PLAY_CONTENT_DIR = 'content'                  // relative to a game page's address
levelIndexFile(game) = '<game>/levels.json'   // → LevelIndex { levels: string[]; default: string }
levelNeedsFile(ref) = '<game>/levels/<name>.needs.json'   // → LevelNeeds; levelOfNeedsFile(path) reads it back
levelIndexOf(names): LevelIndex               // 'default' first when present, the rest sorted; default = the first
levelNeeds(ref, level, catalog: ContentCatalog, urlOf): LevelNeeds
interface LevelNeeds { level: string; assets: NeededAsset[] }   // NeededAsset { id; kind; path; url }, sorted by path
interface ContentCatalog { byId(id) → { kind; path }; contentsOf(id) }
```

`levelNeeds` = `assetsUsedBy` over the level, restricted to what `mayUse(game, path)` allows (the game's own library
and Shared's); `urlOf` maps a path from `content/` to the address the page fetches.
One pure function for the build, the local dev server and the editor server (`content-sync.md`, `editor-server.md`).
`contentTypeFor(path)` (`assets.ts`) is the content type both servers send.

## Live assets — `packages/content/src/liveAssets.ts` (ADR 0159)

A data-file asset edited live, by ops that know nothing about what the file means:

```ts
type AssetOp = { kind: 'set'; path: readonly string[]; value: unknown } | { kind: 'unset'; path: readonly string[] }
applyAssetOps(json, ops): { json, inverses }   // on a copy; inverses undo it applied in reverse; LiveAssetError for a path through a non-object
diffAssetOps(before, after): AssetOp[]          // down through objects; arrays and changed types set whole
mergeAssetOps(first, then): AssetOp[]          // one op per path, the newest; does what applying both in order does
isAssetOp(v) · isLiveAssetPath(path) · validateLiveAsset(kind: LiveKind, json): string | null · LIVE_ASSET_KINDS
type LiveKind = AssetKind | 'game'
gameDocId(game) = `game:${game}` · gameOfDocId(id): string | null   // no asset id has a colon
```

A kind is live when it has a validator: `material` (a non-empty `shader`, `params` of tagged values); `data` (its
shape, `isDataAsset`: its fields are checked against its type where the type is known — the editor — ADR 0181); and a game's
`game.json`, not an asset (ADR 0162): `components` a list of names, `settings` absent or an object of numbers and
curve-point lists. `LIVE_ASSET_KINDS` is the asset kinds only.

## Layout — `packages/content/src/layout.ts` (ADR 0108)

**A game is a folder at the content root**, holding its own `game.json`, its `levels/` and its own asset library
`assets/`, beside the **shared** library at `content/assets/` (ADR 0161). Only the shared one has files so far.

One module so the server, the editor and the game cannot disagree; every path it returns is relative to
`content/` and forward-slashed.

| Symbol | Value / signature |
|---|---|
| `GAME_FILE` | `'game.json'` |
| `LEVEL_SUFFIX` | `'.level.json'` — a compound suffix, like `.mat.json` |
| `ASSETS_DIR` | `'assets'` — every library's folder, so a name no game may take |
| `LEVELS_DIR` | `'levels'` |
| `LevelRef` | `{ game: string; name: string }` |
| `isSegment(s)` | `/^[\w-]+$/` — what may be typed as a name |
| `isGameName(s)` | `isSegment(s) && s !== 'assets'` |
| `qualify(ref)` | `` `${game}/${name}` `` |
| `parseQualified(q)` | `LevelRef \| null` — strict: two segments, both legal |
| `levelFile(ref)` | `` `${game}/levels/${name}.level.json` `` |
| `gameFile(game)` | `` `${game}/game.json` `` |
| `libraryDir(game \| null)` | `'assets'` (shared) or `` `${game}/assets` `` — what every asset path starts with |
| `libraryOf(path)` | `null` shared · the game · `undefined` in no library (a level, a `game.json`) |
| `inLibrary(path)` | strictly inside a library: not its own folder, no empty, `.` or `..` segment |
| `mayUse(user, path)` | `user` (a game, `null` for Shared) may use the asset at `path`: Shared's always, its own game's, nothing else |
| `levelRefForFile(rel)` | `LevelRef \| null` — the game a path names, or `null` for anything that is not a level |

A level's identity outside its own folder is the **qualified** `<game>/<name>`: the API route, the live
document key, the editor's open file. Two things stay bare — the level's own `id` field, which is a
file name, and the game's `?level=`, which the page qualifies with its own name, so every game may own a
`default` (`packages/game-client/src/levels.ts` used to carry the apology for why it could not).

Migration: `tools/editor-server/src/layoutMoves.ts` (plan/apply, pure) and `migrateLayout.ts` (the CLI), run by
`deploy/editor/update.sh` and standalone as `deploy/editor/migrate-layout.sh`. Nothing inside a file changes —
a level's folder is the game it already declared — so it is a rename, verified byte-for-byte, refusing rather
than guessing where an unassigned level goes. Idempotent.

## `content/` layout

| Path | Contents |
|---|---|
| `content/assets/{materials,prefabs,textures}/` | 9 `*.mat.json`; `AlternatingDanger`/`FastElevator`/`Trampoline`/`board-start`/`kill-plane`/`Stage-End.prefab.json`; `checker.png`, `warn.png`, `sky_110_2k.webp`. Each with `.meta`. |
| `content/<game>/levels/*.level.json` | The game is the **folder** (ADR 0108). keyboard → Roblox, Roblox_World_1, Roblox_World_1-copy, keyboard. All set `environment.sun/ambient/sky`; keyboard also `postfx`. Loaded by `?level=<name>`, bare and resolved inside the game's own folder, default `default.level.json` (ADR 0027, ADR 0108). `config.mode.name` is kept in step with the folder, for a level fetched over HTTP where there is no folder to read. |
| `content/<game>/game.json` | `{ "components": string[], "settings"?: Record<string, number> }` — shared gameplay types the game opts into (ADR 0077) and its tunable numbers (ADR 0087). keyboard: Boss, Bumper, Checkpoint, Hazard, Sequence; `_template`: Hazard. Read by `modes/<game>/src/rules.ts` via `sharedComponents(game.components)`; appended by the editor's `adopt`, trimmed by its `removeShared` while nothing of the game uses the type (`tools/editor/src/main.ts`, ADR 0175). |
