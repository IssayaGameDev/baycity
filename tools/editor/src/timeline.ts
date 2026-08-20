import { trackDuration, type Keyframe, type Pose } from '@mp/content'

import { DIRS, EASINGS, deleteKey, keyRows, moveKey, nudgeKey, putKey, setEasing, snapTime, sortedKeys } from './trackEdit'
import type { ContextMenu, MenuItem } from './menu'

/**
 * The Animation panel: the timeline strip (ADR 0029).
 *
 * Time lives here and space lives in the viewport. That split is the reason there is no graph editor — a
 * graph editor unifies them into one curve per channel, which is the right tool for character animation and
 * the wrong one for "this platform rises three metres and pauses". So: diamonds on a ruler for *when*, the
 * existing transform gizmo for *where*, and a named curve per segment instead of bezier handles.
 *
 * Rebuilt wholesale on `render`, like the Hierarchy: a track is a handful of keys, and diffing would buy
 * nothing but a class of stale-node bugs.
 *
 * **It edits one component's `keys` parameter**, named in its heading and opened from that component's section
 * in the Inspector. It used to float beside the Project browser and address "the selection's track", which made
 * an animation the one thing in the editor that was not a component you could point at. The strip stays a wide
 * strip because a timeline needs horizontal room, and Unity keeps its Animation window out of the Inspector for
 * the same reason — but what it edits is a declared parameter like any other. So `loop` and `phase` are gone
 * from here: they are ordinary fields in the component's own section, and a second copy was the duplication
 * worth deleting.
 */

export interface TimelineHost {
  /** The keys being edited, or `null` when the selection has no keyframe parameter open. */
  keys: () => readonly Keyframe[] | null
  /** Replace them. */
  setKeys: (keys: readonly Keyframe[]) => void
  /** Whether anything is selected at all — the panel has nothing to show otherwise. */
  hasSelection: () => boolean
  /** Whose keys these are: the node and the component, so the strip says what it is editing. */
  label: () => string
  /** Playhead, in milliseconds into the track. */
  time: () => number
  setTime: (ms: number) => void
  /** Preview playback: the strip's own clock, not the game's. */
  previewing: () => boolean
  setPreviewing: (on: boolean) => void
  /** The key the gizmo is editing, or `null` when it is editing the whole object. */
  activeKey: () => number | null
  setActiveKey: (index: number | null) => void
  /** The selected item's pose right now — what "+ key" records. */
  poseNow: () => Pose | null
  /** Grid to snap dragged keys and the playhead to, in ms. 0 for none. */
  snapMs: () => number
  /** Give the selection a keyframe component, for when it has none. */
  addKeyComponent: () => void
  /** The editor's one context menu (`menu.ts`), shared so two cannot be open at once. */
  menu: ContextMenu
  /** Overwrite the keys with a preset built from the item's current pose. */
  applyMovePreset: (dir: string, distance: number, periodMs: number) => void
  applySpinPreset: (dir: string, periodMs: number) => void
}

export interface Timeline {
  render: () => void
  /**
   * Move the playhead only. Called every frame while previewing and on every scrub, where a full `render`
   * would rebuild the whole strip 60 times a second and cancel the drag it was drawing.
   */
  syncHead: () => void
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (cls !== undefined) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

/** Seconds, at a tenth — the unit a person thinks in, where the data is milliseconds. */
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

/**
 * A tick spacing that gives roughly one label every 90px, from a 1/2/5 series so the numbers stay round.
 * A ruler labelled every 137ms is worse than no ruler.
 */
export const tickStep = (spanMs: number, widthPx: number): number => {
  const target = (spanMs * 90) / Math.max(1, widthPx)
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(1, target))))
  for (const mult of [1, 2, 5, 10]) {
    if (pow * mult >= target) return pow * mult
  }
  return pow * 10
}

/**
 * The visible span: the track's length plus headroom, so a key dragged off the right-hand end **extends**
 * the track instead of hitting a wall. A minimum of one second keeps a fresh one-key track from being an
 * infinitely zoomed ruler.
 */
export const visibleSpan = (durationMs: number): number => Math.max(1000, durationMs * 1.25)

export const createTimeline = (root: HTMLElement, host: TimelineHost): Timeline => {
  /** The live playhead element and the span it is placed within, so `syncHead` needs no measuring. */
  let head: { node: HTMLElement; span: number } | null = null

  /**
   * Right-click on a key: everything that happens to one key but not on a drag.
   *
   * The five easings go in a submenu. Flat, they were five of the eight entries and pushed the two that
   * actually change the track to the bottom.
   */
  const openKeyMenu = (index: number, x: number, y: number): void => {
    const keys = host.keys()
    if (keys === null) return
    const items: MenuItem[] = [
      {
        label: 'Ease out of this key',
        items: EASINGS.map((easing) => ({ label: easing, run: () => host.setKeys(setEasing(keys, index, easing)) })),
      },
      { label: 'Duplicate 1ms later (instant jump)', divider: true, run: () => host.setKeys(nudgeKey(keys, index)) },
      {
        label: 'Delete key',
        run: () => {
          host.setKeys(deleteKey(keys, index))
          host.setActiveKey(null)
        },
      },
    ]
    host.menu.open({ x, y }, items, `key at ${secs(keyRows(keys)[index]?.t ?? 0)}`)
  }

  const syncHead = (): void => {
    if (head === null) return
    head.node.style.left = `${(host.time() / head.span) * 100}%`
  }

  const render = (): void => {
    // No menu to close: the shared one dismisses itself on the press that caused this render.
    head = null
    root.replaceChildren()

    if (!host.hasSelection()) {
      root.append(el('p', 'hint', 'Select something in the viewport or the Hierarchy to animate it.'))
      return
    }

    const keys = host.keys()
    root.append(buildToolbar(keys))
    if (keys === null) {
      root.append(el('p', 'hint', 'Nothing animatable selected. Add a Track in the Inspector, or start from a preset.'))
      return
    }
    if (keys.length === 0) {
      root.append(el('p', 'hint', 'No keys yet. Pose the object and press + key, or start from a preset.'))
      return
    }
    root.append(buildStrip(keys))
  }

  /** Everything above the strip: preview, the key tools, the duration, and the two presets. */
  const buildToolbar = (keys: readonly Keyframe[] | null): HTMLElement => {
    const bar = el('div', 'tl-bar')
    bar.append(el('span', 'tl-who', host.label()))

    if (keys === null) {
      const add = el('button', 'ctl', '+ Add Track')
      add.title = 'give this object a Track component — the same thing the Inspector adds'
      add.addEventListener('click', host.addKeyComponent)
      bar.append(add, presetControls())
      return bar
    }

    const play = el('button', 'ctl')
    play.textContent = host.previewing() ? '■' : '▶'
    play.title = 'preview this track in place (the level keeps its own clock)'
    play.classList.toggle('on', host.previewing())
    play.addEventListener('click', () => host.setPreviewing(!host.previewing()))

    const addKey = el('button', 'ctl', '+ key')
    addKey.title = 'record the current pose at the playhead'
    addKey.addEventListener('click', () => {
      const pose = host.poseNow()
      if (pose === null) return
      const t = host.time()
      const next = putKey(keys, { t, position: pose.position, rotation: pose.rotation })
      host.setKeys(next)
      // Select what was just recorded, so the gizmo is immediately editing that key rather than the object.
      host.setActiveKey(sortedKeys(next).findIndex((k) => k.t === t))
    })

    const clear = el('button', 'ctl', 'Clear keys')
    clear.title = 'empty the track; the object keeps its authored transform and the component stays'
    clear.addEventListener('click', () => {
      host.setKeys([])
      host.setActiveKey(null)
    })

    // No `loop` or `phase` here: they are declared parameters of the component, edited in its own Inspector
    // section. A second copy in this bar is what made an animation feel like it lived somewhere else.
    bar.append(play, addKey, clear, el('span', 'tl-dur', `${secs(trackDuration(keys))} · ${keys.length} keys`), presetControls())
    return bar
  }

  /** The two presets, which are the only reason a direction picker still exists in this editor. */
  const presetControls = (): HTMLElement => {
    const group = el('div', 'tl-presets')
    const dir = el('select', 'ctl')
    for (const name of Object.keys(DIRS)) {
      const opt = el('option', undefined, name)
      opt.value = name
      dir.append(opt)
    }
    dir.value = '+Y'

    const amount = el('input', 'ctl num')
    amount.type = 'number'
    amount.step = '0.5'
    amount.value = '3'
    amount.title = 'travel in metres, for the move preset'

    const period = el('input', 'ctl num')
    period.type = 'number'
    period.step = '0.5'
    period.value = '4'
    period.title = 'seconds for one cycle'

    const move = el('button', 'ctl', 'Move')
    move.title = 'replace the track with an eased out-and-back — what the old move behavior did'
    move.addEventListener('click', () => host.applyMovePreset(dir.value, Number(amount.value) || 0, Math.max(50, Number(period.value) * 1000)))

    const spin = el('button', 'ctl', 'Spin')
    spin.title = 'replace the track with one full turn per cycle'
    spin.addEventListener('click', () => host.applySpinPreset(dir.value, Math.max(50, Number(period.value) * 1000)))

    group.append(el('span', 'tl-lbl', 'preset'), dir, amount, el('span', 'tl-lbl', 'm'), period, el('span', 'tl-lbl', 's'), move, spin)
    return group
  }

  /** The ruler, the key row and the playhead. */
  const buildStrip = (keys: readonly Keyframe[]): HTMLElement => {
    const strip = el('div', 'tl-strip')
    const duration = trackDuration(keys)
    const span = visibleSpan(duration)
    const rows = keyRows(keys)

    const pct = (t: number): number => (t / span) * 100

    // --- ruler
    const ruler = el('div', 'tl-ruler')
    const width = root.clientWidth || 800
    const step = tickStep(span, width)
    for (let t = 0; t <= span; t += step) {
      const tick = el('div', 'tl-tick')
      tick.style.left = `${pct(t)}%`
      tick.append(el('span', undefined, secs(t)))
      ruler.append(tick)
    }
    // Where the track actually ends, since the strip deliberately shows more than that.
    const endMark = el('div', 'tl-end')
    endMark.style.left = `${pct(duration)}%`
    endMark.title = `track ends at ${secs(duration)}`
    ruler.append(endMark)

    // --- key row, with the easing of each segment written between its two keys
    const row = el('div', 'tl-row')
    for (let i = 0; i < rows.length - 1; i++) {
      const a = rows[i]!
      const b = rows[i + 1]!
      if (b.t === a.t) continue
      const seg = el('div', 'tl-seg')
      seg.style.left = `${pct(a.t)}%`
      seg.style.width = `${pct(b.t) - pct(a.t)}%`
      const held = a.easing === 'step'
      seg.classList.toggle('step', held)
      seg.append(el('span', undefined, a.easing))
      seg.title = `click to change the curve out of the ${secs(a.t)} key`
      seg.addEventListener('click', (e) => {
        e.stopPropagation()
        const next = EASINGS[(EASINGS.indexOf(a.easing) + 1) % EASINGS.length]!
        host.setKeys(setEasing(keys, i, next))
      })
      row.append(seg)
    }

    const active = host.activeKey()
    for (const key of rows) {
      const dot = el('div', 'tl-key')
      dot.style.left = `${pct(key.t)}%`
      dot.classList.toggle('on', key.index === active)
      dot.classList.toggle('stacked', key.stacked)
      dot.classList.toggle('rot', !key.hasPosition && key.hasRotation)
      dot.title = `${secs(key.t)}${key.hasPosition ? ' · pos' : ''}${key.hasRotation ? ' · rot' : ''}`

      dot.addEventListener('pointerdown', (e) => {
        e.stopPropagation()
        if (e.button === 2) return
        host.setActiveKey(key.index)
        host.setTime(key.t)
        // Drag to retime. The index follows the key when the drag carries it past a neighbour.
        let index = key.index
        let moved = false
        const onMove = (m: PointerEvent): void => {
          const t = snapTime(timeAtPointer(m, strip, span), host.snapMs())
          if (!moved && Math.abs(t - key.t) < 1) return
          moved = true
          const next = moveKey(host.keys() ?? keys, index, t)
          index = next.index
          if (host.keys() !== null) host.setKeys(next.keys)
          host.setActiveKey(index)
          host.setTime(t)
        }
        const onUp = (): void => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      })
      dot.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        e.stopPropagation()
        openKeyMenu(key.index, e.clientX, e.clientY)
      })
      row.append(dot)
    }

    // --- playhead
    const headNode = el('div', 'tl-head')
    headNode.style.left = `${pct(host.time())}%`
    head = { node: headNode, span }
    strip.append(ruler, row, headNode)

    // Scrubbing anywhere on the strip, which is the point: motion without entering Play.
    strip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      host.setActiveKey(null)
      const scrub = (m: PointerEvent): void => host.setTime(snapTime(timeAtPointer(m, strip, span), host.snapMs()))
      scrub(e)
      const onUp = (): void => {
        window.removeEventListener('pointermove', scrub)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', scrub)
      window.addEventListener('pointerup', onUp)
    })

    return strip
  }

  return { render, syncHead }
}

/** Pointer x as a time, clamped at zero. */
const timeAtPointer = (e: PointerEvent, strip: HTMLElement, span: number): number => {
  const box = strip.getBoundingClientRect()
  const u = box.width > 0 ? (e.clientX - box.left) / box.width : 0
  return Math.max(0, u * span)
}
