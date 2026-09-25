import type { Vec3 } from '@mp/core'
import { isBuiltinModel, scaleCollider, type LoadedLevel } from '@mp/content'
import { eulerToQuat, quat, vec3 } from '@mp/core'
import type { ModeDescriptor } from '@mp/mode'
import {
  colorForMarker,
  createGreyboxMaterial,
  createLight,
  geometryForBuiltin,
  geometryForCollider,
  lightAims,
  THREE,
  type AssetRuntime,
  type LightDesc,
} from '@mp/render-three'

import type { Doc } from './editorDoc'
import { gridQuads } from './surfaceGrid'

/**
 * The viewport's item meshes: one `THREE.Group` per node, the marker gizmos, and everything that redraws them
 * (ADR 0121).
 *
 * Its own module because it owns what nothing else may write — the groups, the two scene roots, the shadow
 * budget and the surface-cell toggle — and because its central invariant used to be unstatable. Meshes are
 * built at **world** dimensions inside a holder counter-scaled by the node's world scale (ADR 0090), which
 * only works if the group is already parented when it is asked; getting that wrong produced ADR 0120's
 * stretched cells, and the two halves of the rule sat a hundred and fifty lines apart among unrelated state.
 *
 * Everything the editor around it provides arrives through `ItemMeshHost`, all getters, so nothing here can
 * hold a stale document.
 */

/** What building the viewport needs from the editor around it. */
export interface ItemMeshHost {
  doc: () => Doc | null
  /** The instantiated level, for the markers a rule's node gets. */
  loaded: () => LoadedLevel | null
  /** Models and materials that have finished loading; a miss greyboxes rather than waits. */
  runtime: () => AssetRuntime | null
  /** The active game: its gizmo colours, and whether it describes a surface grid (ADR 0120). */
  mode: () => ModeDescriptor | undefined
  /** The active game's live setting values, which the surface grid is laid out from. */
  gameSettings: () => Readonly<Record<string, unknown>>
  selected: () => number | null
  /**
   * Is this node hidden in the viewport (ADR 0132)?
   *
   * Building no meshes is the whole implementation: nothing is drawn, and picking raycasts the meshes, so
   * it cannot be clicked either — which is the other half of what hiding has to mean. The group still
   * exists, so indices, the Hierarchy and every child's frame are untouched.
   */
  hidden: (i: number) => boolean
  /**
   * Run after a full rebuild: the preview poses, the gizmo's re-attach, the collaborators' hold boxes and the
   * bounds box. All of them read the groups that were just replaced, and none of them is this module's
   * business.
   */
  afterBuild: () => void
}

export interface ItemMeshes {
  /** One `Group` per editable item, `userData.index` → its document index. */
  root: THREE.Group
  /** The marker and trigger gizmos, on their own toggle. */
  markers: THREE.Group
  /** The group for a document index, or `undefined` past the end. */
  groupAt: (i: number) => THREE.Group | undefined
  /** Every group, in document order. */
  all: () => readonly THREE.Group[]
  /** A group's mesh holder — its own meshes, not its child items, which are siblings of it. */
  holderOf: (g: THREE.Group) => THREE.Group
  /** Rebuild every group from the document. */
  buildAll: () => void
  /** Rebuild one item's own meshes. */
  rebuildItem: (i: number) => void
  rebuildSelected: () => void
  /** Rebuild a node and everything under it — what a size change needs (ADR 0090). */
  rebuildSubtree: (i: number) => void
  /** Re-derive the marker gizmos from the instantiated level. */
  buildMarkers: () => void
  /** Drop them, for a level that failed to instantiate. */
  clearMarkers: () => void
  /** Remove every child of an object, freeing what these meshes made for it and nothing shared (ADR 0167). */
  dispose: (o: THREE.Object3D) => void
  /** Whether the surface-cell preview is on, or `null` when the game describes none (ADR 0120). */
  cells: () => boolean | null
  setCells: (on: boolean) => void
  /**
   * A runtime material changed in place (ADR 0157): the fade copies made of it take the new values, keeping the
   * opacity the preview set. Everything else draws the original, which has them already.
   */
  followMaterial: (original: THREE.Material) => void
}

/** A fadeable item's own copy of a material, the opacity it started at, and the original it was copied from. */
interface Fading {
  mat: THREE.Material
  base: number
  from: THREE.Material
}

export const createItemMeshes = (host: ItemMeshHost): ItemMeshes => {
  const instanceRoot = new THREE.Group() // one Group per editable item (userData.index → data)
  const markerGroup = new THREE.Group()
  let instanceGroups: THREE.Group[] = []

  /**
   * What these meshes made, and so may free (ADR 0167): a shape built for one node, its grey or faded material, a
   * gizmo's. The rest is shared — the runtime's materials, each model's shape and materials (a placed model is a
   * clone that keeps its original's), the key cells' — and freeing it made the next frame rebuild its shaders and
   * upload its shape again, for every object using it: what a rebuild mostly cost after the tree walk.
   */
  const own = new WeakSet<object>()
  const mine = <T extends object>(made: T): T => {
    own.add(made)
    return made
  }
  /**
   * Freed two frames late, once the rebuild has drawn: a material freed before the one replacing it has drawn
   * takes its shader with it when it was the last to use it — the whole grey world on a full rebuild.
   */
  let trash: { dispose: () => void }[] = []
  let sweeping = false
  const later = (fn: () => void): void => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fn)
    else setTimeout(fn, 16)
  }
  const throwAway = (x: { dispose: () => void }): void => {
    trash.push(x)
    if (sweeping) return
    sweeping = true
    later(() =>
      later(() => {
        sweeping = false
        const now = trash
        trash = []
        for (const t of now) t.dispose()
      }),
    )
  }

  const disposeMeshes = (g: THREE.Object3D): void => {
    for (const child of [...g.children]) {
      g.remove(child)
      child.traverse((o) => {
        // A light made for its node, with its shadow map; an instanced mesh's per-instance buffer — never its shared shape.
        if (o instanceof THREE.Light || o instanceof THREE.InstancedMesh) throwAway(o)
        if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments || o instanceof THREE.Line) {
          if (own.has(o.geometry)) throwAway(o.geometry)
          for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (own.has(m)) throwAway(m)
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
      mine(new THREE.CylinderGeometry(1, 1, 0.05, 32)),
      mine(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.3, depthWrite: false, toneMapped: false })),
    )
    const pillar = new THREE.Line(
      mine(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1.5, 0)])),
      mine(new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false, toneMapped: false })),
    )
    g.add(disc, pillar)
    g.position.set(position.x, position.y + 0.03, position.z)
    return g
  }

  const buildMarkers = (): void => {
    disposeMeshes(markerGroup)
    const level = host.loaded()
    if (level === null) return
    // Spawn is the engine's: every game starts a player somewhere, and `Spawn` is an engine component.
    for (const m of level.markers) if (m.kind === 'spawn') markerGroup.add(markerGizmo(m.position, colorForMarker('spawn')))
    /**
     * A gizmo per gameplay rule, on the node that owns the collider you would touch — coloured by **the game's**
     * table (ADR 0052), so a new game's rules get markers without touching this file.
     *
     * This was `RULE_KINDS` from `@mp/components`, which covered exactly parkour's four because they were the
     * only rules that existed. The editor no longer names a rule anywhere.
     */
    const gizmos = host.mode()?.gizmos
    if (gizmos !== undefined)
      for (const n of level.nodes)
        for (const c of n.components) {
          const color = gizmos[c.type]
          if (color !== undefined) markerGroup.add(markerGizmo(n.position, color))
        }
  }

  // --- editable item meshes ---
  /**
   * One Group per item, **parented to its own parent's Group**, so Three composes the transform chain and a
   * gizmo on a child reads and writes that child's *local* pose — which is exactly what the document stores.
   *
   * Each item group holds a dedicated mesh holder rather than its meshes directly: rebuilding one item's
   * meshes must not take its child items with it, and `disposeMeshes` cannot tell a mesh it added from a
   * child group it did not.
   */
  const meshHolderOf = (g: THREE.Group): THREE.Group => g.userData.meshes as THREE.Group

  /**
   * Shadow cap for the authored viewport (ADR 0047). Three renders forward, so each caster is an extra scene
   * render per frame and a point light is six of them. Reset per rebuild, and counted in document order so the
   * same lights win each time rather than flickering between rebuilds.
   */
  const EDITOR_SHADOW_CAP = 4
  let editorShadowCasters = 0

  /**
   * A pickable wireframe for a light. Chrome, not content: it never casts, never writes depth, and is not
   * tone-mapped, so it reads the same against a bright sky as a dark one.
   *
   * Shape says the kind at a glance — a sphere for the omnidirectional ones, a cone down -Z for a spot, a
   * line down -Z for a directional. Tinted with the light's own colour so a wall of them is still legible.
   */
  const lightGizmo = (light: LightDesc): THREE.Object3D => {
    const color = new THREE.Color().setStyle(light.color, THREE.SRGBColorSpace)
    const material = mine(new THREE.MeshBasicMaterial({ color, wireframe: true, depthWrite: false, toneMapped: false }))
    const group = new THREE.Group()
    if (light.kind === 'spot') {
      const h = 1.2
      const r = Math.tan(THREE.MathUtils.degToRad(light.angleDeg)) * h
      const cone = new THREE.Mesh(mine(new THREE.ConeGeometry(r, h, 12, 1, true)), material)
      // ConeGeometry points up +Y with its apex at the top; put the apex on the node and lay it down -Z.
      cone.rotation.x = -Math.PI / 2
      cone.position.z = -h / 2
      group.add(cone)
    } else {
      group.add(new THREE.Mesh(mine(new THREE.SphereGeometry(0.22, 10, 6)), material))
    }
    if (light.kind === 'directional') {
      const line = mine(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1.6)]))
      group.add(new THREE.Line(line, mine(new THREE.LineBasicMaterial({ color, toneMapped: false }))))
    }
    return group
  }

  const buildItemMeshes = (g: THREE.Group, i: number): void => {
    const open = host.doc()
    if (open === null) return
    const holder = meshHolderOf(g)
    /**
     * Drawn at final size (ADR 0090). The group carries the node's scale for its children and the gizmo; the
     * holder undoes it, and every shape here is built from the *world* dimensions — as the game builds them
     * from the baked collider. So a rounded edge is computed on the real size instead of being stretched with
     * the scale, and a built-in shape is the unit shape times the scale. A model file gets the scale back.
     */
    g.updateWorldMatrix(true, false)
    const ws = g.getWorldScale(new THREE.Vector3())
    const inv = (v: number): number => (Math.abs(v) < 1e-6 ? 1 : 1 / v)
    holder.scale.set(inv(ws.x), inv(ws.y), inv(ws.z))
    const worldScale = vec3(ws.x, ws.y, ws.z)
    /**
     * A node a sequence can fade gets its **own** material copies, transparent from the start, as the game's
     * level view does (ADR 0141): the originals are shared by every piece using them, so fading one would fade
     * them all. The preview sets their opacity; the holder keeps the list.
     */
    const fades = open.fadesAt(i)
    const fading: Fading[] = []
    const ownCopy = (m: THREE.Material): THREE.Material => {
      const copy = mine(m.clone())
      copy.transparent = true
      fading.push({ mat: copy, base: m.opacity, from: m })
      return copy
    }
    holder.userData.fading = fading
    for (const spec of open.meshSpecs(i)) {
      // The same precedence the game's level view uses, so the editor is never showing a different scene:
      // a model replaces the greybox shape, a material replaces the greybox style, and either falling
      // through leaves the piece as its collider, greyboxed when no material is assigned.
      const builtin = isBuiltinModel(spec.model) ? spec.model : null
      const model = spec.model !== undefined && builtin === null ? (host.runtime()?.model(spec.model) ?? null) : null
      const material = spec.material !== undefined ? (host.runtime()?.material(spec.material) ?? null) : null
      let object: THREE.Object3D
      if (model !== null) {
        if (material !== null) model.traverse((o) => void (o instanceof THREE.Mesh && (o.material = material)))
        object = model
      } else {
        const geometry = mine(builtin !== null ? geometryForBuiltin(builtin, worldScale) : geometryForCollider(scaleCollider(spec.collider, worldScale)))
        object = new THREE.Mesh(geometry, material ?? mine(createGreyboxMaterial()))
      }
      const p = spec.transform.position
      applyTransform(object, vec3(p.x * ws.x, p.y * ws.y, p.z * ws.z), spec.transform.rotation, spec.transform.scale)
      if (model !== null) object.scale.multiply(ws)
      object.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          if (fades) o.material = Array.isArray(o.material) ? o.material.map(ownCopy) : ownCopy(o.material)
          o.castShadow = true
          o.receiveShadow = true
        }
      })
      holder.add(object)
    }

    /**
     * The node's light, if it has one (ADR 0047). Two objects, both parented into the node's own group so its
     * transform places and aims them with no extra bookkeeping:
     *
     * - the real `THREE.Light`, so the viewport shows what the level will actually look like
     * - a wireframe **gizmo**, because a light node has no `Renderer` and no `Collider`, so without one there is
     *   nothing under the cursor to click. It sits inside the group that carries `userData.index`, so the
     *   existing pick walk finds it for free.
     */
    const light = open.lightSpec(i)
    if (light !== undefined) {
      const casts = light.castShadow && light.kind !== 'ambient' && editorShadowCasters < EDITOR_SHADOW_CAP
      if (casts) editorShadowCasters += 1
      const object = createLight(light, casts)
      holder.add(object)
      if (lightAims(light.kind)) {
        // Aimed down the group's -Z, which is the node's forward. Three needs the target in the graph.
        const target = new THREE.Object3D()
        target.position.set(0, 0, -1)
        holder.add(target)
        ;(object as THREE.SpotLight | THREE.DirectionalLight).target = target
      }
      holder.add(lightGizmo(light))
    }

    buildSurfaceCells(holder, i, worldScale)
  }

  /**
   * Whether the key/cell preview is on (ADR 0120). `null` when the open level's game describes no grid, which
   * is what hides the viewport's Keys toggle rather than leaving a dead one.
   */
  let showCells = true
  const cellsToggle = (): boolean | null => (host.mode()?.surfaceGrid === undefined ? null : showCells)

  /** One flat square per cell, shared by every board: the geometry and the material are built once. */
  const CELL_GEOMETRY = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)
  const CELL_MATERIAL = new THREE.MeshBasicMaterial({
    color: 0x6fa8ff,
    transparent: true,
    opacity: 0.38,
    // Written depth would z-fight the face it lies on, and it is a hint rather than a surface.
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
    /**
     * The bias that keeps a cell off the face it is drawn on, which a lift in metres cannot.
     *
     * The camera is near 0.1 / far 1000 (`stage.ts`), and that ratio spends nearly all of the depth buffer's
     * precision close in — so `LIFT`'s two millimetres have no bits left to win with fifty metres out, and the
     * cells flickered against the platform at any distance. This biases in **depth-buffer** units and is
     * slope-scaled by the driver, so it holds at every distance and every viewing angle.
     *
     * Not `depthTest: false`, which is what the marker pillars use: a whole floor of cells drawing through a
     * wall in front of it is worse than the flicker was.
     */
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  })

  /**
   * Draw the cells the active game would generate on this node's surface, inside its mesh holder (ADR 0120).
   *
   * Asked of the **game**, which decides from the node's own components whether this is one of its surfaces —
   * the editor never learns what a `Keyboard` is. Built-in box and rounded box only: for those the collider is
   * the unit shape and the scale is the size (ADR 0090), which is the only case where a node's scale *is* the
   * surface. A sphere has no face, and an authored collider could sit anywhere on the node.
   *
   * Nothing here runs on a move or a turn — the holder is a child of the node's group, so three composes that.
   * A size change rebuilds the item's meshes, and this rides along, so a face pull re-lays the cells live.
   */
  const buildSurfaceCells = (holder: THREE.Group, i: number, worldSize: Vec3): void => {
    const open = host.doc()
    const grid = host.mode()?.surfaceGrid
    if (open === null || grid === undefined || !showCells) return
    const builtin = open.builtinOf(i)
    if (builtin !== 'builtin:box' && builtin !== 'builtin:rounded-box') return
    const described = grid(open.components(i), worldSize, host.gameSettings())
    if (described === null) return
    const quads = gridQuads(described, worldSize)
    if (quads.length === 0) return
    const mesh = new THREE.InstancedMesh(CELL_GEOMETRY, CELL_MATERIAL, quads.length)
    /**
     * **Not pickable.** Picking raycasts the mesh holder, so without this the quads would swallow clicks — and
     * worse, hand `faceUnder` a flat upward normal and break the face tool on every board (ADR 0119).
     */
    mesh.raycast = () => {}
    mesh.castShadow = false
    mesh.receiveShadow = false
    const m = new THREE.Matrix4()
    const one = new THREE.Quaternion()
    quads.forEach((q, n) => {
      m.compose(new THREE.Vector3(q.x, q.y, q.z), one, new THREE.Vector3(q.side, 1, q.side))
      mesh.setMatrixAt(n, m)
    })
    mesh.instanceMatrix.needsUpdate = true
    // Against the instances, not the unit quad at the mesh's origin, or a board is culled from most angles.
    mesh.computeBoundingSphere()
    holder.add(mesh)
  }

  const buildItems = (): void => {
    disposeMeshes(instanceRoot)
    instanceGroups = []
    // Counted fresh each rebuild, in document order, so the same lights keep their shadows instead of the cap
    // handing them to whichever node happened to rebuild first.
    editorShadowCasters = 0
    const open = host.doc()
    if (open === null) {
      host.afterBuild()
      return
    }
    // Depth-first order, so a parent's group always exists before its children ask for it. One walk of the
    // tree for the whole pass, not one per object asked about (ADR 0167).
    open.reading(() => {
      for (let i = 0; i < open.count(); i++) {
        const g = new THREE.Group()
        const t = open.transformOf(i)
        applyTransform(g, t.position, t.rotation, t.scale)
        g.userData.index = i
        const holder = new THREE.Group()
        g.userData.meshes = holder
        g.add(holder)
        /**
         * A switched-off node draws nothing (ADR 0099) — Kodjo's call, the same as Unity's scene view.
         *
         * **No meshes rather than an invisible group.** Three does not skip invisible objects when raycasting
         * (`Raycaster.js`), so `visible = false` would leave it clickable in the viewport: you would select
         * something you cannot see. Building nothing is also what the loader does, so the two agree.
         *
         * The group itself still exists, so document indices, the Hierarchy's selection and the gizmo all keep
         * working — you can still move a disabled object, you just cannot see it.
         */
        /**
         * **Parented before its meshes are built**, because `buildItemMeshes` asks for the group's *world* scale.
         * Built the other way round it got the node's own scale instead, leaving the mesh holder's real world
         * scale equal to the parent chain's — invisible for the meshes, which are built at `ws` and then
         * multiplied by exactly that leftover, but not for anything placed at an absolute size. The game's
         * surface cells (ADR 0120) are, and came out scaled by the parent and laid on the wrong cell count.
         *
         * It also made `buildItems` and `rebuildItemMeshes` disagree: the latter runs on a group that is already
         * in the scene, so it always saw the true world scale.
         */
        const parent = open.parentOf(i)
        ;(parent === null ? instanceRoot : (instanceGroups[parent] ?? instanceRoot)).add(g)
        if (open.nodeEnabled(i) && !open.disabledByAncestor(i) && !host.hidden(i)) buildItemMeshes(g, i)
        instanceGroups[i] = g
      }
    })
    // Authored transforms are only where *static* items sit. An animated one belongs at its track's pose for
    // the current playhead — which at 0 is where the game starts it, so the two now agree (ADR 0029).
    host.afterBuild()
  }

  const rebuildItemMeshes = (index: number): void => {
    const g = instanceGroups[index]
    if (g === undefined) return
    disposeMeshes(meshHolderOf(g)) // only this item's own meshes; its child items are siblings of the holder
    if (!host.hidden(index)) buildItemMeshes(g, index)
  }

  const rebuildSelectedMeshes = (): void => {
    const i = host.selected()
    if (i === null) return
    rebuildItemMeshes(i)
  }

  /**
   * Meshes are built from the world scale (ADR 0090), so a scale change on a node redraws it and everything
   * under it. Depth-first order makes the subtree the run of deeper indices right after the node.
   */
  const rebuildSubtreeMeshes = (i: number): void => {
    const open = host.doc()
    if (open === null) return
    open.reading(() => {
      const depth = open.depthOf(i)
      for (let j = i; j < open.count() && (j === i || open.depthOf(j) > depth); j++) rebuildItemMeshes(j)
    })
  }

  return {
    root: instanceRoot,
    markers: markerGroup,
    groupAt: (i) => instanceGroups[i],
    all: () => instanceGroups,
    holderOf: meshHolderOf,
    buildAll: buildItems,
    rebuildItem: rebuildItemMeshes,
    rebuildSelected: rebuildSelectedMeshes,
    rebuildSubtree: rebuildSubtreeMeshes,
    buildMarkers,
    clearMarkers: () => disposeMeshes(markerGroup),
    dispose: disposeMeshes,
    cells: cellsToggle,
    setCells: (on) => void (showCells = on),
    followMaterial: (original) => {
      for (const g of instanceGroups) {
        const copies = (g.userData.meshes as THREE.Object3D | undefined)?.userData.fading as Fading[] | undefined
        for (const f of copies ?? []) {
          if (f.from !== original) continue
          const opacity = f.mat.opacity
          f.mat.copy(original)
          f.mat.transparent = true
          f.mat.opacity = opacity
          f.mat.needsUpdate = true
        }
      }
    },
  }
}
