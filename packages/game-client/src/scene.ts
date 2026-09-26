import {
  OVERLAY_LAYER,
  applyGreyboxEnvironment,
  createPostFX,
  createThreeStage,
  type GreyboxEnvironment,
  type PostFX,
  type ThreeStage,
  type THREE,
} from '@mp/render-three'


/**
 * The Three stage and everything that dresses it: the greybox pipeline, the sky, post-FX, and the render step
 * that draws nametags after post-FX.
 *
 * `occluding` is a callback rather than a value because the level does not exist yet — it arrives with the
 * first snapshot — and the AO pass has to ask fresh every frame which surfaces are currently wearing a hole
 * (ADR 0055).
 */
export interface Scene {
  stage: ThreeStage
  env: GreyboxEnvironment
  postfx: PostFX
}

export const createScene = async (canvas: HTMLCanvasElement, occluding: () => Iterable<THREE.Object3D>): Promise<Scene> => {
  const stage = createThreeStage({ canvas, cameraPosition: [0, 6, 10], lookAt: [0, 1, 0] })
  // Polished greybox pipeline (content pipeline C3): IBL + ACES + soft shadows, with GTAO +
  // SMAA post-FX. Level meshes, materials (the "High-contrast dev" palette) and markers are
  // realized by the shared @mp/render-three renderer — same code the viewer uses.
  // `shadowRadius` is deliberately not passed: the renderer's own default is the one number, and the editor
  // and viewer overrode it to 40 while this said 30 — so the tools showed shadows the game did not have.
  const env = applyGreyboxEnvironment(stage.renderer, stage.scene, { sunIntensity: 2.4 })
  // No look values here any more: ambient occlusion and bloom are level data (`config.environment.postfx`),
  // applied with the lighting they are tuned against. What stays is the one thing a level cannot know.
  const postfx = createPostFX(stage.renderer, stage.scene, stage.camera, {
    /**
     * A surface wearing a hole must be absent from the AO prepass, or the character seen through it comes out
     * shaded by occlusion cast by something the player cannot see — which was the one artifact that survived
     * every other fix, and was measured by toggling AO rather than guessed at (ADR 0055).
     */
    aoIgnores: occluding,
  })

  // Nametags live on an overlay layer drawn AFTER post-FX. GTAO renders the scene into its
  // own depth/normal buffer to compute occlusion; a sprite left in the world pipeline shows
  // up there as a hard dark AO ghost (the tilted black quad). Keeping the sprites on a layer
  // the world camera never sees during post-FX excludes them from GTAO entirely; we then draw
  // them on top, free of AO and tone mapping (`OVERLAY_LAYER`, declared by the renderer that draws it).
  stage.setRenderStep(() => {
    postfx.render() // world + AO + bloom to screen (camera sees layer 0 only)
    const r = stage.renderer
    r.setRenderTarget(null)
    // A solid-colour scene.background forces a buffer clear on render() even with
    // autoClear off — which would wipe the composer output. Null it for the overlay only.
    const bg = stage.scene.background
    stage.scene.background = null
    r.autoClear = false
    stage.camera.layers.set(OVERLAY_LAYER) // render only the overlay (nametags), on top
    r.clearDepth()
    r.render(stage.scene, stage.camera)
    stage.camera.layers.set(0) // restore the world layer for the next frame
    stage.scene.background = bg
    r.autoClear = true
  })

  return { stage, env, postfx }
}
