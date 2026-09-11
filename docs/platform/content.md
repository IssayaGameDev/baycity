# `@mp/content` — schema, loader, tracks, assets

Package `packages/content`. Headless; deps `@mp/core`, `@mp/physics`. Never imports `@mp/components`: takes capabilities as arguments (`TypeInfo`, `ParamChecker`, `ClipSource`), all satisfied structurally by a `Registry`. Public surface `packages/content/src/index.ts`. ADR 0014, ADR 0035.

## Schema — `packages/content/src/types.ts`

```ts
interface Level { id: string; config: LevelConfig; prefabs?: Record<string, Node>; nodes: Node[] }
interface Node {
  id: string; name?: string; transform: Transform; components: ComponentData[]; children?: Node[]
  prefab?: string                            // key into Level.prefabs; forbidden inside a prefab
  overrides?: Record<string, NodeOverride>   // keyed by the referenced tree's node ids, any depth
}
interface ComponentData { id: string; type: string; params: Record<string, unknown>; enabled?: boolean }
interface NodeOverride { transform?; name?; params?: Record<compId, Record<string, unknown>>; added?: ComponentData[]; removed?: compId[]; enabled?: Record<compId, boolean> }
interface Transform { position: Vec3; rotation?: Vec3 /* euler rad XYZ */; scale?: Vec3 /* baked into shapes at load */ }
type ColliderDesc = box{halfExtents} | cylinder{halfHeight,radius} | capsule{halfHeight,radius} | ball{radius} | convex{points}
interface Keyframe { t: number /* ms */; position?: Vec3; rotation?: Vec3; easing?: 'linear'|'in'|'out'|'inOut'|'step' }
interface LevelConfig { mode?: { name: string }; environment?: Partial<{ sun: SunConfig; ambient: AmbientConfig; sky: SkyConfig; postfx: PostFXConfig }> }
```

- `enabled === false` → loader and runtime skip it.
- No prefab-in-prefab (ADR 0023). Override keys are not checked against the tree; dangling = inert (ADR 0033).
- Keys are **offsets** from `Transform`, per channel; rotation lerps per component (ADR 0050).
- `environment` absent/partial → renderer defaults; sun is config, not a `Light` (ADR 0048).

## Resolution — `packages/content/src/nodes.ts`

| Export | Role |
|---|---|
| `COLLIDER, MESH, RENDERER, MATERIAL_OVERRIDE, SPAWN, LIGHT, TRACK` | The seven type constants the loader reads. First six = `ENGINE_COMPONENTS`; `Track` is gameplay-owned but loader-evaluated. |
| `TypeInfo { get(type) → { singleton?, moves? } \| undefined }` | What resolution needs from a registry. |
| `effectiveNode(level, node, types): Resolved` | `{ id, name, transform, components, children, inheritedCount }`. Placement keeps own `id`/`transform`; `name` falls back to prefab root's. `bakeOverrides` patches the prefab tree (returns the prefab's own object when unchanged); `layerOwn`: own **singleton** replaces inherited same type, repeatable appends. Children = inherited then own. Unknown prefab key → own layer only. |
| `walkNodes`, `componentsOfType`, `firstOfType`, `numberParam`/`vec3Param`/`stringParam`/`boolParam`, `freeTableKey` | Depth-first walk; untyped readers with fallbacks; table-key dedupe for interning prefabs. |

## Validation — `packages/content/src/validate.ts`

`validateLevel(data: unknown, checker?: ParamChecker): Level` — throws `LevelError` with a JSON-path message. Always: ids non-empty, unique per tree; transforms; component ids unique per node; `prefab` key in table and not inside a prefab; override shapes; `config.mode.name` non-empty; `environment` sub-blocks (`#rrggbb`, finite numbers, booleans). Params **only** with `checker` (`Registry.checkParams`). `nodeRef` targets unchecked.

## Loader — `packages/content/src/loader.ts`

```ts
instantiateLevel(world: PhysicsWorld, level: Level, types: TypeInfo, clips?: ClipSource): LoadedLevel
interface ClipSource { keys(assetId): readonly Keyframe[] | undefined }   // absent → no clip resolves
interface WorldNode { id; name; components /* resolved */; position /* at load */; colliderHandles: readonly number[] /* opaque */; scope: number }
interface VisualItem { collider: ColliderDesc; position; rotation: Quat; model?: string; material?: string; colliderHandles: number[] }
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
- Draw (ADR 0039): `Renderer`+`Mesh.model` → one visual listing all handles; `Renderer` alone → one per collider; else nothing. `MaterialOverride` cascades down over `Renderer.material`; `''` = unsurfaced.
- Placement with inherited children opens a new `scope` (own id + prefab root id; first writer wins).
- `Track` keys: inline `keys` if non-empty, else `clips.keys(clip)`, else static.

## Tracks — `packages/content/src/track.ts` (ADR 0029)

Pure in `(behavior, base, nowMs)`. `poseAt(behavior, base, nowMs): Pose { position; rotation /* euler rad */ }` — base + sampled offset per channel; empty channel returns base. `trackDuration` = max `t`. `trackTime(duration, loop, nowMs, phaseMs)` — flooring modulo; `pingPong` spans 2×; `once` clamps. `easeAt` — `inOut` cosine, `step` = 0; easing belongs to the key a segment leaves. Keys sorted per channel at sample. `isAnimated`. Presets `moveTrack(axis, distance, periodMs)`, `spinTrack(axis, periodMs)` (cardinal axis).

## Assets — `packages/content/src/assets.ts` (ADR 0026, ADR 0028)

- `AssetKind = 'prefab' | 'texture' | 'model' | 'material' | 'shader' | 'animation' | 'sound' | 'font'`.
- Identity = sidecar `<file>.meta` → `AssetMeta { id; kind }`, written once. References by **id**, never path. Kind comes from the **path** (`kindForPath`: `.mat.json`, `.shader.json`, `.prefab.json`, `.anim.json`, else extension); sidecar `kind` not trusted.
- `AssetEntry { id; kind; path; name }`, `AssetDatabase { entries; byId }`; `buildDatabase`, `entriesFrom`, `entryFor`, `assetsOfKind`, `nameForPath`.
- `MaterialAsset { shader: 'standard' | 'unlit' | assetId; params: Record<string, MaterialValue> }`; `MaterialValue` kinds color/number/vec2/vec3/boolean/texture(`string|null`). `materialDependencies` = texture ids.
- `AnimationAsset { keys }`, `isAnimationAsset`; loop/phase stay on `Track` (ADR 0050).
- `*.prefab.json` = a `Node` root; placing interns a copy into `Level.prefabs` (`freeTableKey`).

## `content/` layout

| Path | Contents |
|---|---|
| `content/assets/{animations,materials,prefabs,textures}/` | `rise-4m-4s.anim.json`; 9 `*.mat.json`; `AlternatingDanger`/`FastElevator`/`Trampoline.prefab.json`; `checker.png`, `warn.png`, `sky_110_2k.webp`. Each with `.meta`. |
| `content/levels/*.json` | `config.mode.name`: parkour → default, level1, Test, FastElevator, mp-demo, mp-cointest; swing → swing; keyboard → keyboard. All set `environment.sun/ambient/sky`; keyboard also `postfx`. Loaded by `?level=<file>`, default `default.json` (ADR 0027). |
| `content/games/<game>.json` | `{ "components": string[] }` — shared gameplay types the game opts into (ADR 0077). parkour, swing: all five; keyboard: Bumper, Hazard; `_template`: Hazard. Read by `modes/<game>/src/rules.ts` via `sharedComponents(game.components)`; appended by the editor's `adopt` (`tools/editor/src/main.ts`). |
