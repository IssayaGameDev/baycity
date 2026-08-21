import { trackDuration, type Easing, type Keyframe, type Pose } from '@mp/content'
import { vec3, type Vec3 } from '@mp/core'

/**
 * Editing a keyframe track: every mutation the timeline performs, as a pure function (ADR 0029, ADR 0051).
 *
 * Separate from the panel that draws it for the usual reason — dragging a key past its neighbour, snapping to
 * the grid, splitting a two-channel key because only one channel was dragged are all rules worth testing
 * without a DOM. The panel is then only hit-testing and pixels.
 *
 * Every function returns a **new** array. The doc replaces the track wholesale, so an edit is one assignment
 * rather than a mutation somebody else might be mid-read of.
 *
 * **Indices address the sorted array**, which is what the panel draws, so a hit test and a mutation agree on
 * which key was clicked. Anything that moves a key in time therefore returns where it ended up.
 */

export const EASINGS: readonly Easing[] = ['linear', 'in', 'out', 'inOut', 'step']

/**
 * The two things a key can carry. A row in the timeline per channel (ADR 0051), because a key that holds both
 * used to be one diamond and there was no way to grab half of it.
 *
 * Not per *axis*: a key holds a whole `Vec3`, so an x-only row would be drawing something the schema cannot
 * represent. Space is edited in the viewport with the gizmo, which is where per-axis belongs.
 */
export type Channel = 'position' | 'rotation'
export const CHANNELS: readonly Channel[] = ['position', 'rotation']

/**
 * Cardinal axes, offered so the common presets need no vector typing. Moved here from the Inspector with the
 * behavior form it used to drive: the only thing that asks "which way" now is a preset.
 */
export const DIRS: Record<string, Vec3> = {
  '+X': vec3(1, 0, 0),
  '-X': vec3(-1, 0, 0),
  '+Y': vec3(0, 1, 0),
  '-Y': vec3(0, -1, 0),
  '+Z': vec3(0, 0, 1),
  '-Z': vec3(0, 0, -1),
}

/** Time order, which is the only order the timeline ever draws or samples in. */
export const sortedKeys = (keys: readonly Keyframe[]): Keyframe[] => [...keys].sort((a, b) => a.t - b.t)

/** Round to a grid, for dragging keys onto round numbers. A grid of 0 (or less) snaps to nothing. */
export const snapTime = (t: number, gridMs: number): number => (gridMs > 0 ? Math.round(t / gridMs) * gridMs : t)

const otherChannel = (c: Channel): Channel => (c === 'position' ? 'rotation' : 'position')

/** The same key carrying a new value on one channel. Explicit per channel, since `Keyframe`'s fields are readonly. */
const setChannel = (key: Keyframe, channel: Channel, value: Vec3): Keyframe =>
  channel === 'position' ? { ...key, position: value } : { ...key, rotation: value }

/** The key with one channel removed, or `null` when that channel was all it carried. */
const withoutChannel = (key: Keyframe, channel: Channel): Keyframe | null => {
  const kept = key[otherChannel(channel)]
  if (kept === undefined) return null
  const easing = key.easing !== undefined ? { easing: key.easing } : {}
  return channel === 'position' ? { t: key.t, rotation: kept, ...easing } : { t: key.t, position: kept, ...easing }
}

/**
 * The easing in force at `t`: the last key at or before it.
 *
 * So a key recorded inside an eased segment inherits that segment's curve instead of silently relinearising
 * it, which is the difference between Record mode adding detail and Record mode flattening what you had.
 */
const easingAt = (sorted: readonly Keyframe[], t: number): Easing | undefined => {
  let found: Easing | undefined
  for (const k of sorted) {
    if (k.t > t) break
    found = k.easing
  }
  return found
}

/**
 * Insert a key, or **replace** the one already at that time.
 *
 * Replacing is what makes the "+ key" button idempotent: pressing it twice at one playhead position sets the
 * pose twice rather than stacking two keys that then divide by zero. A deliberate instant jump still needs two
 * keys at one time, which `nudgeKey` below is for — an accident and an intention should not share a gesture.
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
 * Record **one channel** at a time, merging into the key already there.
 *
 * What Record mode writes (ADR 0051). A translate drag keys `position` and leaves whatever `rotation` that key
 * held alone, where `putKey` writes a whole pose and would invent a rotation channel the track never had —
 * which would freeze a spin the moment you nudged a platform sideways.
 */
export const putChannel = (keys: readonly Keyframe[], t: number, channel: Channel, value: Vec3): { keys: Keyframe[]; index: number } => {
  const at = Math.max(0, t)
  const sorted = sortedKeys(keys)
  const host = sorted.find((k) => k.t === at)
  const inherited = host?.easing ?? easingAt(sorted, at)
  const landed = setChannel(host ?? { t: at, ...(inherited !== undefined ? { easing: inherited } : {}) }, channel, value)
  const next = sortedKeys([...sorted.filter((k) => k !== host), landed])
  return { keys: next, index: next.indexOf(landed) }
}

/**
 * Retime **one channel** of one key — the precise drag, on a channel row.
 *
 * A key holding both channels **splits**: the other channel stays where it was, and this one lands at `t`.
 * That is not a schema change — two keys at different times each carrying one channel is exactly what
 * `poseAt` already samples per channel — it is the edit the single-row panel had no way to express.
 *
 * Landing on a time that already has a key **merges** into it rather than stacking a second one there, so a
 * drag cannot accidentally author the instant jump that `nudgeKey` exists to author deliberately.
 */
export const moveChannelKey = (
  keys: readonly Keyframe[],
  index: number,
  channel: Channel,
  t: number,
): { keys: Keyframe[]; index: number } => {
  const sorted = sortedKeys(keys)
  const key = sorted[index]
  const value = key?.[channel]
  if (key === undefined || value === undefined) return { keys: sorted, index }
  const at = Math.max(0, t)
  if (at === key.t) return { keys: sorted, index }

  const stripped = withoutChannel(key, channel)
  const rest = sorted.filter((_, i) => i !== index)
  const base = stripped === null ? rest : sortedKeys([...rest, stripped])

  const host = base.find((k) => k.t === at)
  const landed = setChannel(host ?? { t: at, ...(key.easing !== undefined ? { easing: key.easing } : {}) }, channel, value)
  const next = sortedKeys([...base.filter((k) => k !== host), landed])
  return { keys: next, index: next.indexOf(landed) }
}

/**
 * Shift several **whole** keys by one delta — the bulk retime, for a multi-selection.
 *
 * Whole keys, not one channel: a selection can span both rows, and a bulk drag is about moving a passage of
 * time rather than about one channel's timing. The precise per-channel edit is a single-key drag.
 *
 * Clamped **as a group**, so a drag that would push the earliest key below zero slides the whole set to zero
 * and keeps its shape, instead of collapsing the early keys onto each other.
 */
export const moveKeys = (keys: readonly Keyframe[], indices: readonly number[], deltaMs: number): { keys: Keyframe[]; indices: number[] } => {
  const sorted = sortedKeys(keys)
  const picked = indices.map((i) => sorted[i]).filter((k): k is Keyframe => k !== undefined)
  if (picked.length === 0) return { keys: sorted, indices: [] }
  const earliest = picked.reduce((min, k) => (k.t < min ? k.t : min), Infinity)
  const shift = Math.max(deltaMs, -earliest)
  if (shift === 0) return { keys: sorted, indices: picked.map((k) => sorted.indexOf(k)) }
  const moved = new Map<Keyframe, Keyframe>()
  for (const k of picked) moved.set(k, { ...k, t: k.t + shift })
  const next = sortedKeys(sorted.map((k) => moved.get(k) ?? k))
  return { keys: next, indices: picked.map((k) => next.indexOf(moved.get(k)!)) }
}

/**
 * Remove keys. The first key is removable like any other: a track whose first key is at 500ms simply holds
 * that pose until then, which is a legitimate thing to author, and refusing would make the timeline lie about
 * what a diamond is.
 */
export const deleteKeys = (keys: readonly Keyframe[], indices: readonly number[]): Keyframe[] => {
  const drop = new Set(indices)
  return sortedKeys(keys).filter((_, i) => !drop.has(i))
}

/** Set the easing of the segment *leaving* each of these keys. */
export const setEasingOn = (keys: readonly Keyframe[], indices: readonly number[], easing: Easing): Keyframe[] => {
  const pick = new Set(indices)
  return sortedKeys(keys).map((k, i) => (pick.has(i) ? { ...k, easing } : k))
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
 * Add a second key one millisecond after an existing one, holding its pose — the gesture for an instant jump,
 * since a step needs somewhere to step *from*.
 */
export const nudgeKey = (keys: readonly Keyframe[], index: number): Keyframe[] => {
  const sorted = sortedKeys(keys)
  const key = sorted[index]
  if (key === undefined) return sorted
  return sortedKeys([...sorted, { ...key, t: key.t + 1 }])
}

/**
 * Keys lifted out for a paste, **rebased so the earliest sits at 0**, which is what lets a paste land at the
 * playhead rather than back where it came from.
 */
export const copyKeys = (keys: readonly Keyframe[], indices: readonly number[]): Keyframe[] => {
  const sorted = sortedKeys(keys)
  const picked = indices.map((i) => sorted[i]).filter((k): k is Keyframe => k !== undefined)
  if (picked.length === 0) return []
  const base = picked.reduce((min, k) => (k.t < min ? k.t : min), Infinity)
  return sortedKeys(picked.map((k) => ({ ...k, t: k.t - base })))
}

/**
 * Drop copied keys in with the earliest at `atMs`, **replacing** anything already at the times they land on.
 *
 * Replacing rather than stacking for `putKey`'s reason: a paste is a statement about those instants, and two
 * keys at one time is a jump somebody should have to ask for.
 */
export const pasteKeys = (keys: readonly Keyframe[], clip: readonly Keyframe[], atMs: number): { keys: Keyframe[]; indices: number[] } => {
  const sorted = sortedKeys(keys)
  if (clip.length === 0) return { keys: sorted, indices: [] }
  const at = Math.max(0, atMs)
  const landing = clip.map((k) => ({ ...k, t: at + k.t }))
  const times = new Set(landing.map((k) => k.t))
  const next = sortedKeys([...sorted.filter((k) => !times.has(k.t)), ...landing])
  return { keys: next, indices: landing.map((k) => next.indexOf(k)) }
}

/** A fresh track: a single key at 0, holding the rest pose.
 *
 * Takes no pose, because keys are offsets and the rest pose *is* zero (ADR 0050). A new track therefore
 * leaves the object exactly where it stands, which is what adding an empty track should look like — the old
 * version baked the current pose into the key and any later transform edit was silently overridden.
 *
 * One key rather than two, because a two-key track invents a duration nobody chose. One key is a held pose,
 * which is honest — the loader treats it as static — and the second key is the author's first real decision.
 */
export const restKeys = (): Keyframe[] => [{ t: 0, position: vec3(0, 0, 0), rotation: vec3(0, 0, 0), easing: 'inOut' }]

/** One key as a channel row draws it. */
export interface ChannelKey {
  /** Index into the sorted key array — what every mutation here addresses. */
  index: number
  t: number
  /** The curve leaving this key. `linear` when the key writes none. */
  easing: Easing
  /** Another key on **this channel** shares this time: an instant jump, worth drawing differently. */
  stacked: boolean
  /** It carries the other channel too, so a drag on this row splits it. Drawn as a hint. */
  shared: boolean
}

/** The keys that touch one channel, in time order. Empty when the track does not animate it at all. */
export const channelRow = (keys: readonly Keyframe[], channel: Channel): ChannelKey[] => {
  const sorted = sortedKeys(keys)
  const other = otherChannel(channel)
  const out: ChannelKey[] = []
  sorted.forEach((k, index) => {
    if (k[channel] === undefined) return
    out.push({
      index,
      t: k.t,
      easing: k.easing ?? 'linear',
      stacked: sorted.some((o, j) => j !== index && o.t === k.t && o[channel] !== undefined),
      shared: k[other] !== undefined,
    })
  })
  return out
}

/** The stretch between two consecutive keys of one channel — what carries the easing label. */
export interface ChannelSegment {
  /** The key the segment **leaves**: whose easing it draws, and whose easing an edit here sets. */
  index: number
  fromMs: number
  toMs: number
  easing: Easing
}

/**
 * A channel's segments, in time order.
 *
 * Between consecutive keys **of that channel**, which is exactly what `poseAt` interpolates: it filters to the
 * channel and then walks. So a position segment can span a rotation key without being divided by it, and the
 * easing drawn is the easing that will be applied.
 */
export const channelSegments = (keys: readonly Keyframe[], channel: Channel): ChannelSegment[] => {
  const row = channelRow(keys, channel)
  const out: ChannelSegment[] = []
  for (let i = 0; i < row.length - 1; i++) {
    const a = row[i]!
    const b = row[i + 1]!
    if (b.t === a.t) continue // an instant jump has no stretch to draw
    out.push({ index: a.index, fromMs: a.t, toMs: b.t, easing: a.easing })
  }
  return out
}

/**
 * The polyline the viewport draws for a track: where every positioned key puts the object, in time order.
 *
 * `base` is the node's authored position, which has to be passed in because keys are **offsets** from it
 * (ADR 0050) — a key alone no longer says where anything is. Adding it here rather than at the call site keeps
 * the drawn path and the draggable handles reading from one place, and `index` comes along so the caller can
 * map a handle back to a key without a second pass.
 *
 * Only the keys, not a sampled curve. Easing changes *when* the object is between two keys and never *where*,
 * since every segment is a straight line in space — so the polyline is exact, not an approximation, and it is
 * the same handles a person drags.
 */
export const pathPoints = (keys: readonly Keyframe[], base: Vec3): { index: number; t: number; position: Vec3 }[] => {
  const sorted = sortedKeys(keys)
  return channelRow(keys, 'position').map((row) => {
    const p = sorted[row.index]!.position!
    return { index: row.index, t: row.t, position: vec3(base.x + p.x, base.y + p.y, base.z + p.z) }
  })
}

/** The track's length, re-exported so the panel needs one import for its whole edit vocabulary. */
export { trackDuration }
