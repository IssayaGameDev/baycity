import { Container, Graphics } from 'pixi.js'

/** Stick view state — structurally `@mp/client`'s `JoystickState`, kept dependency-free. */
export interface TouchHudStick {
  active: boolean
  baseX: number
  baseY: number
  knobX: number
  knobY: number
  radius: number
}

/** Jump button view state — structurally `@mp/client`'s `JumpButtonState`. */
export interface TouchHudButton {
  x: number
  y: number
  radius: number
  held: boolean
}

export interface TouchHudStyle {
  /** Ring and glyph colour. */
  color: number
  /** Opacity while untouched, and while held. */
  idleAlpha: number
  activeAlpha: number
}

export const DEFAULT_TOUCH_HUD_STYLE: TouchHudStyle = { color: 0xe2e8f0, idleAlpha: 0.3, activeAlpha: 0.65 }

export interface TouchHud {
  /** Push this frame's state. Drawing is immediate-mode: clear and redraw, no retained nodes. */
  draw: (stick: TouchHudStick, jump: TouchHudButton) => void
  setVisible: (visible: boolean) => void
  dispose: () => void
}

/**
 * The on-screen touch controls (ADR 0022): the movement stick's ring and knob, and the jump button.
 *
 * View only — every rule about what a touch *means* lives in `@mp/client`'s `createTouchControls`, and
 * this draws whatever state that reports. It goes on the mode's existing UI overlay rather than a second
 * Pixi application (ADR 0015: one UI layer).
 *
 * Deliberately **not interactive**: `eventMode` stays `none` so the controls never swallow a pointer.
 * Input is read from the raw pointer stream on the canvas underneath, which is what lets a thumb slide
 * off the button and keep steering, and what keeps hit-testing out of the input path entirely.
 */
export const createTouchHud = (parent: Container, style: TouchHudStyle = DEFAULT_TOUCH_HUD_STYLE): TouchHud => {
  const root = new Container()
  root.eventMode = 'none'
  root.visible = false
  const g = new Graphics()
  g.eventMode = 'none'
  root.addChild(g)
  parent.addChild(root)

  return {
    draw: (stick, jump) => {
      const alpha = stick.active ? style.activeAlpha : style.idleAlpha
      g.clear()
        // The ring: where the stick's centre is now, which under `recentre` is wherever the thumb landed.
        .circle(stick.baseX, stick.baseY, stick.radius)
        .stroke({ width: 2, color: style.color, alpha })
        // The knob, already clamped to the ring by the controls — so a thumb pushed past the edge shows
        // the knob resting at the rim while steering continues at full strength.
        .circle(stick.knobX, stick.knobY, stick.radius * 0.42)
        .fill({ color: style.color, alpha: alpha * 0.5 })
        .stroke({ width: 2, color: style.color, alpha })
        .circle(jump.x, jump.y, jump.radius)
        .fill({ color: style.color, alpha: jump.held ? style.activeAlpha * 0.4 : style.idleAlpha * 0.25 })
        .stroke({ width: 2, color: style.color, alpha: jump.held ? style.activeAlpha : style.idleAlpha })
      // An up-chevron on the button, so it reads as jump without a label to localize.
      const s = jump.radius * 0.42
      g.moveTo(jump.x - s, jump.y + s * 0.5)
        .lineTo(jump.x, jump.y - s * 0.6)
        .lineTo(jump.x + s, jump.y + s * 0.5)
        .stroke({ width: 3, color: style.color, alpha: jump.held ? style.activeAlpha : style.idleAlpha })
    },
    setVisible: (visible) => {
      root.visible = visible
    },
    dispose: () => {
      parent.removeChild(root)
      root.destroy({ children: true })
    },
  }
}
