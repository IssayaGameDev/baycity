/**
 * @mp/camera — the third-person orbit camera (ADR 0020, amended by ADR 0055).
 *
 * Boom, zoom, occlusion, the see-through hole, the landing dip, and whether the player's own rig is inside
 * the lens. Browser-side view code: it takes a Three camera and drives it. No DOM (the host owns pointer
 * lock, wheel and touch) and no physics dependency (the two queries are injected), which is what keeps the
 * occlusion decision testable without a world.
 */

export const CAMERA_VERSION = '0.0.0' as const

export type { CameraParams, OrbitCamera, OrbitCameraOptions, Placement, Tunable } from './orbit'
export { CAMERA_TUNABLES, DEFAULT_CAMERA_PARAMS, chase, createOrbitCamera } from './orbit'
export type { Hit, Occlusion, OcclusionQueries, OcclusionView } from './occlusion'
export { occlusionFor } from './occlusion'
