# `@mp/game-client` — services

`packages/game-client/src/index.ts`. Services a browser game composes; **no entry point** — there is no
`startGameClient` (ADR 0065). Every game the stack ships calls `@mp/tps`'s `startTpsClient` instead
(`docs/platform/client/tps.md`); a game that is not the third-person humanoid game calls these directly.

## The split (ADR 0065)

| Kind | Exports | Why |
| --- | --- | --- |
| **Must be uniform across a room** | `createNetHost`, `loadLevelInto`, `worldFromBase` | Wire format, clock, level instantiation order (`baseIndex` goes on the wire, ADR 0021). Disagreement = peers drawn in the wrong place. |
| **Merely universal** | `createScene`, `createShell`, `createStatusLine`, `levelsFor`, `localProgress`, `ASSET_DB`/`CLIP_SOURCE` | No agreement needed; shared to avoid writing twice. |

## `createNetHost` — `netHost.ts`

```ts
createNetHost({ game, level, onWelcome, setStatus }: NetHostOptions): NetHost
interface NetHostOptions { game: string; level: string; onWelcome: (id: EntityId) => void; setStatus: StatusLine['set'] }
interface NetHost {
  id: () => EntityId | null            // null until MSG_WELCOME
  sample: () => readonly SnapshotEntity[]  // peers on the delayed timeline; never includes us
  nameOf: (id: EntityId) => string | undefined
  roster: () => readonly { id: EntityId; name: string }[]
  readonly myName: string              // auto-generated "Adj Noun"
  send: (state: PlayerState) => void
  serverNow: () => number              // slewed server clock
  dispose: () => void
}
```

- Synchronous; join in flight. Colyseus `joinOrCreate('game', { name, game, level })`; `game`+`level` are the
  two matchmaking filters (ADR 0052).
- Server URL: `relayUrl(location)` (`src/relayUrl.ts`, ADR 0085): `?server=` wins; `http:` page → `ws://${hostname}:9200`; `https:` page → `wss://${host}/relay` (the page's Vite proxy).
- Constants: `PING_INTERVAL_MS = 250`, `INTERPOLATION_DELAY_MS = 100`.
- Handles `MSG_WELCOME | MSG_SNAPSHOT | MSG_ROSTER | MSG_PONG` on `NET_CHANNEL`; composes `createClockSync`,
  `createSnapshotReassembler`, `createSnapshotClient` from `@mp/client`.
- Status keys emitted: `status.offline`, `status.room` (`{ room }`).

## `loadLevelInto` — `levelHost.ts`

```ts
loadLevelInto({ world, scene, data, registry, cutout, env, postfx }: LevelHostOptions): Promise<LevelHost>
interface LevelHostOptions {
  world: PhysicsWorld; scene: THREE.Scene; data: Level; registry: Registry
  cutout: CutoutMask; env: GreyboxEnvironment; postfx: PostFX
}
interface LevelHost {
  readonly loaded: LoadedLevel
  render: (tickAlpha: number) => void          // loaded.render + view.sync + lights.sync
  occluding: () => Iterable<THREE.Object3D>    // meshes wearing the cutout (ADR 0055)
  setOccluders: (handles: readonly number[]) => void
  meshesOf: (handle: number) => readonly THREE.Mesh[]   // node's drawn meshes by collider handle (ADR 0082)
  material: (assetId: string) => THREE.Material | null  // any material a component parameter names (ADR 0082)
  dispose: () => void
}
```

Order: `hydratePrefabs(data, PREFAB_SOURCE)` (ADR 0091 — a level names its prefabs and the definitions must be
in place first; bundled, so this stays synchronous) → `instantiateLevel(world, data, registry, CLIP_SOURCE)` →
`assets.load([...assetIdsIn(visuals), ...assetParamIds(nodes, registry)])`
→ `addLevel` (sync) → `addLights` → `env.applyEnvironment(config.environment)` → `postfx.apply(config.environment?.postfx)`.
Colliders and meshes in one call so a level is never walkable before visible.

## `worldFromBase` — `baseFrame.ts`

```ts
interface BasedTransform { position: Vec3; yaw: number; base: number }  // base = baseIndex + 1, 0 = none
worldFromBase(loaded: Pick<LoadedLevel, 'basePoseOf'> | null, e: BasedTransform, rendered: boolean): { position: Vec3; yaw: number }
```

Undoes the riding-piece frame (v10, ADR 0021). `rendered: true` → `'render'` pose (for drawing); `false` → `'tick'`
pose (for collision proxies). Unknown piece → values treated as world-space.

## `createScene` — `scene.ts`

```ts
createScene(canvas: HTMLCanvasElement, occluding: () => Iterable<THREE.Object3D>): Promise<Scene>
interface Scene { stage: ThreeStage; env: GreyboxEnvironment; postfx: PostFX; photoSky: Sky | null }
```

- `createThreeStage({ canvas, cameraPosition: [0, 6, 10], lookAt: [0, 1, 0] })`.
- `applyGreyboxEnvironment(renderer, scene, { sunIntensity: 2.4 })`; `shadowRadius` deliberately not passed.
- `loadSky(scene, assetUrlOf('textures/sky_110_2k.webp'))` — kept as the control backdrop (ADR 0046); background
  reset to `env.sky.background` when both exist.
- `createPostFX(renderer, scene, camera, { aoIgnores: occluding })`.
- Sets the two-pass render step: `postfx.render()` then `OVERLAY_LAYER` drawn on top (details in
  `docs/platform/rendering.md`).

## `createShell` — `shell.ts`

```ts
createShell({ canvas, isTouch, sensitivity, roster, onRestart }: ShellOptions): Promise<Shell>
interface ShellOptions {
  canvas: HTMLCanvasElement; isTouch: () => boolean
  sensitivity: { get: () => number; set: (t: number) => void }   // camera units; shell maps to 0..1 slider
  roster: () => { me: string; peers: readonly string[] }; onRestart: () => void
}
interface Shell { readonly ui: UiOverlay; readonly touchHud: TouchHud; isOpen: () => boolean; dispose: () => void }
```

- Overlay sized from the **canvas** (`clientWidth/Height`), `position: fixed; inset: 0; z-index: 10`; resized by a
  `ResizeObserver` on the canvas plus `window.resize`.
- **Pointer lock is the pause state** on mouse: `pointerlockchange` → lock held = close, lost = open. Touch: pause
  button (`'II'`, top-left 16,16) is the only way in and out; every lock path guarded by `isTouch()` (ADR 0022).
- Background tap (`ui.setBackgroundTap`) re-requests lock when not touch and menu closed.
- Sensitivity slider range `SENS_MIN = 0.0005`, `SENS_MAX = 0.006`.
- Pause menu (`pauseMenu.ts`, not exported): settings (sensitivity, language grid) + players list, Restart/Resume;
  all text via `@mp/i18n`, RTL-mirrored, scaled to fit.

## `createStatusLine` — `status.ts`

```ts
createStatusLine(el: HTMLElement): StatusLine
interface StatusLine { set: (key: TranslationKey, params?: Record<string, string | number>) => void }
```

Key-driven, re-renders on locale change. Owns locale bootstrap: `localStorage['mp.locale']` else
`matchLocale(navigator.language)`; persists on change (best-effort). Initial key `status.connecting`.

## `levelsFor` — `levels.ts`

```ts
levelsFor(mode: string, registry: ParamChecker): LevelSource
interface LevelSource { names: () => string[]; defaultName: string; byName: (name: string | null) => Level; validate: (raw: unknown) => Level }
DEFAULT_NAME = 'default'
type LevelFetch = (name: string) => Promise<unknown | null>
fetchLevel: LevelFetch                       // GET /api/levels/<name> on the page's origin; anything but JSON 200 → null
pickLevel(source, requested: string | null, live: LevelFetch | null): Promise<{ name; level; from: 'live' | 'bundled' }>
```

- `import.meta.glob('@content/*/levels/*.level.json')`, bundled at build; `@content` is the repo's `content/` or the live mirror (`content-sync.md`, ADR 0084).
- Filtered by `config.mode.name === mode` **or unassigned**. `names()` = default first, rest sorted.
- `defaultName` = `'default'` if present else first level. `byName` validates with `validateLevel(data, registry)`;
  throws for an unknown name. `validate(raw)` = the same check plus the game filter, for a copy from elsewhere.
- **Live first on the box** (ADR 0089): `pickLevel` tries `live(name)` and `validate`s it (a bad or foreign copy
  falls back to the bundle with a console warning); an unknown requested name falls back to the default, live
  first. `@mp/tps` passes `fetchLevel` only when `import.meta.env.BASE_URL !== '/'` — the staging game served
  under `/play/<game>/`; locally and in a build the bundle is the level.

## `localProgress` — `persistence.ts`

```ts
interface PersistenceAdapter<T> { load: () => T; save: (state: T) => void }
interface PlayerProgress { checkpoint: number }   // -1 = none
localProgress(mode: string): PersistenceAdapter<PlayerProgress>
```

`localStorage[`${mode}.state`]`; every failure falls back to `{ checkpoint: -1 }`.

## `ASSET_DB`, `CLIP_SOURCE`, `assetUrlOf`, `materialOf` — `assets.ts`

```ts
ASSET_DB: AssetDatabase                 // buildDatabase over content/assets/**/*.meta sidecars
PREFAB_SOURCE: PrefabSource             // { root: (assetId) => Node | undefined } — ADR 0091
assetUrlOf(path: string): string        // bundled URL, or the path itself
materialOf(assetId: string): MaterialAsset | undefined
```

Bundled via `import.meta.glob` over `@content/assets/**` (alias, `content-sync.md`) (`*.meta` as `?raw`, `*` as `?url`, `*.mat.json`,
`*.prefab.json`). Kind from extension (`kindForPath`); a corrupt or missing sidecar = unknown asset, not a build error.
Prefabs are parsed and eager for the same reason clips are: resolution has to finish before `instantiateLevel`,
which stays synchronous (`baseIndex` goes on the wire, ADR 0021). A reference no file resolves draws nothing and
warns once. Nothing hands a `builtin:` shape or a prefab id to `assets.load`: neither is a file (ADR 0090, 0091).

## Other exports

`GAME_CLIENT_VERSION = '0.0.0'`; type re-export `UiOverlay` from `@mp/render-pixi`.
