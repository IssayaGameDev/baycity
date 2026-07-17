import { Application, Graphics, Text } from 'pixi.js'

/** Joystick view state (structurally matches `@mp/client/dom`'s JoystickState). */
export interface HudJoystick {
  active: boolean
  baseX: number
  baseY: number
  knobX: number
  knobY: number
  radius: number
}

export interface Hud {
  /** Transparent canvas to stack over the Three.js canvas (SEED §2). */
  readonly canvas: HTMLCanvasElement
  setStatus: (text: string) => void
  setJoystick: (j: HudJoystick | null) => void
  resize: (width: number, height: number) => void
  dispose: () => void
}

/**
 * PixiJS 2D HUD on its own transparent canvas — a separate context stacked over
 * the Three.js canvas (SEED §2), not a shared GL context. Pixi's ticker renders
 * it automatically; callers just push state via the setters.
 */
export const createHud = async (opts: { width: number; height: number }): Promise<Hud> => {
  const app = new Application()
  await app.init({ width: opts.width, height: opts.height, backgroundAlpha: 0, antialias: true })

  const crosshair = new Graphics()
  app.stage.addChild(crosshair)
  const drawCrosshair = (w: number, h: number): void => {
    const cx = w / 2
    const cy = h / 2
    crosshair
      .clear()
      .moveTo(cx - 9, cy)
      .lineTo(cx + 9, cy)
      .moveTo(cx, cy - 9)
      .lineTo(cx, cy + 9)
      .stroke({ width: 2, color: 0xffffff, alpha: 0.6 })
  }
  drawCrosshair(opts.width, opts.height)

  const status = new Text({ text: '', style: { fill: 0xcbd5e1, fontSize: 14, fontFamily: 'system-ui' } })
  status.position.set(12, 10)
  app.stage.addChild(status)

  const joystick = new Graphics()
  app.stage.addChild(joystick)

  return {
    canvas: app.canvas,
    setStatus: (text) => {
      status.text = text
    },
    setJoystick: (j) => {
      joystick.clear()
      if (j === null || !j.active) return
      joystick
        .circle(j.baseX, j.baseY, j.radius)
        .stroke({ width: 2, color: 0xffffff, alpha: 0.35 })
        .circle(j.knobX, j.knobY, j.radius * 0.4)
        .fill({ color: 0xffffff, alpha: 0.5 })
    },
    resize: (w, h) => {
      app.renderer.resize(w, h)
      drawCrosshair(w, h)
    },
    dispose: () => app.destroy(true),
  }
}
