import { trackDuration, type Easing, type Keyframe, type Pose } from '@mp/content'
import { vec3, type Vec3 } from '@mp/core'

/**
 * Editing a keyframe track: every mutation the timeline strip performs, as a pure function (ADR 0029).
 *
 * Separate from the panel that draws it for the usual reason — dragging a key past its neighbour, snapping
 * to the grid, deleting the key a segment's easing belongs to are all rules worth testing without a DOM.
 * The panel is then only hit-testing and pixels.
 *
 * Every function returns a **new** array. The doc replaces the track wholesale, so an edit is one
 * assignment rather than a mutation somebody else might be mid-read of.
 */

export const EASINGS: readonly Easing[] = ['linear', 'in', 'out', 'inOut', 'step']

/**
 * Cardinal axes, offered so the common presets need no vector typing. Moved here from the Inspector with
 * the behavior form it used to drive: the only thing that asks "which way" now is a preset.
 */
export const DIRS: Record<string, Vec3> = {
  '+X': vec3(1, 0, 0),
  '-X': vec3(-1, 0, 0),
  '+Y': vec3(0, 1, 0),
  '-Y': vec3(0, -1, 0),
  '+Z': vec3(0, 0, 1),
  '-Z': vec3(0, 0, -1),
}

/** Which cardinal name an axis matches, or `custom` when it is at an angle. */
export const dirNameOf = (a: Vec3): string => {
  const len = Math.hypot(a.x, a.y, a.z) || 1
  const n = vec3(a.x / len, a.y / len, a.z / len)
  for (const [k, v] of Object.entries(DIRS)) if (Math.abs(n.x - v.x) < 1e-3 && Math.abs(n.y - v.y) < 1e-3 && Math.abs(n.z - v.z) < 1e-3) return k
  return 'custom'
}

/** Time order, which is the only order the timeline ever draws or samples in. */
export const sortedKeys = (keys: readonly Keyframe[]): Keyframe[] => [...keys].sort((a, b) => a.t - b.t)

/**
 * The key nearest `t` within `withinMs`, or `-1`. Indexes into the **sorted** array, which is what the
 * timeline draws, so a hit test and a mutation agree on which key was clicked.
 */
export const keyNear = (keys: readonly Keyframe[], t: number, withinMs: number): number => {
  const sorted = sortedKeys(keys)
  let best = -1
  let bestDist = withinMs
  for (let i = 0; i < sorted.length; i++) {
    const d = Math.abs(sorted[i]!.t - t)
    if (d <= bestDist) {
      bestDist = d
      best = i
    }
  }
  return best
}

/** Round to a grid, for dragging keys onto round numbers. A grid of 0 (or less) snaps to nothing. */
export const snapTime = (t: number, gridMs: number): number => (gridMs > 0 ? Math.round(t / gridMs) * gridMs : t)

/**
 * Insert a key, or **replace** the one already at that time.
 *
 * Replacing is what makes the "+ key" button idempotent: pressing it twice at one playhead position sets the
 * pose twice rather than stacking two keys that then divide by zero. A deliberate instant jump still needs
 * two keys at one time, which `nudge` below is for — an accident and an intention should not share a gesture.
 */
export const putKey = (keys: readonly Keyframe[], key: Keyframe): Keyframe[] => {
  const kept = keys.filter((k) => k.t !== key.t)
  // The easing of the key we are replacing is worth keeping: re-posing a key should not silently relinearise
  // the segment leaving it.
  const previous = keys.find((k) => k.t === key.t)
  const merged: Keyframe = previous?.easing !== undefined && key.easing === undefined ? { ...key, easing: previous.easing } : key
  return sortedKeys([...kept, merged])
}

/**
 * Move a key to a new time, clamped at zero. Returns the new array and where the key ended up, because a
 * drag past a neighbour changes its index and the caller is holding one.
 */
export const moveKey = (keys: readonly Keyframe[], index: number, t: number): { keys: Keyframe[]; index: number } => {
  const sorted = sortedKeys(keys)
  const key = sorted[index]
  if (key === undefined) return { keys: sorted, index }
  const moved: Keyframe = { ...key, t: Math.max(0, t) }
  const rest = sorted.filter((_, i) => i !== index)
  const next = sortedKeys([...rest, moved])
  return { keys: next, index: next.indexOf(moved) }
}

/**
 * Remove a key. The first key is removable like any other: a track whose first key is at 500ms simply holds
 * that pose until then, which is a legitimate thing to author, and refusing would make the timeline lie
 * about what a diamond is.
 */
export const deleteKey = (keys: readonly Keyframe[], index: number): Keyframe[] => {
  const sorted = sortedKeys(keys)
  return sorted.filter((_, i) => i !== index)
}

/** Set the easing of the segment *leaving* a key. */
export const setEasing = (keys: readonly Keyframe[], index: number, easing: Easing): Keyframe[] => {
  const sorted = sortedKeys(keys)
  return sorted.map((k, i) => (i === index ? { ...k, easing } : k))
}

/**
 * Write a pose into a key, replacing whichever channels the pose supplies.
 *
 * Channels are set, not merged per component: keying an object writes where it *is*, and a half-written key
 * would put it somewhere it never was.
 */
export const setKeyPose = (keys: readonly Keyframe[], index: number, pose: Partial<Pose>): Keyframe[] => {
  const sorted = sortedKeys(keys)
  return sorted.map((k, i) =>
    i === index
      ? {
          ...k,
          ...(pose.position !== undefined ? { position: pose.position } : {}),
          ...(pose.rotation !== undefined ? { rotation: pose.rotation } : {}),
        }
      : k,
  )
}

/**
 * Add a second key one millisecond after an existing one, holding its pose — the gesture for an instant
 * jump, since a step needs somewhere to step *from*.
 */
export const nudgeKey = (keys: readonly Keyframe[], index: number): Keyframe[] => {
  const sorted = sortedKeys(keys)
  const key = sorted[index]
  if (key === undefined) return sorted
  return sortedKeys([...sorted, { ...key, t: key.t + 1 }])
}

/**
 * A fresh track from one pose: a single key at 0.
 *
 * One key rather than two, because a two-key track invents a duration nobody chose. One key is a held pose,
 * which is honest — the loader treats it as static — and the second key is the author's first real decision.
 */
export const oneKeyAt = (pose: Pose): Keyframe[] => [{ t: 0, position: pose.position, rotation: pose.rotation, easing: 'inOut' }]

/** What a row in the timeline needs to draw one key. */
export interface KeyRow {
  index: number
  t: number
  /** Fraction of the track's duration, for placing the diamond. 0 when the track has no length yet. */
  at: number
  easing: Easing
  /** True when another key shares this time — an instant jump, worth drawing differently. */
  stacked: boolean
  hasPosition: boolean
  hasRotation: boolean
}

/** The track as rows, in time order, ready to draw. */
export const keyRows = (keys: readonly Keyframe[]): KeyRow[] => {
  const sorted = sortedKeys(keys)
  const duration = trackDuration(sorted)
  return sorted.map((k, i) => ({
    index: i,
    t: k.t,
    at: duration > 0 ? k.t / duration : 0,
    easing: k.easing ?? 'linear',
    stacked: sorted.some((other, j) => j !== i && other.t === k.t),
    hasPosition: k.position !== undefined,
    hasRotation: k.rotation !== undefined,
  }))
}

/**
 * The polyline the viewport draws for a track: the position of every key that has one, in time order.
 *
 * Only the keys, not a sampled curve. Easing changes *when* the object is between two keys and never
 * *where*, since every segment is a straight line in space — so the polyline is exact, not an approximation,
 * and it is the same handles a person drags.
 */
export const pathPoints = (keys: readonly Keyframe[]): { t: number; position: ReturnType<typeof vec3> }[] =>
  sortedKeys(keys)
    .filter((k) => k.position !== undefined)
    .map((k) => ({ t: k.t, position: k.position! }))
