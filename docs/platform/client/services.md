# `@mp/game-client` — services

`packages/game-client/src/index.ts`. Services a browser game composes; **no entry point** — there is no
`startGameClient` (ADR 0065). Every game the stack ships calls `@mp/tps`'s `startTpsClient` instead
(`docs/platform/client/tps.md`); a game that is not the third-person humanoid game calls these directly.

## The split (ADR 0065)

| Kind | Exports | Why |
| --- | --- | --- |
| **Must be uniform across a room** | `createNetHost`, `loadLevelInto`, `worldFromBase` | Wire format, clock, level instantiation order (`baseIndex` goes on the wire, ADR 0021). Disagreement = peers drawn in the wrong place. |
| **Merely universal** | `createScene`, `createShell`, `createStatusLine`, `loadLevel`, `levelAssets`, `localProgress` | No agreement needed; shared to avoid writing twice. |

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
  data: (assetId: string) => DataAsset | undefined      // a data asset as its file holds it; read it with readData (ADR 0181)
  dispose: () => void
}
```

`LevelHostOptions.assets: LevelAssets` — what `loadLevel` fetched with the level. Order:
`relinkPrefabs` (a frozen copy of a fetched prefab yields to it, ADR 0204) → `hydratePrefabs(data, assets.prefabs)` (ADR 0091 — a level names its prefabs and the definitions must be in place
first; fetched with the level, so this stays synchronous) → `instantiateLevel(world, data, registry)` →
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
interface Scene { stage: ThreeStage; env: GreyboxEnvironment; postfx: PostFX }
```

- `createThreeStage({ canvas, cameraPosition: [0, 6, 10], lookAt: [0, 1, 0] })`.
- `applyGreyboxEnvironment(renderer, scene, { sunIntensity: 2.4 })`; `shadowRadius` deliberately not passed. The
  procedural sky is the only sky (ADR 0170).
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
interface Shell {
  readonly ui: UiOverlay; readonly touchHud: TouchHud; isOpen: () => boolean
  holdCursor: (onOutside: () => void) => (() => void) | null   // ADR 0203
  dispose: () => void
}
```

- Overlay sized from the **canvas** (`clientWidth/Height`), `position: fixed; inset: 0; z-index: 10`; resized by a
  `ResizeObserver` on the canvas plus `window.resize`.
- **Esc steps back one state** on a mouse (ADR 0205, Kodjo's call), owned here — a game keeps no Esc of its own.
  `escapeAction({ locked, msSinceUnlock, window, paused })`: locked, or within `ESC_UNLOCK_MS` 250 of the lock going
  (the browser's Esc only shows the mouse) → nothing; a game window held → its `onOutside`; the menu open → close
  it, back to the mouse showing; else → open the menu. `pointerlockchange`: lock gained closes the menu; lost (Esc,
  focus) only records when — the mouse showing, never the menu. Touch: the pause button (`'II'`, top-left 16,16)
  opens it; every lock path guarded by `isTouch()` (ADR 0022).
- Background tap (`ui.setBackgroundTap`): a held window's `onOutside`, else re-request the lock when not touch and
  the menu closed — a click on empty space plays again, a click on a widget is the widget's.
- **`holdCursor(onOutside)`** — a game's own window wants the mouse (ADR 0203): `exitPointerLock` without opening the
  menu (a lock lost while held is not a pause); a background tap calls `onOutside` instead of locking. The returned
  release locks again (`requestPointerLock`, rejection swallowed — Esc grants none, and the next tap locks); a no-op
  once the hold has ended. Opening the menu — its button, or a lock lost with nothing held — ends a hold first
  through `onOutside`. `null` while the menu is open.
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

## `loadLevel` — `levels.ts` (ADR 0169)

```ts
loadLevel(game: string, requested: string | null, registry: ParamChecker, base: string, read?: ReadJson): Promise<PlayedLevel>
interface PlayedLevel extends LevelAssets { name: string; level: Level }
levelNameFor(game: string, index: LevelIndex, requested: string | null): string
type ReadJson = (url: string) => Promise<unknown>      // readJson: fetch, a non-2xx throws
```

- Reads, each relative to `base` (the page's absolute address; `@mp/tps` passes `new URL(import.meta.env.BASE_URL,
  location.href)`): `content/<game>/levels.json` (`LevelIndex`) → `content/<game>/levels/<name>.needs.json`
  (`LevelNeeds`) → the level and every prefab and material on the list, at once. Textures and models on the list are
  fetched later, by `AssetRuntime`, through `urlOf`. Nothing else: no other level, no other asset.
- Name: `requested` when the index has it; `null` → `index.default`; unknown → `console.error` and the default; no
  levels → throws.
- The level must not name another game (`config.mode.name` absent or `game`), then `validateLevel(raw, registry)`.
  An index, list or level that will not load throws; a prefab or material that will not is a warning and an
  unresolved reference (greybox).
- Who answers those addresses — a build's files, the local dev server, the editor server on the box —
  `content-sync.md`. The page does not know which.

## `localProgress` — `persistence.ts`

```ts
interface PersistenceAdapter<T> { load: () => T; save: (state: T) => void }
interface PlayerProgress { checkpoint: number }   // -1 = none
localProgress(mode: string): PersistenceAdapter<PlayerProgress>
```

`localStorage[`${mode}.state`]`; every failure falls back to `{ checkpoint: -1 }`.

**Every player save goes through a `PersistenceAdapter`** (Kodjo's rule, `CLAUDE.md`): a game declares its save's
shape and an adapter for it — Keyboard's `localKeyboardSave` ([progression.md](../../games/keyboard/progression.md)) —
and nothing else touches storage, so platform accounts replace local storage by replacing the adapter.

## `levelAssets` — `assets.ts`

```ts
levelAssets(needs: LevelNeeds, json: ReadonlyMap<string, unknown>, base: string): LevelAssets
interface LevelAssets {
  db: AssetDatabase                                    // the list's entries: this level's assets and nothing else
  urlOf: (path: string) => string                      // the list's url, absolute; a path not on it → base + content/<path>
  materialOf: (assetId: string) => MaterialAsset | undefined
  dataOf: (assetId: string) => DataAsset | undefined   // ADR 0181
  prefabs: PrefabSource                                // ADR 0091
}
```

`json`: each prefab's, material's and data asset's fetched JSON by id (`loadLevel` fetches those three kinds). A
material needs a `shader` string, a prefab a `components` array, a data asset `isDataAsset`; anything else is an
unresolved reference. Prefabs and materials are held before the level is
built because resolution has to finish before `instantiateLevel`, which stays synchronous (`baseIndex` goes on the
wire, ADR 0021). A reference no file resolves draws nothing and warns once. Nothing hands a `builtin:` shape or a
prefab id to `assets.load`: neither is a file (ADR 0090, 0091).

## Other exports

`GAME_CLIENT_VERSION = '0.0.0'`; type re-export `UiOverlay` from `@mp/render-pixi`.
