import { assetParamIds } from '@mp/components'
import { hydratePrefabs, instantiateLevel, type Level, type LoadedLevel } from '@mp/content'
import type { PhysicsWorld } from '@mp/physics'
import type { Registry } from '@mp/components'
import {
  addLevel,
  addLights,
  assetIdsIn,
  createAssetRuntime,
  type ContentLights,
  type CutoutMask,
  type GreyboxEnvironment,
  type LevelView,
  type PostFX,
  type THREE,
} from '@mp/render-three'

import { ASSET_DB, CLIP_SOURCE, PREFAB_SOURCE, assetUrlOf, materialOf } from './assets'

/**
 * A level, instantiated into a world and built into a scene (ADR 0065).
 *
 * Platform, not game: the level schema is what every client in a room has to agree on, because `baseIndex`
 * goes on the wire and only means anything if everybody instantiated the same JSON in the same order
 * (ADR 0021).
 *
 * Colliders and meshes together, deliberately. Two calls would let a level be walkable before it is visible,
 * and `addLevel` is synchronous, so the only place to wait for models is before it.
 */
export interface LevelHost {
  /** Colliders, markers, visuals, and the clock-driven pieces' poses. */
  readonly loaded: LoadedLevel
  /**
   * Advance the drawn level to `tickAlpha` between the last two sim ticks, and re-pose whatever moved.
   *
   * The pieces themselves advance in the fixed loop; this only interpolates their meshes, on the same
   * timeline as the player.
   */
  render: (tickAlpha: number) => void
  /** The surfaces currently wearing a see-through hole, for the AO prepass to skip (ADR 0055). */
  occluding: () => Iterable<THREE.Object3D>
  /** Hand the camera the surfaces it wants holed. */
  setOccluders: (handles: readonly number[]) => void
  /** The meshes drawing the node that owns a collider handle (ADR 0082). */
  meshesOf: (handle: number) => readonly THREE.Mesh[]
  /** A loaded material asset by id, or `null`. Everything a component parameter names is loaded (ADR 0082). */
  material: (assetId: string) => THREE.Material | null
  dispose: () => void
}

export interface LevelHostOptions {
  world: PhysicsWorld
  scene: THREE.Scene
  data: Level
  /** The game's component types — what validates and instantiates the level's nodes. */
  registry: Registry
  /** The camera's see-through mask, which the level's materials are compiled against. */
  cutout: CutoutMask
  /** The level owns its sun, and moving it rebakes the sky so the two cannot disagree (ADR 0048). */
  env: GreyboxEnvironment
  /** Ambient occlusion and bloom are level data, applied by the object that owns those passes (ADR 0048). */
  postfx: PostFX
}

/**
 * Instantiate and build, in that order, with the assets in between.
 *
 * Async only because of the assets: anything a level does not reference is never fetched, so a greybox level
 * costs one resolved promise.
 */
export const loadLevelInto = async ({
  world,
  scene,
  data,
  registry,
  cutout,
  env,
  postfx,
}: LevelHostOptions): Promise<LevelHost> => {
  /**
   * Resolve the prefabs this level references, before instantiating (ADR 0091). A level holds asset ids, not
   * copies, so the definitions have to be in place first; they are bundled, so this is synchronous and
   * `instantiateLevel` stays synchronous with it. A reference with no file resolves to nothing — the placement
   * draws nothing and the level still loads.
   */
  const { missing } = hydratePrefabs(data, PREFAB_SOURCE)
  if (missing.length > 0) console.warn(`level ${data.id}: no prefab file for ${missing.join(', ')}`)
  const loaded = instantiateLevel(world, data, registry, CLIP_SOURCE)

  // Assets first, then build: `addLevel` is synchronous, so a level is never briefly walkable with its models
  // still arriving. Marker pads are just their colour-coded box here — radius and overlay visualization
  // belongs to the viewer.
  const assets = createAssetRuntime({ db: ASSET_DB, urlOf: assetUrlOf, materialOf })
  // The Renderers' models and materials, and every asset any component parameter names (ADR 0082) — a pad's
  // active material is a game's to pick in the editor, and it has to be here when the game asks for it.
  await assets.load([...assetIdsIn(loaded.visuals), ...assetParamIds(loaded.nodes, registry)])
  const view: LevelView = addLevel(scene, loaded.visuals, { assets, cutout })
  const lights: ContentLights = addLights(scene, loaded.lights)

  env.applyEnvironment(loaded.config.environment)
  postfx.apply(loaded.config.environment?.postfx)

  return {
    loaded,
    render: (tickAlpha) => {
      loaded.render(tickAlpha)
      view.sync()
      lights.sync()
    },
    occluding: () => view.occluding(),
    setOccluders: (handles) => {
      view.setOccluders(handles)
    },
    meshesOf: (handle) => view.meshesOf(handle),
    material: (assetId) => assets.material(assetId),
    dispose: () => {
      view.dispose()
      lights.dispose()
    },
  }
}
