import type { InputSource, InputState } from './input'

/**
 * Touch controls: movement stick bottom-left, jump button bottom-right, look everywhere else
 * (ADR 0022). Headless — it consumes `(pointerId, x, y)` in CSS pixels and emits state, so every rule
 * here is unit-testable and only the event binding needs a browser (`./dom`).
 *
 * The one rule everything else follows from: **a pointer belongs to whichever zone it first touched**,
 * until it is released. Nothing can steal it. That is what lets a thumb steer while another thumb looks
 * and a third taps jump, and it is why a left thumb on the stick can never pair into a pinch.
 */

/** Screen layout, in CSS pixels and fractions of the viewport. Every number is tunable. */
export interface TouchLayout {
  /** Stick ring radius. Full deflection at this distance from the stick's centre. */
  stickRadius: number
  /** Stick home, as an inset from the bottom-left corner (add safe-area insets on top). */
  stickInset: { x: number; y: number }
  /**
   * The region that captures for the stick, measured from the bottom-left: fractions of the viewport,
   * each **capped in CSS pixels**. Larger is more forgiving to a wandering thumb and takes more away from
   * look.
   *
   * The caps are what make one layout work in both orientations. A thumb's reach is a physical distance,
   * not a proportion of the screen: 55% of a landscape phone is about 210 px and right, while 55% of the
   * same phone in portrait is 460 px and claims over half the display for a control that needs a corner.
   * The fractions keep small screens sane, the caps keep tall ones from being eaten.
   */
  stickZone: { width: number; height: number; maxWidth: number; maxHeight: number }
  /** Jump button radius and its inset from the bottom-right corner. */
  jumpRadius: number
  jumpInset: { x: number; y: number }
  /**
   * Height of the strip along the top that captures for nothing — it belongs to the pause button and
   * the debug pane, and a look drag starting there would fight them.
   */
  topStrip: number
  /** Deflection below this fraction of the radius reads as zero, so a resting thumb does not creep. */
  deadZone: number
  /**
   * `recentre` moves the stick's centre to wherever the zone was touched and starts from zero deflection;
   * `fixed` keeps the centre at the home, so touching away from it deflects immediately (ADR 0022 has
   * the argument — a mid-air re-grip is the case that decides it).
   */
  anchor: 'recentre' | 'fixed'
  /** A release whose pointer travelled less than this counts as a tap rather than a drag. */
  tapSlop: number
}

export const DEFAULT_TOUCH_LAYOUT: TouchLayout = {
  stickRadius: 64,
  stickInset: { x: 110, y: 110 },
  stickZone: { width: 0.45, height: 0.55, maxWidth: 380, maxHeight: 260 },
  jumpRadius: 46,
  jumpInset: { x: 84, y: 96 },
  topStrip: 56,
  deadZone: 0.12,
  anchor: 'recentre',
  tapSlop: 12,
}

/** What the HUD draws. Field names match `JoystickState` so existing views keep working. */
export interface JoystickState {
  active: boolean
  baseX: number
  baseY: number
  knobX: number
  knobY: number
  radius: number
}

export interface JumpButtonState {
  x: number
  y: number
  radius: number
  held: boolean
}

/** Look and zoom arrive as deltas that accumulate between frames, so they are drained, not read. */
export interface TouchLook {
  /** Accumulated drag since the last drain, in CSS pixels. Positive x is rightward, y is downward. */
  dx: number
  dy: number
  /** Accumulated pinch since the last drain, in CSS pixels of finger separation. Positive is apart. */
  pinch: number
  /** A tap in the look region completed since the last drain. */
  tapped: boolean
}

export interface TouchControls extends InputSource {
  /** True once any touch-type pointer has been seen — what a mode shows its controls on. */
  active: () => boolean
  jump: () => boolean
  /**
   * Whether the jump button was pressed since the last call, and clears it. `jump()` above is the
   * button's *held* state, sampled at tick time, and a tap shorter than one tick (33 ms at 30 Hz) is
   * pressed and released between two samples and never seen at all. This latch is what makes a quick
   * tap register. Drain it once per tick whether or not it is used, or a stale press fires later.
   */
  drainJumpPress: () => boolean
  /** Take the accumulated look/pinch/tap and reset them. Call once per frame. */
  drainLook: () => TouchLook
  joystick: () => JoystickState
  jumpButton: () => JumpButtonState
  /** Viewport size changed: re-place the zones. Anything held is released, since its zone moved. */
  resize: (width: number, height: number) => void
  pointerDown: (id: number, x: number, y: number) => void
  pointerMove: (id: number, x: number, y: number) => void
  pointerUp: (id: number) => void
  /** Every pointer released at once — a page blur, or the view losing focus mid-drag. */
  releaseAll: () => void
}

type Zone = 'stick' | 'jump' | 'look'

interface Tracked {
  zone: Zone
  x: number
  y: number
  /** Total path length, for tap detection. */
  travel: number
}

export const createTouchControls = (
  width: number,
  height: number,
  layout: TouchLayout = DEFAULT_TOUCH_LAYOUT,
): TouchControls => {
  let w = width
  let h = height
  let seen = false
  const pointers = new Map<number, Tracked>()
  let look: TouchLook = { dx: 0, dy: 0, pinch: 0, tapped: false }
  // The stick's live centre. Equal to the home unless a `recentre` capture moved it.
  let centreX = 0
  let centreY = 0
  let knobX = 0
  let knobY = 0
  /**
   * The pointer on the stick and the one on the jump button, or `null`. **Not `-1`**: iOS Safari hands touch
   * pointers negative ids, and a `>= 0` test read a real finger as no finger — the knob followed the thumb while
   * the stick swore nobody was on it, and the character stood still. Chrome's emulation uses positive ids, which
   * is why it never showed there.
   */
  let stickId: number | null = null
  let jumpId: number | null = null
  /** A jump press seen since the last drain — see `drainJumpPress`. */
  let jumpPress = false
  /** Finger separation at the last pinch sample, or null when a pinch is not in progress. */
  let pinchSpan: number | null = null

  const home = (): { x: number; y: number } => ({ x: layout.stickInset.x, y: h - layout.stickInset.y })
  const jumpCentre = (): { x: number; y: number } => ({ x: w - layout.jumpInset.x, y: h - layout.jumpInset.y })

  const resetStick = (): void => {
    const c = home()
    centreX = c.x
    centreY = c.y
    knobX = c.x
    knobY = c.y
    stickId = null
  }
  resetStick()

  const zoneOf = (x: number, y: number): Zone | null => {
    const j = jumpCentre()
    if (Math.hypot(x - j.x, y - j.y) <= layout.jumpRadius) return 'jump'
    // The stick's zone is a rectangle in the bottom-left, not the ring: a thumb should never have to
    // find the ring, only the corner it lives in.
    const zw = Math.min(w * layout.stickZone.width, layout.stickZone.maxWidth)
    const zh = Math.min(h * layout.stickZone.height, layout.stickZone.maxHeight)
    if (x <= zw && y >= h - zh) return 'stick'
    if (y < layout.topStrip) return null // the pause button and the debug pane own this strip
    return 'look'
  }

  /** Pointers currently owned by the look region, oldest first — a pinch is the first two of them. */
  const lookPointers = (): Tracked[] => [...pointers.values()].filter((p) => p.zone === 'look')

  const spanOf = (ps: Tracked[]): number => Math.hypot(ps[0]!.x - ps[1]!.x, ps[0]!.y - ps[1]!.y)

  const setKnob = (x: number, y: number): void => {
    const dx = x - centreX
    const dy = y - centreY
    const len = Math.hypot(dx, dy)
    // Clamped to the ring for drawing, but the direction is kept: pushing past the ring keeps steering at
    // full strength rather than cutting out, which is the whole point of a stick you cannot see.
    const scale = len > layout.stickRadius ? layout.stickRadius / len : 1
    knobX = centreX + dx * scale
    knobY = centreY + dy * scale
  }

  return {
    active: () => seen,
    movement: (): InputState => {
      if (stickId === null) return { x: 0, z: 0 }
      const x = (knobX - centreX) / layout.stickRadius
      const z = (knobY - centreY) / layout.stickRadius
      // Dead zone on the *magnitude*, so it is circular rather than per-axis — a per-axis one leaves
      // diagonals live while the axes are dead, which reads as the stick snapping to diagonals.
      return Math.hypot(x, z) < layout.deadZone ? { x: 0, z: 0 } : { x, z }
    },
    jump: () => jumpId !== null,
    drainJumpPress: () => {
      const p = jumpPress
      jumpPress = false
      return p
    },
    drainLook: () => {
      const out = look
      look = { dx: 0, dy: 0, pinch: 0, tapped: false }
      return out
    },
    joystick: () => ({
      active: stickId !== null,
      baseX: centreX,
      baseY: centreY,
      knobX,
      knobY,
      radius: layout.stickRadius,
    }),
    jumpButton: () => {
      const c = jumpCentre()
      return { x: c.x, y: c.y, radius: layout.jumpRadius, held: jumpId !== null }
    },
    resize: (nw, nh) => {
      w = nw
      h = nh
      pointers.clear()
      jumpId = null
      pinchSpan = null
      resetStick()
    },
    pointerDown: (id, x, y) => {
      seen = true
      if (pointers.has(id)) return
      const zone = zoneOf(x, y)
      if (zone === null) return
      if (zone === 'stick') {
        if (stickId !== null) return // one thumb per stick; a second in the zone is ignored
        stickId = id
        if (layout.anchor === 'recentre') {
          // Exactly on the thumb, deliberately un-clamped. Nudging the centre inward to keep the whole
          // ring on screen sounds right and is strictly worse: it buys no travel — the bezel bounds the
          // finger either way — while pre-loading deflection the player never asked for, in the very
          // corner where a thumb naturally lands. Starting at zero is the property the whole re-centring
          // design exists for. A ring drawn near an edge simply clips, which reads as "you are at the edge".
          centreX = x
          centreY = y
        }
        setKnob(x, y)
      } else if (zone === 'jump') {
        if (jumpId !== null) return
        jumpId = id
        jumpPress = true
      } else if (lookPointers().length === 1) {
        // A second look pointer starts a pinch. Look is suspended while both are down.
        pointers.set(id, { zone, x, y, travel: 0 })
        pinchSpan = spanOf(lookPointers())
        return
      }
      pointers.set(id, { zone, x, y, travel: 0 })
    },
    pointerMove: (id, x, y) => {
      const p = pointers.get(id)
      if (p === undefined) return
      const dx = x - p.x
      const dy = y - p.y
      p.travel += Math.hypot(dx, dy)
      p.x = x
      p.y = y
      if (p.zone === 'stick') {
        setKnob(x, y)
        return
      }
      if (p.zone !== 'look') return
      const ps = lookPointers()
      if (ps.length >= 2) {
        const span = spanOf(ps)
        if (pinchSpan !== null) look.pinch += span - pinchSpan
        pinchSpan = span
        return // no look while pinching, or the camera spins as the fingers move
      }
      look.dx += dx
      look.dy += dy
    },
    pointerUp: (id) => {
      const p = pointers.get(id)
      pointers.delete(id)
      if (id === stickId) resetStick()
      if (id === jumpId) jumpId = null
      if (p === undefined) return
      if (p.zone === 'look') {
        if (p.travel <= layout.tapSlop) look.tapped = true
        // Dropping out of a pinch: the remaining finger must be re-baselined, or the next move applies
        // the gap between the two fingers as one enormous look delta.
        pinchSpan = lookPointers().length >= 2 ? spanOf(lookPointers()) : null
      }
    },
    releaseAll: () => {
      pointers.clear()
      jumpId = null
      pinchSpan = null
      resetStick()
    },
  }
}
