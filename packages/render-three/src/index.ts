/**
 * @mp/render-three — Three.js world renderer on WebGL2 (SEED §2). Browser-only.
 * Re-exports THREE so games share one pinned Three.js version via the stack.
 */

export const RENDER_THREE_VERSION = '0.0.0' as const

export * as THREE from 'three'
// Orbit + transform gizmo (viewer/editor tools) — re-exported so consumers share the pinned three.
export { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
export { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
export type { ThreeStage, ThreeStageOptions } from './stage'
export { createThreeStage, OVERLAY_LAYER } from './stage'
// Text in the world (ADR 0189): one drawing for the Text component, nametags and signs; a label is lines of it facing
// the camera (ADR 0082).
export type { FacingOptions, TextStyle, WorldText } from './text'
export { createText, DEFAULT_TEXT_STYLE, faceCamera } from './text'
export type { LevelTexts } from './levelText'
export { addTexts, textStyleOf } from './levelText'
export type { LabelLine, WorldLabelOptions } from './worldLabel'
export { disposeWorldLabel, stackLines, worldLabel } from './worldLabel'

// Polished greybox pipeline (content pipeline C3) — shared by the game and the viewer.
export { BEVEL_RADIUS, BEVEL_SEGMENTS, MARKER_COLORS, bevelFor, colorForMarker, createGreyboxMaterial, geometryForBuiltin, geometryForCollider, outlineGeometryForCollider } from './materials'
export type { GizmoKind } from './materials'
export type { GreyboxEnvironment, GreyboxEnvironmentOptions } from './environment'
export { applyGreyboxEnvironment } from './environment'
// The sky (ADR 0046): a designed vertical gradient baked to a cubemap that is both background and IBL source.
export type { ProceduralSky, SkyParams, SunAngles } from './sky'
export { createProceduralSky, DEFAULT_SKY_PARAMS, skyUniformValues, sunDirection } from './sky'
export type { PostFX, PostFXOptions } from './postfx'
export { DEFAULT_POSTFX, createPostFX } from './postfx'
// The editor's selection outline: every colour in one pass, drawn whatever is in front.
export type { OutlineGroup } from './selectionOutline'
export { SelectionOutlinePass } from './selectionOutline'
// A shape's edges, not its triangles, for the editor's selection.
export type { RoundedBoxInfo } from './shapeEdges'
export { EDGE_ANGLE_DEG, shapeEdges } from './shapeEdges'
export type { LevelView, LevelViewOptions, MarkersView } from './levelView'
// The see-through hole (ADR 0055): level surfaces dither away between the eye and the character.
export type { CutoutMask, CutoutState } from './cutout'
export { createCutoutMask, cutoutCoverage, injectCutout } from './cutout'
// Content lights (ADR 0047): the loader says what lights exist, this realizes them. The sun is not one.
export type { ContentLights, ContentLightsOptions, LightDesc } from './lights'
export { addLights, createLight, lightAims, shadowPassesFor } from './lights'
// Assets: shaders + materials (parameterising Three, not an engine) and the preload runtime.
export { BUILTIN_SHADERS, compileMaterial, defaultParams, registerShader, shaderDef } from './shaders'
export type { ParamReader, ShaderDef, ShaderParam, ShaderParamKind } from './shaders'
export { assetIdsIn, createAssetRuntime } from './assetRuntime'
// Asset thumbnails: render once offscreen, cache the image (the caller owns the cache).
export { createThumbnailer, fitDistance } from './thumbnails'
export type { Thumbnailer, ThumbnailerOptions } from './thumbnails'
export type { AssetRuntime, AssetRuntimeOptions } from './assetRuntime'
export { addLevel, addMarkers } from './levelView'

// Blocky character rig (10 parts, no skinning) — shape and motion come from @mp/character.
export type { CharacterRig, CharacterRigOptions, RigStyle, LooseParts } from './characterRig'
export { createCharacterRig, createLooseParts } from './characterRig'
