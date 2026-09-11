import { describe, expect, it } from 'vitest'

import { createTouchControls, DEFAULT_TOUCH_LAYOUT, type TouchLayout } from './touchControls'

// A landscape phone, which is how this game is held.
const W = 800
const H = 400
const make = (over: Partial<TouchLayout> = {}) => createTouchControls(W, H, { ...DEFAULT_TOUCH_LAYOUT, ...over })

/** Middle of the look region: right of the stick zone, below the top strip. */
const LOOK = { x: 600, y: 200 }
/** Inside the stick's capture zone but nowhere near its ring. */
const STICK_ZONE = { x: 40, y: 380 }

/** The same phone stood on end. Portrait is supported with the same layout (ADR 0022). */
const portrait = (over: Partial<TouchLayout> = {}) => createTouchControls(H, W, { ...DEFAULT_TOUCH_LAYOUT, ...over })

describe('createTouchControls', () => {
  it('keeps the stick zone to thumb reach in portrait rather than half the screen', () => {
    // 55% of an 800 px-tall screen is 440 px — over half the display for a control that lives in a corner,
    // and it would swallow the look region a right thumb needs. The px cap is what makes one layout work
    // in both orientations.
    const c = portrait()
    const cap = DEFAULT_TOUCH_LAYOUT.stickZone.maxHeight
    c.pointerDown(1, 20, W - cap - 40) // inside the fraction, outside the cap
    expect(c.joystick().active, 'well above the corner: that is look, not steering').toBe(false)
    c.pointerDown(2, 20, W - 40) // in the corner
    expect(c.joystick().active).toBe(true)
  })

  it('still reaches the stick in landscape, where the fraction is the binding limit', () => {
    const c = make()
    // 55% of 400 is 220, under the 260 cap, so the fraction decides and nothing changed for landscape.
    c.pointerDown(1, 20, H - 200)
    expect(c.joystick().active).toBe(true)
  })

  it('is inactive until a pointer is seen, so a mouse user never sees a joystick', () => {
    const c = make()
    expect(c.active()).toBe(false)
    c.pointerDown(1, LOOK.x, LOOK.y)
    expect(c.active()).toBe(true)
  })

  describe('the stick', () => {
    it('captures anywhere in the bottom-left zone, not just on the ring', () => {
      const c = make()
      c.pointerDown(1, STICK_ZONE.x, STICK_ZONE.y)
      expect(c.joystick().active, 'a thumb should never have to find the ring').toBe(true)
    })

    it('starts from zero deflection when it re-centres, which is what saves a mid-air re-grip', () => {
      // With a fixed centre, a thumb landing this far from the home is at full deflection instantly and
      // the character bolts. Re-centring means motion only begins once the thumb actually moves.
      const c = make({ anchor: 'recentre' })
      c.pointerDown(1, STICK_ZONE.x, STICK_ZONE.y)
      expect(c.movement()).toEqual({ x: 0, z: 0 })
      const fixed = make({ anchor: 'fixed' })
      fixed.pointerDown(1, STICK_ZONE.x, STICK_ZONE.y)
      expect(Math.hypot(fixed.movement().x, fixed.movement().z), 'fixed deflects on touch').toBeGreaterThan(0.5)
    })

    it('reads the offset from its centre, normalized by the radius', () => {
      const c = make({ anchor: 'recentre', deadZone: 0 })
      c.pointerDown(1, 200, 300)
      c.pointerMove(1, 200 + DEFAULT_TOUCH_LAYOUT.stickRadius / 2, 300)
      expect(c.movement().x).toBeCloseTo(0.5, 6)
      expect(c.movement().z).toBeCloseTo(0, 6)
    })

    it('keeps steering at full strength past the ring, and clamps only what is drawn', () => {
      const c = make({ anchor: 'recentre', deadZone: 0 })
      const r = DEFAULT_TOUCH_LAYOUT.stickRadius
      c.pointerDown(1, 200, 300)
      c.pointerMove(1, 200 + r * 4, 300)
      const m = c.movement()
      expect(Math.hypot(m.x, m.z), 'magnitude clamps to 1').toBeCloseTo(1, 6)
      expect(m.x, 'and the direction survives').toBeCloseTo(1, 6)
      const j = c.joystick()
      expect(j.knobX - j.baseX, 'the knob stops at the ring').toBeCloseTo(r, 6)
    })

    it('zeroes a resting thumb, on the magnitude rather than per axis', () => {
      const c = make({ anchor: 'recentre', deadZone: 0.2 })
      const r = DEFAULT_TOUCH_LAYOUT.stickRadius
      c.pointerDown(1, 200, 300)
      // A diagonal nudge inside the dead radius: a per-axis dead zone would pass this through and make
      // the stick snap to diagonals.
      c.pointerMove(1, 200 + r * 0.1, 300 + r * 0.1)
      expect(c.movement()).toEqual({ x: 0, z: 0 })
      c.pointerMove(1, 200 + r * 0.3, 300 + r * 0.3)
      expect(Math.hypot(c.movement().x, c.movement().z)).toBeGreaterThan(0.2)
    })

    it('centres exactly on the thumb even in the corner, rather than nudging itself on screen', () => {
      // Keeping the whole ring on screen sounds right and is strictly worse: the bezel bounds the finger
      // either way, so moving the centre inward buys no travel and pre-loads deflection — the bolt that
      // re-centring exists to prevent, in the corner where thumbs land. The ring just clips.
      const c = make({ anchor: 'recentre' })
      c.pointerDown(1, 2, H - 2)
      const j = c.joystick()
      expect(j.baseX).toBe(2)
      expect(j.baseY).toBe(H - 2)
      expect(c.movement(), 'and so it still starts from a standstill').toEqual({ x: 0, z: 0 })
    })

    it('releases back to its home and stops moving', () => {
      const c = make({ anchor: 'recentre', deadZone: 0 })
      c.pointerDown(1, 200, 300)
      c.pointerMove(1, 260, 300)
      c.pointerUp(1)
      expect(c.movement()).toEqual({ x: 0, z: 0 })
      expect(c.joystick().active).toBe(false)
      expect(c.joystick().baseX).toBeCloseTo(DEFAULT_TOUCH_LAYOUT.stickInset.x, 6)
    })

    it('ignores a second thumb in its zone rather than jumping the stick to it', () => {
      const c = make({ anchor: 'recentre', deadZone: 0 })
      c.pointerDown(1, 200, 300)
      c.pointerMove(1, 240, 300)
      const before = c.movement().x
      c.pointerDown(2, 60, 380)
      expect(c.movement().x).toBeCloseTo(before, 6)
    })
  })

  describe('ownership', () => {
    it('lets a thumb steer while another looks and a third jumps', () => {
      const c = make({ anchor: 'recentre', deadZone: 0 })
      c.pointerDown(1, 200, 300) // stick
      c.pointerDown(2, LOOK.x, LOOK.y) // look
      c.pointerDown(3, W - DEFAULT_TOUCH_LAYOUT.jumpInset.x, H - DEFAULT_TOUCH_LAYOUT.jumpInset.y) // jump
      c.pointerMove(1, 240, 300)
      c.pointerMove(2, LOOK.x + 30, LOOK.y + 10)
      expect(c.movement().x, 'steering').toBeGreaterThan(0)
      expect(c.jump(), 'jump held').toBe(true)
      const look = c.drainLook()
      expect(look.dx, 'looking').toBeCloseTo(30, 6)
      expect(look.dy).toBeCloseTo(10, 6)
    })

    it('holds a pointer in the zone it started in, even when it wanders into another', () => {
      const c = make({ anchor: 'recentre', deadZone: 0 })
      c.pointerDown(1, 200, 300) // starts in the stick zone
      c.pointerMove(1, LOOK.x, LOOK.y) // wanders across the screen
      expect(c.drainLook().dx, 'must not become a look drag').toBe(0)
      expect(Math.hypot(c.movement().x, c.movement().z), 'still steering, clamped').toBeCloseTo(1, 6)
    })

    it('is held-jump, matching a held Space', () => {
      const c = make()
      const j = c.jumpButton()
      c.pointerDown(1, j.x, j.y)
      expect(c.jump()).toBe(true)
      c.pointerUp(1)
      expect(c.jump()).toBe(false)
    })

    it('captures nothing in the top strip, which belongs to the pause button and the pane', () => {
      const c = make()
      c.pointerDown(1, W / 2, 10)
      c.pointerMove(1, W / 2 + 40, 10)
      expect(c.drainLook().dx).toBe(0)
    })
  })

  describe('look, tap and pinch', () => {
    it('accumulates a drag and drains it once', () => {
      const c = make()
      c.pointerDown(1, LOOK.x, LOOK.y)
      c.pointerMove(1, LOOK.x + 10, LOOK.y)
      c.pointerMove(1, LOOK.x + 25, LOOK.y - 5)
      expect(c.drainLook().dx).toBeCloseTo(25, 6)
      expect(c.drainLook().dx, 'drained, so a frame never applies the same drag twice').toBe(0)
    })

    it('reads a release that barely moved as a tap — the mobile respawn', () => {
      const c = make()
      c.pointerDown(1, LOOK.x, LOOK.y)
      c.pointerMove(1, LOOK.x + 3, LOOK.y + 2)
      c.pointerUp(1)
      expect(c.drainLook().tapped).toBe(true)
    })

    it('does not read a drag as a tap', () => {
      const c = make()
      c.pointerDown(1, LOOK.x, LOOK.y)
      c.pointerMove(1, LOOK.x + 80, LOOK.y)
      c.pointerUp(1)
      expect(c.drainLook().tapped).toBe(false)
    })

    it('measures a tap by distance travelled, not by displacement', () => {
      // Out and back returns to the start, which a displacement check would call a tap. It was a drag.
      const c = make()
      c.pointerDown(1, LOOK.x, LOOK.y)
      c.pointerMove(1, LOOK.x + 60, LOOK.y)
      c.pointerMove(1, LOOK.x, LOOK.y)
      c.pointerUp(1)
      expect(c.drainLook().tapped).toBe(false)
    })

    it('pinches on two look pointers, and suspends look while it does', () => {
      const c = make()
      c.pointerDown(1, 500, 200)
      c.pointerDown(2, 600, 200) // 100 px apart
      c.pointerMove(1, 450, 200) // 150 apart
      const out = c.drainLook()
      expect(out.pinch, 'fingers moved 50 px apart').toBeCloseTo(50, 6)
      expect(out.dx, 'and the camera must not also swing').toBe(0)
    })

    it('re-baselines the survivor when a pinch drops to one finger', () => {
      // The trap: without re-baselining, the next move applies the whole finger separation as one look
      // delta and the camera snaps.
      const c = make()
      c.pointerDown(1, 500, 200)
      c.pointerDown(2, 700, 200)
      c.pointerMove(1, 480, 200)
      c.drainLook()
      c.pointerUp(2)
      c.pointerMove(1, 485, 200)
      const out = c.drainLook()
      expect(out.dx, 'only the 5 px it actually moved').toBeCloseTo(5, 6)
      expect(out.pinch).toBe(0)
    })

    it('never pinches a stick thumb against a look thumb', () => {
      const c = make({ anchor: 'recentre', deadZone: 0 })
      c.pointerDown(1, 200, 300) // stick
      c.pointerDown(2, LOOK.x, LOOK.y) // look
      c.pointerMove(2, LOOK.x + 40, LOOK.y)
      const out = c.drainLook()
      expect(out.pinch, 'two thumbs on two controls is not a gesture').toBe(0)
      expect(out.dx).toBeCloseTo(40, 6)
    })
  })

  it('drops everything held on resize and on blur — the zones moved, or focus left mid-drag', () => {
    for (const reset of ['resize', 'releaseAll'] as const) {
      const c = make({ anchor: 'recentre', deadZone: 0 })
      c.pointerDown(1, 200, 300)
      c.pointerMove(1, 260, 300)
      c.pointerDown(2, c.jumpButton().x, c.jumpButton().y)
      if (reset === 'resize') c.resize(W, H)
      else c.releaseAll()
      expect(c.movement()).toEqual({ x: 0, z: 0 })
      expect(c.jump()).toBe(false)
      // And a pointer that is still physically down cannot resume control of a stale zone.
      c.pointerMove(1, 300, 300)
      expect(c.movement()).toEqual({ x: 0, z: 0 })
    }
  })


  it('latches a jump press, so a tap shorter than one tick is not lost', () => {
    const c = make()
    const j = c.jumpButton()
    c.pointerDown(1, j.x, j.y)
    c.pointerUp(1)
    // The button is no longer held, and a tick sampling `jump()` alone would see nothing at all.
    expect(c.jump()).toBe(false)
    expect(c.drainJumpPress()).toBe(true)
  })

  it('drains the jump press once, so one tap is one jump', () => {
    const c = make()
    const j = c.jumpButton()
    c.pointerDown(1, j.x, j.y)
    expect(c.drainJumpPress()).toBe(true)
    expect(c.drainJumpPress()).toBe(false)
  })

  it('does not latch a press outside the jump zone', () => {
    const c = make()
    c.pointerDown(1, LOOK.x, LOOK.y)
    expect(c.drainJumpPress()).toBe(false)
  })

  it('latches a second tap after the first finger lifts', () => {
    const c = make()
    const j = c.jumpButton()
    c.pointerDown(1, j.x, j.y)
    expect(c.drainJumpPress()).toBe(true)
    c.pointerUp(1)
    c.pointerDown(2, j.x, j.y)
    expect(c.drainJumpPress()).toBe(true)
  })
})

// iOS Safari hands touch pointers negative ids. A `-1` sentinel with `>= 0` tests read a real finger as no
// finger: the knob tracked the thumb, `active` said false, and the character never moved.
describe('pointer ids from iOS', () => {
  it('drives the stick with a negative pointer id', () => {
    const c = make()
    c.pointerDown(-7, STICK_ZONE.x, STICK_ZONE.y)
    c.pointerMove(-7, STICK_ZONE.x + 40, STICK_ZONE.y)
    expect(c.joystick().active).toBe(true)
    expect(c.movement().x).toBeGreaterThan(0.5)
    c.pointerUp(-7)
    expect(c.joystick().active).toBe(false)
    expect(c.movement()).toEqual({ x: 0, z: 0 })
  })

  it('holds the jump button with a negative pointer id', () => {
    const c = make()
    const j = c.jumpButton()
    c.pointerDown(-3, j.x, j.y)
    expect(c.jump()).toBe(true)
    expect(c.jumpButton().held).toBe(true)
    c.pointerUp(-3)
    expect(c.jump()).toBe(false)
  })
})
