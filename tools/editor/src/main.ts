import {
  addCharacter,
  CHAR_HALF_HEIGHT,
  CHAR_RADIUS,
  DEFAULT_TUNING,
  stepCharacter,
  TICK_DT,
  TICK_RATE_HZ,
  type CharacterState,
  type CharacterTuning,
} from '@mp/character'
import { createLocalController, type LocalController, type LocalWorld } from '@mp/client'
import { instantiateLevel, platform, type Level, type LoadedLevel, type Prefab } from '@mp/content'
import { createSimClock, eulerToQuat, quat, startFixedLoop, vec3, type EntityId, type LoopHandle, type Vec3 } from '@mp/core'
import { createPhysicsWorld, initPhysics, type PhysicsWorld } from '@mp/physics'
import {
  addLevel,
  applyGreyboxEnvironment,
  colorForStyle,
  createPostFX,
  createStyleMaterial,
  createThreeStage,
  geometryForCollider,
  OrbitControls,
  STYLE_PALETTE,
  THREE,
  TransformControls,
  type LevelView,
} from '@mp/render-three'
import { Pane } from 'tweakpane'

import { levelDoc, prefabDoc, type BehaviorKind, type Doc, type ItemProps, type Mode, type TriggerChoice } from './editorDoc'
import { listFiles, loadLevel, loadPrefab, saveFile, type FileKind } from './filesApi'

const canvas = document.querySelector<HTMLCanvasElement>('#view')!
const titleEl = document.querySelector<HTMLDivElement>('#title')!

// --- scene + polished pipeline (same renderer the game/viewer use) ---
const stage = createThreeStage({ canvas, cameraPosition: [12, 10, 16], lookAt: [0, 1, 0] })
applyGreyboxEnvironment(stage.renderer, stage.scene, { shadowRadius: 40, sunIntensity: 2.4 })
const postfx = createPostFX(stage.renderer, stage.scene, stage.camera, { ao: true, bloom: true, bloomStrength: 0.3 })
stage.setRenderStep(postfx.render)

const controls = new OrbitControls(stage.camera, canvas)
controls.enableDamping = true
controls.target.set(0, 1, 0)

const grid = new THREE.GridHelper(80, 80, 0x475569, 0x1f2937)
;(grid.material as THREE.Material).transparent = true
;(grid.material as THREE.Material).opacity = 0.5
const axes = new THREE.AxesHelper(3)
stage.scene.add(grid, axes)

// --- editor state ---
let world: PhysicsWorld | null = null
let loaded: LoadedLevel | null = null // for marker/trigger gizmos (+ physics validity)
let doc: Doc | null = null
const userPrefabs: Record<string, Prefab> = {} // authored prefab library (for the level palette)

const instanceRoot = new THREE.Group() // one Group per editable item (userData.index → data)
const markerGroup = new THREE.Group()
stage.scene.add(instanceRoot, markerGroup)
let instanceGroups: THREE.Group[] = []
let selected: number | null = null
let placing: string | null = null // a palette entry name awaiting a click to place
let playing = false // play-in-place active (editing is suspended)
let lastSimTickAt = 0

const fileKind = (m: Mode): FileKind => (m === 'level' ? 'levels' : 'prefabs')

const r4 = (n: number): number => Math.round(n * 1e4) / 1e4
const isOne = (v: THREE.Vector3): boolean => Math.abs(v.x - 1) < 1e-4 && Math.abs(v.y - 1) < 1e-4 && Math.abs(v.z - 1) < 1e-4
const isZeroRot = (e: THREE.Euler): boolean => Math.abs(e.x) < 1e-5 && Math.abs(e.y) < 1e-5 && Math.abs(e.z) < 1e-5

const disposeMeshes = (g: THREE.Object3D): void => {
  for (const child of [...g.children]) {
    g.remove(child)
    child.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments || o instanceof THREE.Line) {
        o.geometry.dispose()
        ;(o.material as THREE.Material).dispose()
      }
    })
  }
}

const applyTransform = (o: THREE.Object3D, position: Vec3, rotation: Vec3 | undefined, scale: Vec3 | undefined): void => {
  o.position.set(position.x, position.y, position.z)
  const q = rotation !== undefined ? eulerToQuat(rotation) : quat()
  o.quaternion.set(q.x, q.y, q.z, q.w)
  if (scale !== undefined) o.scale.set(scale.x, scale.y, scale.z)
  else o.scale.set(1, 1, 1)
}

// --- marker/trigger gizmos (a translucent disc + pillar, coloured by kind) ---
const markerGizmo = (position: Vec3, color: number): THREE.Group => {
  const g = new THREE.Group()
  const disc = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1, 0.05, 32),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.3, depthWrite: false, toneMapped: false }),
  )
  const pillar = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1.5, 0)]),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false, toneMapped: false }),
  )
  g.add(disc, pillar)
  g.position.set(position.x, position.y + 0.03, position.z)
  return g
}

const buildMarkers = (): void => {
  disposeMeshes(markerGroup)
  if (loaded === null) return
  for (const m of loaded.markers) if (m.kind === 'spawn') markerGroup.add(markerGizmo(m.position, colorForStyle('spawn')))
  for (const t of loaded.triggers) markerGroup.add(markerGizmo(t.position, colorForStyle(t.kind)))
}

// --- editable item meshes (one Group per item; meshes come from the doc's specs) ---
const buildItemMeshes = (g: THREE.Group, i: number): void => {
  if (doc === null) return
  for (const spec of doc.meshSpecs(i)) {
    const mesh = new THREE.Mesh(geometryForCollider(spec.collider), createStyleMaterial(spec.style))
    applyTransform(mesh, spec.transform.position, spec.transform.rotation, spec.transform.scale)
    mesh.castShadow = true
    mesh.receiveShadow = true
    g.add(mesh)
  }
}

const buildItems = (): void => {
  disposeMeshes(instanceRoot)
  instanceGroups = []
  if (doc === null) return
  for (let i = 0; i < doc.count(); i++) {
    const g = new THREE.Group()
    const t = doc.transformOf(i)
    applyTransform(g, t.position, t.rotation, t.scale)
    g.userData.index = i
    buildItemMeshes(g, i)
    instanceRoot.add(g)
    instanceGroups[i] = g
  }
}

const rebuildSelectedMeshes = (): void => {
  if (selected === null) return
  const g = instanceGroups[selected]
  if (g === undefined) return
  disposeMeshes(g)
  buildItemMeshes(g, selected)
}

// --- cardinal directions (behavior axis) ---
const DIRS: Record<string, Vec3> = {
  '+X': vec3(1, 0, 0),
  '-X': vec3(-1, 0, 0),
  '+Y': vec3(0, 1, 0),
  '-Y': vec3(0, -1, 0),
  '+Z': vec3(0, 0, 1),
  '-Z': vec3(0, 0, -1),
}
const DIR_OPTIONS: Record<string, string> = { '+X': '+X', '-X': '-X', '+Y': '+Y', '-Y': '-Y', '+Z': '+Z', '-Z': '-Z', custom: 'custom' }
const dirNameOf = (a: Vec3): string => {
  const len = Math.hypot(a.x, a.y, a.z) || 1
  const n = vec3(a.x / len, a.y / len, a.z / len)
  for (const [k, v] of Object.entries(DIRS)) if (Math.abs(n.x - v.x) < 1e-3 && Math.abs(n.y - v.y) < 1e-3 && Math.abs(n.z - v.z) < 1e-3) return k
  return 'custom'
}

// --- end-position widget: a translucent ghost of a moving piece at its far end + a line ---
const ghostMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.22, depthWrite: false, toneMapped: false })
const endLineMat = new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false, toneMapped: false })
const endHelper = new THREE.Group()
stage.scene.add(endHelper)
const clearEndHelper = (): void => {
  for (const c of [...endHelper.children]) {
    endHelper.remove(c)
    c.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Line) o.geometry.dispose() // shared materials kept
    })
  }
}
const updateEndGhost = (): void => {
  clearEndHelper()
  endHelper.visible = false
  if (selected === null || doc === null) return
  const p = doc.props(selected)
  if (p.behavior !== 'move') return
  const g = instanceGroups[selected]
  if (g === undefined) return
  const len = Math.hypot(p.axis.x, p.axis.y, p.axis.z) || 1
  const end = g.position.clone().add(new THREE.Vector3(p.axis.x / len, p.axis.y / len, p.axis.z / len).multiplyScalar(p.distance))
  const ghost = new THREE.Group()
  ghost.position.copy(end)
  ghost.quaternion.copy(g.quaternion)
  ghost.scale.copy(g.scale)
  for (const spec of doc.meshSpecs(selected)) {
    const m = new THREE.Mesh(geometryForCollider(spec.collider), ghostMat)
    applyTransform(m, spec.transform.position, spec.transform.rotation, spec.transform.scale)
    ghost.add(m)
  }
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([g.position.clone(), end]), endLineMat)
  endHelper.add(ghost, line)
  endHelper.visible = true
}

// Re-derive markers/triggers + physics from the current doc (after edits; also a validity check).
const rebuildLoaded = (): void => {
  if (doc === null) return
  world?.free()
  world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
  try {
    loaded = instantiateLevel(world, doc.asLevel())
    buildMarkers()
  } catch (e) {
    loaded = null
    disposeMeshes(markerGroup)
    titleEl.textContent = `invalid: ${String(e)}`
  }
}

let rebuildTimer: number | null = null
const scheduleRebuild = (): void => {
  if (rebuildTimer !== null) clearTimeout(rebuildTimer)
  rebuildTimer = window.setTimeout(() => {
    rebuildTimer = null
    rebuildLoaded()
  }, 150)
}

const setDoc = (next: Doc, name: string): void => {
  deselect()
  doc = next
  fileState.name = name
  buildItems()
  rebuildLoaded()
  mountPalette()
  titleEl.textContent = `${next.mode}: ${name} — ${next.count()} ${next.mode === 'level' ? 'instances' : 'pieces'}`
}

const blankLevel = (id: string): Level => ({
  id,
  config: { fallBehavior: 'respawn-checkpoint', fallY: -10 },
  instances: [{ prefab: platform({ width: 20, depth: 20, thickness: 1, style: 'ground' }), transform: { position: vec3(0, -0.5, 0) } }],
  markers: [{ kind: 'spawn', transform: { position: vec3(0, 0, 0) } }],
})
const blankPrefab = (id: string): Prefab => ({
  id,
  pieces: [{ collider: { kind: 'box', halfExtents: vec3(1.5, 0.15, 1.5) }, transform: { position: vec3(0, 0, 0) } }],
})

// --- selection + transform gizmo ---
const gizmo = new TransformControls(stage.camera, canvas)
const applySnap = (): void => {
  gizmo.setTranslationSnap(edit.snap ? edit.step : null)
  gizmo.setRotationSnap(edit.snap ? THREE.MathUtils.degToRad(15) : null)
  gizmo.setScaleSnap(edit.snap ? 0.1 : null)
}
stage.scene.add(gizmo.getHelper())

let gizmoDragged = false
gizmo.addEventListener('dragging-changed', (event) => {
  const dragging = event.value as boolean
  controls.enabled = !dragging
  if (dragging) gizmoDragged = true
  else rebuildLoaded()
})
gizmo.addEventListener('objectChange', () => {
  writeBackSelected()
  syncInspector()
  updateEndGhost()
})

// Copy the selected group's pose back into the doc (position always; rotation/scale only if any).
const writeBackSelected = (): void => {
  if (selected === null || doc === null) return
  const g = instanceGroups[selected]
  if (g === undefined) return
  const t = doc.transformOf(selected)
  t.position = vec3(r4(g.position.x), r4(g.position.y), r4(g.position.z))
  const e = new THREE.Euler().setFromQuaternion(g.quaternion, 'XYZ')
  if (isZeroRot(e)) delete t.rotation
  else t.rotation = vec3(r4(e.x), r4(e.y), r4(e.z))
  if (isOne(g.scale)) delete t.scale
  else t.scale = vec3(r4(g.scale.x), r4(g.scale.y), r4(g.scale.z))
}

const select = (index: number): void => {
  const g = instanceGroups[index]
  if (g === undefined || doc === null) return
  selected = index
  gizmo.attach(g)
  buildInspector()
  updateEndGhost()
  titleEl.textContent = `selected #${index} (${doc.label(index)})`
}

const deselect = (): void => {
  selected = null
  gizmo.detach()
  buildInspector()
  updateEndGhost()
}

const raycaster = new THREE.Raycaster()
const ndc = new THREE.Vector2()
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
let downX = 0
let downY = 0
canvas.addEventListener('pointerdown', (e) => {
  downX = e.clientX
  downY = e.clientY
  gizmoDragged = false
})
canvas.addEventListener('pointerup', (e) => {
  if (playing) return // editing suspended during play (pointer = camera only)
  if (gizmoDragged) return // was dragging the gizmo, not a click
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 4) return // was an orbit drag
  const rect = canvas.getBoundingClientRect()
  ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
  raycaster.setFromCamera(ndc, stage.camera)

  // Placement mode: drop the chosen palette entry on the surface (or ground plane).
  if (placing !== null && doc !== null) {
    const surf = raycaster.intersectObjects(instanceRoot.children, true)[0]
    const point = new THREE.Vector3()
    if (surf !== undefined) point.copy(surf.point)
    else if (raycaster.ray.intersectPlane(groundPlane, point) === null) {
      placing = null
      return
    }
    const snap = edit.snap ? edit.step : 0
    const sx = snap !== 0 ? Math.round(point.x / snap) * snap : r4(point.x)
    const sz = snap !== 0 ? Math.round(point.z / snap) * snap : r4(point.z)
    const idx = doc.place(placing, vec3(sx, r4(point.y), sz))
    placing = null
    titleEl.textContent = ''
    buildItems()
    rebuildLoaded()
    select(idx)
    return
  }

  const hit = raycaster.intersectObjects(instanceRoot.children, true)[0]?.object
  if (hit === undefined) {
    deselect()
    return
  }
  let o: THREE.Object3D | null = hit
  while (o !== null && o.userData.index === undefined) o = o.parent
  if (o !== null && typeof o.userData.index === 'number') select(o.userData.index)
})

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
  if (playing) {
    if (e.code === 'Escape') stopPlay()
    return // WASD/Space handled by the play key listener; editing shortcuts off
  }
  if (e.code === 'KeyT' || e.code === 'KeyG') setMode('translate')
  else if (e.code === 'KeyR') setMode('rotate')
  else if (e.code === 'KeyS') setMode('scale')
  else if (e.code === 'Delete' || e.code === 'Backspace') deleteSelected()
  else if (e.code === 'KeyD' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    duplicateSelected()
  } else if (e.code === 'Escape') {
    if (placing !== null) {
      placing = null
      titleEl.textContent = 'placement cancelled'
    } else deselect()
  }
})

const deleteSelected = (): void => {
  if (selected === null || doc === null) return
  doc.remove(selected)
  deselect()
  buildItems()
  rebuildLoaded()
}
const duplicateSelected = (): void => {
  if (selected === null || doc === null) return
  const idx = doc.duplicate(selected)
  buildItems()
  rebuildLoaded()
  select(idx)
}

// ============================ play-in-place (identical to the game) ============================
// Same building blocks as modes/parkour: createLocalController (fixed tick + render interpolation),
// the two-phase step (move platforms, then resolve the character against them), and stepCharacter
// with DEFAULT_TUNING. The viewer skipped the controller/interpolation, which is why it felt off.
const PLAYER_ID = 0 as EntityId
const STAND_OFFSET = CHAR_HALF_HEIGHT + CHAR_RADIUS
const playState = { on: false }
let playBinding: { refresh: () => void } | null = null

const keys = new Set<string>()
window.addEventListener('keydown', (e) => {
  keys.add(e.code)
  if (playing && (e.code === 'Space' || e.code.startsWith('Arrow'))) e.preventDefault()
})
window.addEventListener('keyup', (e) => keys.delete(e.code))

const charMesh = new THREE.Mesh(
  new THREE.CapsuleGeometry(CHAR_RADIUS, CHAR_HALF_HEIGHT * 2, 8, 20),
  new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.6 }),
)
charMesh.castShadow = true
charMesh.visible = false
stage.scene.add(charMesh)

const tuning: CharacterTuning = { ...DEFAULT_TUNING }
let char: CharacterState | null = null
let controller: LocalController | null = null
let playLoop: LoopHandle | null = null
let playView: LevelView | null = null
let ownPos: Vec3 = { x: 0, y: 1, z: 0 }

// The game's third-person camera: mouselook (pointer lock) yaw/pitch orbit at a fixed distance.
let camYaw = 0
let camPitch = 0.35
const camParams = { distance: 7, sensitivity: 0.0025 }
window.addEventListener('mousemove', (e) => {
  if (!playing || document.pointerLockElement !== canvas) return
  camYaw -= e.movementX * camParams.sensitivity
  camPitch = Math.min(1.2, Math.max(-0.2, camPitch + e.movementY * camParams.sensitivity))
})
canvas.addEventListener('click', () => {
  if (playing && document.pointerLockElement !== canvas) void canvas.requestPointerLock()
})
document.addEventListener('pointerlockchange', () => {
  if (playing && document.pointerLockElement !== canvas) stopPlay() // Esc / lost lock exits play
})

// WASD/arrows relative to the camera yaw (identical to the game).
const worldMove = (): { x: number; z: number } => {
  let rx = 0
  let rz = 0
  if (keys.has('KeyW') || keys.has('ArrowUp')) rz -= 1
  if (keys.has('KeyS') || keys.has('ArrowDown')) rz += 1
  if (keys.has('KeyA') || keys.has('ArrowLeft')) rx -= 1
  if (keys.has('KeyD') || keys.has('ArrowRight')) rx += 1
  if (rx === 0 && rz === 0) return { x: 0, z: 0 }
  const fwdX = -Math.sin(camYaw)
  const fwdZ = -Math.cos(camYaw)
  let x = fwdX * -rz + -fwdZ * rx
  let z = fwdZ * -rz + fwdX * rx
  const l = Math.hypot(x, z)
  if (l > 1) {
    x /= l
    z /= l
  }
  return { x, z }
}

const startPlay = (): void => {
  if (doc === null || playing) return
  rebuildLoaded() // fresh world + loaded from the current data
  if (loaded === null || world === null) return
  deselect()
  const sm = loaded.markers.find((m) => m.kind === 'spawn')?.position
  const spawn: Vec3 = sm !== undefined ? { x: sm.x, y: sm.y + STAND_OFFSET, z: sm.z } : { x: 0, y: 3, z: 0 }
  char = addCharacter(world, spawn)
  let respawnPos: Vec3 = { ...spawn }
  let cpIndex = -1
  const checkpoints = loaded.triggers.filter((t) => t.kind === 'checkpoint')
  const hazards = new Set(loaded.triggers.filter((t) => t.kind === 'hazard').map((t) => t.colliderHandle))
  const fallY = loaded.config.fallY

  // One fixed step of platform time per fixed step — see @mp/core simClock (reading the wall
  // clock inside the tick stalls the platforms during a multi-tick wake and jitters carry).
  const simClock = createSimClock({ tickMs: TICK_DT * 1000, reference: () => performance.now() })

  const local: LocalWorld = {
    applyInput: (cmd) => {
      if (world === null || loaded === null || char === null) return
      loaded.update(simClock.tick(), char.base?.colliderHandle) // only the ridden piece is frozen
      world.step(TICK_DT) // (A) platforms move
      stepCharacter(char, cmd, TICK_DT, tuning, loaded.basePose) // rides whatever it stands on
      world.step(TICK_DT) // (B) character resolves against the moved platforms
      lastSimTickAt = performance.now()
    },
    readState: () => new Map<EntityId, Vec3>([[PLAYER_ID, char!.body.translation()]]),
  }
  controller = createLocalController({ world: local, tickRateHz: TICK_RATE_HZ })

  instanceRoot.visible = false
  playView = addLevel(stage.scene, loaded.visuals)
  charMesh.visible = true
  playing = true
  playState.on = true
  playBinding?.refresh()
  controls.enabled = false // editor orbit off; the player camera takes over
  void canvas.requestPointerLock()
  titleEl.textContent = 'playing — WASD + Space · mouse to look · Esc to stop'

  playLoop = startFixedLoop({
    tickRateHz: TICK_RATE_HZ,
    onTick: () => {
      if (char === null || controller === null) return
      const m = worldMove()
      controller.step(m.x, m.z, keys.has('Space'))
      const hits = new Set(char.body.collisions())
      for (let i = 0; i < checkpoints.length; i++) {
        const t = checkpoints[i]!
        if (hits.has(t.colliderHandle) && i > cpIndex) {
          cpIndex = i
          respawnPos = { x: t.position.x, y: t.position.y + STAND_OFFSET, z: t.position.z }
          break
        }
      }
      const p = char.body.translation()
      if ([...hits].some((h) => hazards.has(h)) || p.y < fallY) {
        char.body.setPosition(respawnPos)
        char.vx = 0
        char.vy = 0
        char.vz = 0
        char.grounded = false
      }
    },
  })
}

const stopPlay = (): void => {
  if (!playing) return
  playLoop?.stop()
  playLoop = null
  char?.body.remove()
  char = null
  controller = null
  playView?.dispose()
  playView = null
  charMesh.visible = false
  instanceRoot.visible = true
  playing = false
  playState.on = false
  playBinding?.refresh()
  if (document.pointerLockElement === canvas) document.exitPointerLock()
  controls.target.set(ownPos.x, ownPos.y + 1, ownPos.z) // resume orbit around where you stopped
  controls.enabled = true
  titleEl.textContent = ''
  rebuildLoaded() // restore the edit world + markers
}

// ============================ panel ============================
const pane = new Pane({ title: 'Editor' })

// --- File: mode (Level/Prefab) + open + name + Save/New ---
const fileFolder = pane.addFolder({ title: 'File' })
const fileState: { mode: Mode; name: string } = { mode: 'level', name: 'untitled' }

const pick = { name: '' }
let pickerBlade: { dispose: () => void } | null = null
const mountPicker = (names: string[]): void => {
  pickerBlade?.dispose()
  const options: Record<string, string> = {}
  for (const n of names) options[n] = n
  if (names.length === 0) options['(none)'] = ''
  pick.name = names[0] ?? ''
  pickerBlade = fileFolder.addBinding(pick, 'name', { label: 'open', options, index: 1 }).on('change', (ev) => {
    if (ev.value !== '') void openFile(ev.value)
  })
}

const openFile = async (name: string): Promise<void> => {
  try {
    if (fileState.mode === 'level') setDoc(levelDoc(await loadLevel(name), userPrefabs), name)
    else setDoc(prefabDoc(await loadPrefab(name)), name)
  } catch (e) {
    titleEl.textContent = `load failed: ${String(e)}`
  }
}

const refreshPrefabLibrary = async (): Promise<void> => {
  for (const k of Object.keys(userPrefabs)) delete userPrefabs[k]
  for (const n of await listFiles('prefabs').catch(() => [])) {
    try {
      userPrefabs[n] = await loadPrefab(n)
    } catch {
      // skip a malformed prefab file
    }
  }
}

const enterMode = async (mode: Mode): Promise<void> => {
  fileState.mode = mode
  const names = await listFiles(fileKind(mode)).catch(() => [] as string[])
  mountPicker(names)
  if (names[0] !== undefined) await openFile(names[0])
  else setDoc(mode === 'level' ? levelDoc(blankLevel('untitled'), userPrefabs) : prefabDoc(blankPrefab('untitled')), 'untitled')
}

fileFolder.addBinding(fileState, 'mode', { options: { Level: 'level', Prefab: 'prefab' } }).on('change', (ev) => void enterMode(ev.value))
fileFolder.addBinding(fileState, 'name', { label: 'name' })
fileFolder.addButton({ title: 'Save' }).on('click', () => {
  if (doc === null) return
  void saveFile(fileKind(fileState.mode), fileState.name, doc.toJSON())
    .then(async () => {
      titleEl.textContent = `saved: ${fileState.name}`
      if (fileState.mode === 'prefab') await refreshPrefabLibrary()
      mountPicker(await listFiles(fileKind(fileState.mode)))
    })
    .catch((e: unknown) => (titleEl.textContent = `save failed: ${String(e)}`))
})
fileFolder.addButton({ title: 'New (blank)' }).on('click', () => {
  const name = fileState.name || 'untitled'
  setDoc(fileState.mode === 'level' ? levelDoc(blankLevel(name), userPrefabs) : prefabDoc(blankPrefab(name)), name)
})

// --- Add: palette (place) ---
const objFolder = pane.addFolder({ title: 'Add' })
const addPick = { kind: '' }
let paletteBlade: { dispose: () => void } | null = null
const mountPalette = (): void => {
  paletteBlade?.dispose()
  const names = doc?.palette() ?? []
  const options: Record<string, string> = {}
  for (const n of names) options[n] = n
  addPick.kind = names[0] ?? ''
  paletteBlade = objFolder.addBinding(addPick, 'kind', { label: 'prefab', options, index: 0 })
}
objFolder.addButton({ title: 'Place (then click scene)' }).on('click', () => {
  placing = addPick.kind !== '' ? addPick.kind : null
  titleEl.textContent = placing !== null ? `click to place: ${placing}` : ''
})

// --- Gizmo: mode + snap ---
const edit: { mode: 'translate' | 'rotate' | 'scale'; snap: boolean; step: number } = { mode: 'translate', snap: true, step: 0.5 }
const editFolder = pane.addFolder({ title: 'Gizmo' })
const modeBinding = editFolder
  .addBinding(edit, 'mode', { options: { 'move (T)': 'translate', 'rotate (R)': 'rotate', 'scale (S)': 'scale' } })
  .on('change', () => gizmo.setMode(edit.mode))
editFolder.addBinding(edit, 'snap').on('change', applySnap)
editFolder.addBinding(edit, 'step', { min: 0.1, max: 2, step: 0.1, label: 'grid' }).on('change', applySnap)

const setMode = (mode: 'translate' | 'rotate' | 'scale'): void => {
  edit.mode = mode
  gizmo.setMode(mode)
  modeBinding.refresh()
}

// --- Selected: transform + behavior/style/trigger + duplicate/delete ---
const sel = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
const prop = { behavior: 'static' as BehaviorKind, direction: '+Y', distance: 3, cycleS: 4, axis: { x: 0, y: 1, z: 0 }, style: '', trigger: 'none' as TriggerChoice }
const selFolder = pane.addFolder({ title: 'Selected' })
let selBlades: { dispose: () => void }[] = []

const styleOptions: Record<string, string> = { '(default)': '' }
for (const k of Object.keys(STYLE_PALETTE)) styleOptions[k] = k

const syncInspector = (): void => {
  if (selected === null) return
  const g = instanceGroups[selected]
  if (g === undefined) return
  sel.position = { x: r4(g.position.x), y: r4(g.position.y), z: r4(g.position.z) }
  const e = new THREE.Euler().setFromQuaternion(g.quaternion, 'XYZ')
  sel.rotation = { x: r4(THREE.MathUtils.radToDeg(e.x)), y: r4(THREE.MathUtils.radToDeg(e.y)), z: r4(THREE.MathUtils.radToDeg(e.z)) }
  sel.scale = { x: r4(g.scale.x), y: r4(g.scale.y), z: r4(g.scale.z) }
  selFolder.refresh()
}

const applyTransformEdit = (): void => {
  if (selected === null) return
  const g = instanceGroups[selected]
  if (g === undefined) return
  g.position.set(sel.position.x, sel.position.y, sel.position.z)
  const q = eulerToQuat(vec3(THREE.MathUtils.degToRad(sel.rotation.x), THREE.MathUtils.degToRad(sel.rotation.y), THREE.MathUtils.degToRad(sel.rotation.z)))
  g.quaternion.set(q.x, q.y, q.z, q.w)
  g.scale.set(sel.scale.x || 1e-3, sel.scale.y || 1e-3, sel.scale.z || 1e-3)
  writeBackSelected()
  scheduleRebuild()
  updateEndGhost()
}

const applyProps = (): void => {
  if (selected === null || doc === null) return
  const axis = prop.direction === 'custom' ? vec3(prop.axis.x, prop.axis.y, prop.axis.z) : { ...DIRS[prop.direction]! }
  const p: ItemProps = {
    behavior: prop.behavior,
    distance: prop.distance,
    periodMs: Math.max(50, prop.cycleS * 1000),
    axis,
    editable: doc.mode === 'prefab',
    style: prop.style,
    trigger: prop.trigger,
  }
  doc.setProps(selected, p)
  rebuildSelectedMeshes()
  scheduleRebuild()
  updateEndGhost()
}

const buildInspector = (): void => {
  for (const b of selBlades) b.dispose()
  selBlades = []
  if (selected === null || doc === null) return
  syncInspector()
  const p = doc.props(selected)
  prop.behavior = p.behavior
  prop.distance = p.distance
  prop.cycleS = r4(p.periodMs / 1000)
  prop.axis = { x: p.axis.x, y: p.axis.y, z: p.axis.z }
  prop.direction = dirNameOf(p.axis)
  prop.style = p.style
  prop.trigger = p.trigger

  const pos = { step: 0.1 }
  const rot = { step: 1 }
  const scl = { step: 0.05 }
  selBlades.push(selFolder.addBinding(sel, 'position', { label: 'position', x: pos, y: pos, z: pos }).on('change', applyTransformEdit))
  selBlades.push(selFolder.addBinding(sel, 'rotation', { label: 'rotation °', x: rot, y: rot, z: rot }).on('change', applyTransformEdit))
  selBlades.push(selFolder.addBinding(sel, 'scale', { label: 'scale', x: scl, y: scl, z: scl }).on('change', applyTransformEdit))

  if (p.editable) {
    selBlades.push(
      selFolder.addBinding(prop, 'style', { label: 'style', options: styleOptions }).on('change', applyProps),
      selFolder.addBinding(prop, 'trigger', { label: 'trigger', options: { none: 'none', checkpoint: 'checkpoint', goal: 'goal', hazard: 'hazard' } }).on('change', applyProps),
    )
  }

  selBlades.push(
    selFolder
      .addBinding(prop, 'behavior', { label: 'behavior', options: { static: 'static', move: 'move', rotate: 'rotate' } })
      .on('change', () => {
        applyProps()
        buildInspector() // show/hide the behavior params
      }),
  )
  if (prop.behavior === 'move' || prop.behavior === 'rotate') {
    selBlades.push(
      selFolder.addBinding(prop, 'direction', { label: 'direction', options: DIR_OPTIONS }).on('change', () => {
        if (prop.direction !== 'custom') {
          const v = DIRS[prop.direction]!
          prop.axis = { x: v.x, y: v.y, z: v.z }
        }
        applyProps()
        buildInspector() // reveal/hide the custom-axis field
      }),
    )
    if (prop.direction === 'custom') {
      const a = { step: 0.1 }
      selBlades.push(selFolder.addBinding(prop, 'axis', { label: 'axis', x: a, y: a, z: a }).on('change', applyProps))
    }
    if (prop.behavior === 'move') selBlades.push(selFolder.addBinding(prop, 'distance', { step: 0.1, label: 'travel (m)' }).on('change', applyProps))
    selBlades.push(selFolder.addBinding(prop, 'cycleS', { step: 0.1, label: 'cycle (s)' }).on('change', applyProps))
  }

  selBlades.push(selFolder.addButton({ title: 'Duplicate (Ctrl+D)' }).on('click', duplicateSelected))
  selBlades.push(selFolder.addButton({ title: 'Delete (Del)' }).on('click', deleteSelected))
}

// --- Play (walk the level with the real character + camera, exactly like the game) ---
const playFolder = pane.addFolder({ title: 'Play' })
playBinding = playFolder.addBinding(playState, 'on', { label: 'play (WASD/Space)' }).on('change', (ev) => {
  if (ev.value) startPlay()
  else stopPlay()
})

// --- Overlays ---
const show = { grid: true, markers: true }
const overlays = pane.addFolder({ title: 'Overlays' })
overlays.addBinding(show, 'grid').on('change', () => {
  grid.visible = show.grid
  axes.visible = show.grid
})
overlays.addBinding(show, 'markers', { label: 'markers/triggers' }).on('change', () => {
  markerGroup.visible = show.markers
})

// --- render loop ---
stage.start(() => {
  if (playing && controller !== null && loaded !== null) {
    // Interpolate clock-driven pieces + the character between the last two sim ticks (same
    // timeline as the game), then place the player camera (mouselook orbit) around the character.
    const alpha = Math.min(1, Math.max(0, (performance.now() - lastSimTickAt) / (1000 / TICK_RATE_HZ)))
    loaded.render(alpha)
    playView?.sync()
    ownPos = controller.renderPositions().get(PLAYER_ID) ?? ownPos
    charMesh.position.set(ownPos.x, ownPos.y, ownPos.z)
    const tx = ownPos.x
    const ty = ownPos.y + 1
    const tz = ownPos.z
    const cp = Math.cos(camPitch)
    stage.camera.position.set(tx + Math.sin(camYaw) * cp * camParams.distance, ty + Math.sin(camPitch) * camParams.distance + 0.5, tz + Math.cos(camYaw) * cp * camParams.distance)
    stage.camera.lookAt(tx, ty, tz)
  } else {
    controls.update()
  }
})

// --- boot ---
await initPhysics()
applySnap()
await refreshPrefabLibrary()
await enterMode('level')
