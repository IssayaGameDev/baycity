# Rendering — `@mp/render-three`, `@mp/render-pixi`

Three.js world on WebGL2 + Pixi 2D overlay stacked above it. Both re-export their library so the stack shares one
pinned copy: `export * as THREE from 'three'` (+ `OrbitControls`, `TransformControls`) and
`export { Container, Graphics } from 'pixi.js'` (ADR 0071).

## Stage — `packages/render-three/src/stage.ts`

```ts
createThreeStage({ canvas, cameraPosition? = [0,12,20], lookAt? = [0,1,0], background? = 0x0b1020 }: ThreeStageOptions): ThreeStage
interface ThreeStage {
  readonly scene: THREE.Scene; readonly camera: THREE.PerspectiveCamera; readonly renderer: THREE.WebGLRenderer
  start: (onFrame: (dtSeconds: number) => void) => void; stop: () => void
  setRenderStep: (step: (() => void) | null) => void   // replaces renderer.render; null restores
  resize: () => void; dispose: () => void
}
OVERLAY_LAYER = 1
```

- `PerspectiveCamera(60, 1, 0.1, 1000)`; pixel ratio `min(devicePixelRatio, 2)`; `antialias: true`.
- **Resize via `ResizeObserver` on the canvas** (fires after layout — iOS rotation fires `window.resize` before) plus
  `window.resize`. Reads `canvas.clientWidth/Height`, `renderer.setSize(w, h, false)`, updates aspect.
- Loop: `onFrame(dt)` then `renderStep()` or `renderer.render`.

## Post-FX render step — `packages/game-client/src/scene.ts`

`createScene` sets `stage.setRenderStep`:

1. `postfx.render()` — world + AO + bloom + output + SMAA, camera on layer 0.
2. `renderer.setRenderTarget(null)`; `scene.background = null` (a colour background forces a clear);
   `autoClear = false`; `camera.layers.set(OVERLAY_LAYER)`; `clearDepth()`; `renderer.render(scene, camera)`.
3. Restore layer 0, background, `autoClear = true`.

Objects on `OVERLAY_LAYER` (nametags, `'over'` world labels) escape GTAO, tone mapping and shadows.

## `createPostFX` — `postfx.ts`

```ts
createPostFX(renderer, scene, camera, opts: PostFXOptions = {}): PostFX
interface PostFXOptions {
  ao?: boolean                                  // default true; GTAOPass built unless false
  aoIgnores?: () => Iterable<THREE.Object3D>    // hidden for the AO prepass only (ADR 0055)
  bloom?: boolean; bloomStrength?: number; bloomRadius?: number = 0.4; bloomThreshold?: number = 0.85
  outlines?: () => readonly OutlineGroup[]      // asked each frame; absent = no outline pass (the game)
}
interface PostFX {
  composer: EffectComposer; bloom: UnrealBloomPass; ao: GTAOPass | null
  params: PostFXConfig        // live; pane binds this object
  refresh: () => void         // push params onto passes
  apply: (from: Partial<PostFXConfig> | undefined) => void   // Object.assign(params, DEFAULT_POSTFX, from)
  render: () => void; setSize: (w, h) => void; dispose: () => void
  setCamera: (camera: THREE.Camera) => void   // re-point RenderPass + GTAOPass + the outline (ADR 0094)
}
DEFAULT_POSTFX: PostFXConfig = { ao: true, bloom: true, bloomStrength: 0.1 }
```

Pass order: `RenderPass` → [`hide` toggle] → `GTAOPass` → [`show` toggle] → `UnrealBloomPass` → `OutputPass`
(ACES from renderer) → [`SelectionOutlinePass`] → `SMAAPass`. The passes take their camera at construction and hold it, so `setCamera` is
the only way to swap cameras without rebuilding the composer and losing the level's AO and bloom (ADR 0094). The toggle bracket hides `aoIgnores()` objects only for the AO prepass. Own
`ResizeObserver` on `renderer.domElement`.

## Selection outline — `selectionOutline.ts` (ADR 0145)

```ts
interface OutlineGroup { roots: readonly THREE.Object3D[]; color: number /* 0xRRGGBB as displayed */ }
class SelectionOutlinePass extends Pass { camera; setGroups(groups) /* none ⇒ disabled */ }
```

Every group in one pass, drawn whatever is in front, so no depth:

| step | what |
| --- | --- |
| mask | only the groups' subtrees, each mesh wearing its group's id material (red = id/255, depth off, double-sided) for one `renderer.render(root)` each, then given its own back; lines, points and sprites hidden for it; shadows off, `autoClear` off, the clear colour borrowed and returned. A root under a hidden ancestor is skipped |
| across | the largest id within `radius` px left and right, into a second target |
| composite | the same up and down over that; a pixel outside every silhouette with an id in its square takes that id's colour (a constant-index lookup), anything else is the image |

`radius` = 2 CSS px × the pixel ratio. At most 32 groups. Mask and across targets follow the composer's size.

## Shape edges — `shapeEdges.ts` (ADR 0146)

`shapeEdges(geometry): BufferGeometry | null` — where faces meet, in the geometry's own space; `null` for a
shape with none (sphere, capsule). `EdgesGeometry` at `EDGE_ANGLE_DEG` (20°), except a geometry carrying
`userData.roundedBox: RoundedBoxInfo { width; height; depth; radius }` — which `shapeGeometry` in
`materials.ts` records on every rounded box it builds — gets one segment along the 45° line of each rounded
edge, over its straight length.

## Environment & sky — `environment.ts`, `sky.ts`

```ts
applyGreyboxEnvironment(renderer, scene, opts: GreyboxEnvironmentOptions = {}): GreyboxEnvironment
interface GreyboxEnvironmentOptions {
  exposure? = 1; sunElevation? = 30; sunAzimuth? = 38; sunIntensity? = 2.2; shadowRadius? = 30; shadowMapSize? = 2048
  fogFar?; sky? = true; skyParams?: Partial<SkyParams>; skyFaceSize? = 512
  environmentIntensity? = 0.2 (sky) | 1; fillIntensity? = 0 (sky) | 0.35
}
interface GreyboxEnvironment {
  sun: THREE.DirectionalLight; fill: THREE.HemisphereLight; sky: ProceduralSky | null
  sunAngles: SunAngles; skyParams: SkyParams       // live; mutate then refresh()
  refresh: () => void                              // sun position, sky bake, PMREM
  applyEnvironment: (env: Partial<EnvironmentConfig> | undefined) => void   // sun/ambient/sky; postfx excluded (ADR 0048)
  dispose: () => void
}
```

- Sets `ACESFilmicToneMapping`, `PCFSoftShadowMap`. Sun shadow frustum ±`shadowRadius`, `bias −0.0002`, `normalBias 0.02`.
- Sky (ADR 0046): `createProceduralSky(renderer, faceSize)` — monotonic gradient shader baked to a `HalfFloat`
  cubemap; `background` (with sun disc) and `environment()` PMREM (disc off). `DEFAULT_SKY_PARAMS`, `sunDirection`,
  `skyUniformValues` exported. `sky: false` → `RoomEnvironment` PMREM. The only sky (ADR 0170).

## A cubemap `scene.background` does not fill an orthographic view

Three draws one as a **1 x 1 x 1 box parked at the camera**, inside-out, `depthTest: false`
(`WebGLBackground`). The perspective divide is what makes that cover the screen — a corner half a metre away
at 45 degrees lands at the edge. Orthographic has no divide, so half a metre stays half a metre and the box
projects to a patch a couple of viewport-metres across, leaving the clear colour everywhere else. It reads as
"the sky went black".

Nothing above the renderer can resize that box; it is created lazily inside three and never exposed. So a
consumer that offers an orthographic view has to supply its own background for it. The editor swaps in a flat
`Color` mixed from the level's own sky while isometric and restores the cube on the way out
(`installEnvironment` / `applyProjectionBackground`, `editor.md`).

Drawing the sky properly in both projections — a large mesh, or a full-screen quad reconstructing the view ray
from the inverse projection and sampling the cube — is the real fix and costs a draw every frame in the game
too. Deferred to the render pass (`budgets.md`).

## Anything holding a scene object goes stale when that object is replaced

Three.js helpers and controls **capture** what they are given and read it every frame. None of them notice it
leaving the scene. So every long-lived reference is a liability the moment something rebuilds.

| Holder | Captures | Symptom when stale | How it is re-pointed |
|---|---|---|---|
| `TransformControls` | `.object` (attach), `.camera` | `object.parent` is `null`: a per-frame `console.error` ("must be a part of the scene graph"), then a throw on the next click — `pointerDown` dereferences that null parent and guards only `object === undefined` | `attach()` again, or `detach()` |
| `BoxHelper` | the object it wraps | silent: `update()` measures a disposed group, so the box freezes or collapses. No error at all | rebuild it |
| `RenderPass` | the camera, at construction | renders through the old camera forever | `PostFX.setCamera` exists for exactly this (ADR 0094) |
| `GTAOPass` | the camera **and its kind**, as a shader define | worse than stale: with the define saying perspective and the matrices saying orthographic, the AO term is garbage, and AO multiplies — the whole viewport goes black | `PostFX.setCamera` also rewrites `PERSPECTIVE_CAMERA` on `gtaoMaterial` and `pdMaterial` and flags a recompile. Three sets it on neither after construction, and on `pdMaterial` never |
| `OrbitControls` | `.object` | orbits a camera nobody is looking through | assign `.object` |

Two shapes of the same bug, and the quiet one is worse. Attaching a *getter* rather than an object is the
cheapest fix where the API allows it — the editor's view gizmo takes `camera: () => Camera` for this reason.

Where it cannot, **the re-pointing belongs inside the rebuild**, at every exit, not at the rebuild's call
sites. Call sites are where it was last time, and an async redraw simply did not go through them
(`editor.md`, "Rebuilding the viewport").

## Level view — `levelView.ts`

```ts
addLevel(scene, visuals: VisualItem[], opts: LevelViewOptions = {}): LevelView
interface LevelViewOptions { shadows? = true; assets?: AssetRuntime; cutout?: CutoutMask }
interface LevelView {
  group: THREE.Group
  sync: () => void                                     // visual → object: position, rotation, scale × drawScale, visible, opacity (ADR 0141)
  setOccluders: (handles: readonly number[]) => void   // swap masked material variants; no-op without cutout
  occluding: () => readonly THREE.Object3D[]           // meshes currently masked → PostFXOptions.aoIgnores
  meshesOf: (handle: number) => readonly THREE.Mesh[]  // collider handle → drawn meshes (ADR 0082)
  dispose: () => void
}
addMarkers(scene, markers: WorldMarker[]): MarkersView   // translucent pad + ring, radius 0.8, colorForMarker
```

- Model (`assets.model`) replaces greybox shape, not collider; material from `assets.material` else
  `createGreyboxMaterial()`. Synchronous — assets must be preloaded. A model is sized by `VisualItem.scale`, its
  node's world scale, times its own root scale — as the editor draws it (ADR 0207); `drawScale` stretches from there.
- `meshesByHandle` populated only when `cutout` supplied (`VisualItem.colliderHandles`).
- Masked variants cached per plain material (`cutout.variant`), disposed by the view.

## Asset runtime — `assetRuntime.ts`

```ts
createAssetRuntime({ db: AssetDatabase, urlOf: (path) => string, materialOf: (id) => MaterialAsset | undefined }): AssetRuntime
interface AssetRuntime {
  load: (assetIds: readonly string[]) => Promise<boolean>   // transitive (material → textures); dedupes in-flight; true when any was not held yet
  refreshMaterial: (id) => Promise<boolean>              // recompile into the held object (copy + needsUpdate; its old map clone disposed); false = the class changed, new one cached, rebuild what draws it (ADR 0157)
  refreshTexture: (id) => Promise<string[]>              // fetch again past caches (?v=), then refreshMaterial every loaded user — each holds its own clone; → their ids
  refreshModel: (id) => Promise<void>                    // fetch again; placed clones are the caller's to rebuild
  material: (id) => THREE.Material | null                // compileMaterial(asset, textureLookup)
  model: (id) => THREE.Object3D | null                   // fresh clone(true) of cached GLTF scene
  texture: (id) => THREE.Texture | null                  // SRGBColorSpace
  dispose: () => void
}
assetIdsIn(visuals: readonly VisualItem[]): string[]     // model + material ids
```

Unknown id → `console.warn`, greybox stands in. `sound`/`font` kinds not loaded.

## Materials — `materials.ts`

```ts
type GizmoKind = 'spawn' | 'checkpoint' | 'goal' | 'hazard' | 'bumper'
MARKER_COLORS: Record<GizmoKind, number> = { spawn: 0x2979ff, checkpoint: 0x00e676, goal: 0xffea00, hazard: 0xff1744, bumper: 0xff9100 }
colorForMarker(kind): number
createGreyboxMaterial(): MeshStandardMaterial      // 0x475569, roughness 0.85, metalness 0 — not configurable
BEVEL_RADIUS = 0.5; BEVEL_SEGMENTS = 2; bevelFor(sx, sy, sz, wanted = BEVEL_RADIUS): number   // ≤ 0.25 × shortest side
geometryForCollider(c: ColliderDesc): BufferGeometry     // box → RoundedBoxGeometry; capsule/ball/cylinder/convex
geometryForBuiltin(id: BuiltinModel, scale: Vec3)        // ADR 0090: unit shape × scale; rounded only for builtin:rounded-box
outlineGeometryForCollider(c): BufferGeometry            // sharp edges, for wireframes
```

Shaders (`shaders.ts`): `BUILTIN_SHADERS`, `shaderDef`, `registerShader`, `defaultParams`, `compileMaterial`.

## Camera cutout — `cutout.ts` (ADR 0055, ADR 0148)

```ts
interface CutoutState { camera: Vec3; target: Vec3; radius: number; feather: number; strength: number }
createCutoutMask(init: CutoutState): CutoutMask
interface CutoutMask { set: (next: Partial<CutoutState>) => void; state: () => CutoutState; variant: (m: THREE.Material) => THREE.Material }
injectCutout(source): { vertexShader; fragmentShader; injected: boolean }   // anchors: '#include <project_vertex>', 'void main() {'
cutoutCoverage(s: CutoutState, point: Vec3): number     // tested TS twin of the GLSL
```

Cone from eye to `target`, radius at target, dither `discard` (interleaved gradient noise). Uniforms shared by
reference across variants; one `onBeforeCompile` closure so programs are shared. `OrbitCamera.cutout`
(`packages/camera/src/orbit.ts`) owns the instance and sets per frame: `camera` = eye, `target` = capsule centre,
`radius = camMaskRadius × aperture`, `feather = camMaskFeather`; aperture chased on `camMaskSmooth`. Occluder
handles come from `castSphere` with `probeRadius = 0.25`; pull-in only when the camera would be inside solid or
below the feet. `OrbitCamera.update(dt, body, setOccluders, focus?): Placement { rigVisible }` hands the handles to
`LevelView.setOccluders` each frame. `focus` (a dead player's head, ADR 0209) replaces the aim point (`body` +
`AIM_RISE`): aimed at exactly, no body probes, `feetY = focus.y`, cutout `target = focus`. **Only while `params.camSeeThrough`** — the level's `config.cameraSeeThrough`
(ADR 0148), off by default: off, `occlusionFor(..., { seeThrough: false })` makes one cast along the boom, its hit
is the limit (ADR 0020), and nothing is holed.

## Text — `text.ts`, `levelText.ts`, `worldLabel.ts` (ADR 0189, ADR 0190, ADR 0082)

One drawing for every text: `troika-three-text` (signed-distance glyphs laid out in a worker, one shared atlas,
one draw call a block). The default font is this package's own file — `src/fonts/roboto-latin-400-normal.woff`,
Roboto, OFL (`fonts/OFL.txt`), 21 KB, by `new URL(…, import.meta.url)` so Vite ships it; any other is an uploaded
font's URL (`font`). The library reaches for a CDN only for a character its font has not got.
`troika-three-text.d.ts` types the part used.

**Bold is drawn** (ADR 0190, Kodjo's call: one way, for every font): `outlineWidth = size × BOLD_WIDEN` (0.017),
`outlineColor` the text's — each letter's edge widened in its own colour. `BOLD_WIDEN` is measured to ink Roboto as
its own Bold file does (1913 against 1899 lit pixels, headless).

```ts
interface TextStyle { text; font: string | null /* URL, null Roboto */; size /* em, metres */; color;
  align: 'left'|'center'|'right'; width /* wrap m, 0 none */; weight: 'normal'|'bold' /* drawn */;
  facing: 'object'|'camera'; back: 'mirrored'|'hidden'; depth: 'world'|'over'; opacity }
createText(style?: Partial<TextStyle>, facing?: { around?: Object3D }): WorldText
interface WorldText { object: THREE.Mesh; material; set(style); fade(opacity); laidOut(fn(bounds)); dispose() }
faceCamera(object, { around? })   // turns it to each camera at draw time, in matrixWorld only
textStyleOf(desc: TextDesc, fontUrl?: FontUrlOf): Partial<TextStyle>   // a Text's reading, depth 'world' — game and editor
addTexts(scene, items: TextItem[], fontUrl?: FontUrlOf): LevelTexts { sync; objects; dispose }   // posed every frame
type FontUrlOf = (assetId: string) => string | null   // the game's and the editor's `AssetRuntime.fontUrl`
```

| | |
| --- | --- |
| block | `anchorX 'center'`, `anchorY 'middle'` on the origin; `textAlign` lines up the lines |
| `facing: 'object'` | the node's XY plane, read from +Z; turns and scales with it (Unity's TextMeshPro) |
| `facing: 'camera'` | `faceCamera` in `onBeforeRender`: `matrixWorld` recomposed with the camera's turn, about the object's origin or `around`'s (its position then an offset in the camera's frame) |
| `back` | `'mirrored'` `DoubleSide` (Unity's default), `'hidden'` `FrontSide`; facing the camera always double |
| material | base `MeshBasicMaterial { transparent, depthWrite: false, toneMapped: false }` troika derives from: unlit, and a glyph's empty margin hides nothing |
| `depth` | `'world'` layer 0, depth-tested; `'over'` `OVERLAY_LAYER`, `renderOrder 999+`, no depth test |
| AO | world text is kept out of the prepass: the level's by `LevelHost.texts()` (`tps` adds it to `aoIgnores`), a sign's by `excludeFromAO` |

**Labels** (`worldLabel.ts`): lines facing the camera — a `createText` per line, each about the label's group so
the stack holds; a line's `size` relative, the whole `heightM` tall; a backdrop plane (`parseFill`: `rgba()` keeps
its alpha) sized once every line is laid out.

```ts
interface LabelLine { text: string; size: number; color?: string; weight?: 'normal' | 'bold' }   // weight default bold (drawn)
interface WorldLabelOptions { heightM? = 0.5; depth? = 'over' | 'world'; background? = 'rgba(11,16,32,0.6)' | null; padding? = 12 }
worldLabel(lines, opts?): THREE.Group
stackLines(lines, padding): { total; rows: { line; y }[] }   // pure, tested; GAP 4
disposeWorldLabel(label: THREE.Object3D): void               // its texts and backdrop; caller removes from scene
```

Nametag = `worldLabel([{ text, size: 32 }], { heightM: 0.5 })` (`packages/tps/src/nametag.ts`), `'over'`.

A visual with `fades` gets its **own** material copy per mesh at build, `transparent` from the start, so fading one piece fades no other and never recompiles; its see-through-hole copy (ADR 0055) fades with it. Faded to 0 it is not drawn at all, so it casts nothing.

`geometryForBuiltin('builtin:quad', scale)` is a `PlaneGeometry(scale.x, scale.y)` toward +Z (ADR 0189), not its collider.

`AssetRuntime.fontUrl(id)` (ADR 0190): a font asset's file URL for the text library, which fetches it itself — nothing
loaded; `null` for no such font or a woff2 (`textFontRefusal`).

Also exported: `addLights(scene, lights: WorldLight[]): ContentLights { sync; dispose }` (ADR 0047; `sync` also applies `visible`),
`createCharacterRig`/`createLooseParts`, `createThumbnailer`/`fitDistance`.

## `@mp/render-pixi` — `packages/render-pixi/src`

```ts
createUiOverlay({ width, height }): Promise<UiOverlay>
interface UiOverlay {
  readonly canvas: HTMLCanvasElement; readonly root: Container; width: number; height: number
  resize: (width, height) => void; setInteractive: (on: boolean) => void
  setBackgroundTap: (fn: (() => void) | null) => void
  widgetAt: (x, y) => boolean   // an interactive widget, not the backdrop, under an overlay point (ADR 0203)
  dispose: () => void
}
```

`Application.init({ backgroundAlpha: 0, antialias: true, resolution: devicePixelRatio, autoDensity: true })`; a
full-screen `backdrop` container behind `root` catches empty-space taps. `widgetAt` is
`renderer.events.rootBoundary.hitTest`, anything but the backdrop — so a widget is whatever has `eventMode` static.

Widgets (`ui.ts`, placeholder-skinned `Graphics`):

| Export | Signature |
| --- | --- |
| `uiGroup()` | `Container` |
| `uiLabel(text, style?: LabelStyle { size? = 16; color? = 0xe5e7eb; weight?; align? })` | `Text` |
| `uiPanel({ width, height, color? = 0x1b1f2a, alpha? = 0.98, radius? = 16 })` | `Container` |
| `uiButton({ label, width, height? = 44, color? = 0x3b82f6, onClick })` | `UiButton { view; setLabel; setColor }` |
| `uiSlider({ width, value, onChange })` | `UiSlider { view; setValue }` (0..1) |
| `uiList({ width, height, rowHeight? = 30, textSize? = 15 })` | `UiList { view; setItems(ListItem[]) }`; scrolls by wheel or drag (`clampListScroll`). `ListItem { text; highlight?; muted?; onPick? }` (`muted`: greyed text `0x64748b`, a row there but shut — give it no `onPick`, ADR 0211): a row with `onPick` is a button — lit under the pointer, picked by a press that travelled ≤ `LIST_DRAG_SLOP` 6 px (`listRowAt`); further, it drags the list (ADR 0203) |

Touch HUD (`touchHud.ts`):

```ts
createTouchHud(parent: Container, style: TouchHudStyle = DEFAULT_TOUCH_HUD_STYLE): TouchHud
interface TouchHud { draw: (stick: TouchHudStick, jump: TouchHudButton) => void; setVisible: (v: boolean) => void; dispose: () => void }
DEFAULT_TOUCH_HUD_STYLE = { color: 0xe2e8f0, idleAlpha: 0.3, activeAlpha: 0.65 }
```

Immediate-mode redraw; `eventMode = 'none'` (never swallows pointers). `TouchHudStick`/`TouchHudButton` are
structurally `JoystickState`/`JumpButtonState` from `@mp/client`. `RENDER_PIXI_VERSION = '0.0.0'`.
