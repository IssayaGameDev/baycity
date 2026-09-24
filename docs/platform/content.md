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
interface LevelConfig { mode?: { name: string }; environment?: Partial<{ sun: SunConfig; ambient: AmbientConfig; sky: SkyConfig; postfx: PostFXConfig }>; netBounds?: number }
```

- `enabled === false` → loader and runtime skip it.
- No prefab-in-prefab (ADR 0023). Override keys are not checked against the tree; dangling = inert (ADR 0033), and so is a `prefab` no file resolves (ADR 0091).
- Keys are **offsets** from `Transform`, per channel; rotation lerps per component (ADR 0050).
- `environment` absent/partial → renderer defaults; sun is config, not a `Light` (ADR 0048).
- `unlinkPrefab(level, assetId, deps)` / `unlinkedNode(level, node, assetId, deps)` (`prefabs.ts`, ADR 0097; one placement at a time through `Doc.unlinkNode`, ADR 0111): turn placements of one prefab into plain nodes that keep what they were drawing. `deps` carries `types`, `freshId` and `refKeysOf` — a registry is needed for singleton layering and for `nodeRef`s that must follow the re-id, which is why only the editor can do this. The inherited subtree is cloned and re-idded as one forest; `nodeRef`s and sequence step targets follow the map, in that forest **and** on the placement's own components (a root sequence targets the root's children, ADR 0139).
- `netBounds`: half-extent in metres that peer positions are quantized over on the wire (ADR 0093). Absent → `QUANT_BOUND` (1000 m). Step is `2 × netBounds / 65535`. The editor draws it as a box (ADR 0093); a peer outside it stops being relayed (ADR 0092).

## Resolution — `packages/content/src/nodes.ts`

| Export | Role |
|---|---|
| `COLLIDER, MESH, RENDERER, MATERIAL_OVERRIDE, SPAWN, LIGHT, MOVER, SPINNER, SEQUENCE` | The type constants the loader reads. First six = `ENGINE_COMPONENTS`; `Mover`/`Spinner` are gameplay-owned but loader-evaluated (ADR 0103). `SEQUENCE` is declared in `sequenceData.ts` and re-exported here; `patchComponents` applies a placement's `sequences` record to its `stages` (ADR 0139). |
| `TypeInfo { get(type) → { singleton?, moves? } \| undefined }` | What resolution needs from a registry. |
| `effectiveNode(level, node, types): Resolved` | `{ id, name, transform, components, children, inheritedCount }`. Placement keeps own `id`/`transform`; `name` falls back to prefab root's. `bakeOverrides` patches the prefab tree (returns the prefab's own object when unchanged); `layerOwn`: own **singleton** replaces inherited same type, repeatable appends. Children = inherited then own. Unknown prefab key → own layer only. |
| `walkNodes`, `componentsOfType`, `firstOfType`, `numberParam`/`vec3Param`/`stringParam`/`boolParam`, `freeTableKey` | Depth-first walk; untyped readers with fallbacks; table-key dedupe for interning prefabs. |

## Validation — `packages/content/src/validate.ts`

`validateLevel(data: unknown, checker?: ParamChecker): Level` — throws `LevelError` with a JSON-path message. Per-tree helper `validateNodeTree(node, at, { ids, table, insidePrefab, checker? })` and `checkTransform`/`checkComponents`/`checkOverrides`/`validateConfig` are exported for `ops.ts`. Always: ids non-empty, unique per tree; transforms; component ids unique per node; `prefab` key in table and not inside a prefab; override shapes; `config.mode.name` non-empty; `environment` sub-blocks (`#rrggbb`, finite numbers, booleans); `config.netBounds` a positive finite number. Params **only** with `checker` (`Registry.checkParams`). `nodeRef` targets unchecked.

## Loader — `packages/content/src/loader.ts`

```ts
instantiateLevel(world: PhysicsWorld, level: Level, types: TypeInfo): LoadedLevel
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
- Frame `animated` if `movesAtAll(motions)`, an enabled `moves` component, or an animated ancestor → kinematic bodies; else fixed.
- `Collider.trigger` → sensor (ADR 0054), still in `colliderHandles`. Shape and `center` scaled by frame scale (box/convex exact, ball/capsule averaged). `cylinder` throws.
- Draw (ADR 0039): `Renderer`+`Mesh.model` → one visual listing all handles; `Renderer` alone → one per collider; else nothing. `MaterialOverride` cascades down over `Renderer.material`; `''` = unsurfaced. `Mesh.model` is an asset id or a **built-in shape** (below).
- Placement with inherited children opens a new `scope` (own id + prefab root id; first writer wins).
- `motionsOf(components)`: every enabled `Mover` in order, then the first `Spinner`.

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
  | setEnvironment{environment|null} | setMode{mode|null} | setNetBounds{netBounds|null}
  | setNodeEnabled{id,enabled} | setOverrideNodeEnabled{owner,node,enabled|null} )
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

**A placement can differ from its prefab in any way a node can** (ADR 0135), and each difference is recorded
on the **piece** it applies to, which is what makes it work at any depth: values and components (ADR 0098),
the node switched off (ADR 0099), the piece **removed** (`removedNodes`, ADR 0133), children **added**
(`addedChildren`, ADR 0130 generalised), the child **order** (`childOrder`), and a sequence's stages and steps
(`sequences`, keyed by component id — `sequences.md`, ADR 0139).

An added child is an ordinary authored node that lives in an override record. `find`, `idsIn`, `subtreeIds`
and `contains` all walk `childListsOf`, so every existing op edits one and it takes part in id uniqueness —
nothing else had to learn about it. `childrenFor(node, over, overrides)` is the one place a placement's
children are resolved (prefab's, minus removed, plus added, in `childOrder`), exported so `bakeOverrides`
and the editor's tree walk cannot disagree. `childOrder` is a preference: missing ids are skipped and
unnamed children keep their place at the end, so a prefab gaining a piece does not invalidate it.

## Tracks — `packages/content/src/track.ts` (ADR 0029)

Being replaced by sequences (`sequences.md`, ADR 0137); the engine exists and nothing reads it yet.

Pure in `(motions, nowMs)` — `motion.ts`, ADR 0103. `motionOffset(motions, nowMs): MotionOffset { position; rotation /* euler rad */ }`, summed over every motion; `MOTIONLESS` when there are none.

| | |
|---|---|
| `moveFraction(m, nowMs)` | `[0,1]` along the travel. Leg = `distance / speed` seconds; `period = 2 × leg`; `phase = frac(nowMs/1000/period + offset)`; out on the first half, back on the second, each leg eased separately. |
| `spinRadians(s, nowMs)` | `frac(nowMs/1000 × speed/360 + offset) × 2π`. Wrapped to one turn. |
| `curve(u, smooth)` | cosine when `smooth`, else linear. Both average 1 over a leg, which is what lets `speed` mean the average. |
| `movesAtAll(motions)` | no distance or no speed ⇒ still ⇒ fixed body. |
| `motionSlices(fromMs, toMs, maxStep)` | how many equal slices a tick needs so nothing travels more than `maxStep` between two of them (ADR 0104). `1` when still or slow; capped at 8. Position only. |

A mover's travel is **re-framed by the loader**, not by `motion.ts` (ADR 0106): the frame tree would put it
through `parentScale` and the parent's rotation, the same line a node's position goes through, so the loader
divides by the scale (a metre stays a metre at any parent scale) and picks the frame from `space` —
un-rotating by the parent's world rotation for `world`, rotating by the node's own authored rotation for
`local`. Authored, not live, so a `Spinner` on the same node cannot turn a straight `Mover` into an orbit.
| `AXES`, `AXIS_NAMES` | the six cardinal axes, as a literal tuple so `params.axis` narrows. |

`frac` is a flooring fraction, so a negative `offset` wraps forward. Two `Spinner`s would not compose (euler
angles about two axes do not add as rotations), which is why it is a singleton.

The retired keyframe model lives on in `retiredTrack.ts`, read by `migrateMotion.ts` alone and exported from
nowhere: `content/` is only migrated once the `content` branch is merged, so the converter still needs a
reader. Delete both once no content carries a `Track`.

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

## Migrating motion — `packages/content/src/migrateMotion.ts` (ADR 0103)

Every `Track` becomes a `Mover` or a `Spinner`, keeping the component **id** so an override still names it.

A conversion is never inferred from the shape of the keys. `convertTrack` reads the candidate's own axis,
distance and period, **rebuilds the preset from them** (`moveTrack`/`spinTrack`), and requires the rebuild to
equal the authored keys. Two deliberate exceptions, both stated in the source:

| case | what happens |
|---|---|
| no duration, holding the rest pose | dropped — the node never moved |
| no duration, holding a real offset | refused — one key in a channel is a constant offset (`poseAt`), so dropping it would move the node |
| a full turn typed rather than generated (`6.2832`) | converted, within `TURN_EPS`, and **reported as rounded** |
| anything else | refused, and the file is left exactly as it was |

**The gate is motion, not geometry.** `fingerprintGeometry` compares component parameters, and the components
are what is being replaced, so it would refuse everything. `fingerprintMotion` samples every node's composed
local offset at `SAMPLE_MS` against a zero base, and `firstMotionDifference` compares numerically —
`POS_EPS`, and `ROT_EPS` modulo a whole turn, since the keyframe form's last key *is* a full turn and reads
2π where the wrapped form reads 0.

`migrateGameComponents` also rewrites each game's shared-component list (ADR 0077): a game still naming
`Track` would build a registry with no `Mover` in it. It runs only when nothing refused, because a refused
level keeps its `Track`.

Run once by `tools/editor-server/src/migrateMotion.ts` via `deploy/editor/migrate-motion.sh`, dry by default.

## Migrating to references — `packages/content/src/migratePrefabRefs.ts` (ADR 0091)

`matchEntry(key, entry, files)` → contents, then the same shape under other node ids (with a remap), then the
name. `migrateLevelRefs(level, at, files, types, report)` re-points every placement, remaps override keys and
completes override transforms from the node they now override — then **throws the rewrite away** unless
`fingerprintGeometry` agrees line for line. Run once by `tools/editor-server/src/migratePrefabRefs.ts` via
`deploy/editor/migrate-prefab-refs.sh`, dry by default.

## Assets — `packages/content/src/assets.ts` (ADR 0026, ADR 0028)

- `AssetKind = 'prefab' | 'texture' | 'model' | 'material' | 'shader' | 'sound' | 'font'`. `animation` was retired with the keyframe model (ADR 0103).
- Identity = sidecar `<file>.meta` → `AssetMeta { id; kind }`, written once. References by **id**, never path. Kind comes from the **path** (`kindForPath`: `.mat.json`, `.shader.json`, `.prefab.json`, else extension); sidecar `kind` not trusted.
- `AssetEntry { id; kind; path; name }`, `AssetDatabase { entries; byId }`; `buildDatabase`, `entriesFrom`, `entryFor`, `assetsOfKind`, `nameForPath`.
- `MaterialAsset { shader: 'standard' | 'unlit' | assetId; params: Record<string, MaterialValue> }`; `MaterialValue` kinds color/number/vec2/vec3/boolean/texture(`string|null`). `materialDependencies` = texture ids.
- `*.prefab.json` = a `Node` root. Placing writes its **asset id** into the level; the definition stays in the file (ADR 0091, below).

## Layout — `packages/content/src/layout.ts` (ADR 0108)

**A game is a folder at the content root**, holding its own `game.json` and its `levels/`. Assets stay one
shared library at `content/assets/`, because they are shared in fact: of twenty assets nine are used by more
than one game and four by exactly one.

One module so the server, the editor and the game cannot disagree; every path it returns is relative to
`content/` and forward-slashed.

| Symbol | Value / signature |
|---|---|
| `GAME_FILE` | `'game.json'` |
| `LEVEL_SUFFIX` | `'.level.json'` — a compound suffix, like `.mat.json` |
| `ASSETS_DIR` | `'assets'` — and therefore a name no game may take |
| `LEVELS_DIR` | `'levels'` |
| `LevelRef` | `{ game: string; name: string }` |
| `isSegment(s)` | `/^[\w-]+$/` — what may be typed as a name |
| `isGameName(s)` | `isSegment(s) && s !== 'assets'` |
| `qualify(ref)` | `` `${game}/${name}` `` |
| `parseQualified(q)` | `LevelRef \| null` — strict: two segments, both legal |
| `levelFile(ref)` | `` `${game}/levels/${name}.level.json` `` |
| `gameFile(game)` | `` `${game}/game.json` `` |
| `assetFile(rel)` | `` `assets/${rel}` `` |
| `levelRefForFile(rel)` | `LevelRef \| null` — the game a path names, or `null` for anything that is not a level |

A level's identity outside its own folder is the **qualified** `<game>/<name>`: the API route, the lock key,
the live document key, the editor's open file. Two things stay bare — the level's own `id` field, which is a
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
| `content/<game>/levels/*.level.json` | The game is the **folder** (ADR 0108). parkour → default, level1, Test, FastElevator, mp-demo, mp-cointest; swing → swing; keyboard → keyboard, keyboard2, keyboard-copy. All set `environment.sun/ambient/sky`; keyboard also `postfx`. Loaded by `?level=<name>`, bare and resolved inside the game's own folder, default `default.level.json` (ADR 0027, ADR 0108). `config.mode.name` is kept in step with the folder, for a level fetched over HTTP where there is no folder to read. |
| `content/<game>/game.json` | `{ "components": string[], "settings"?: Record<string, number> }` — shared gameplay types the game opts into (ADR 0077) and its tunable numbers (ADR 0087). parkour, swing: all five; keyboard: Bumper, Hazard; `_template`: Hazard. Read by `modes/<game>/src/rules.ts` via `sharedComponents(game.components)`; appended by the editor's `adopt` (`tools/editor/src/main.ts`). |
