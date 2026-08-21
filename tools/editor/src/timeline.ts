import type { Keyframe, Pose } from '@mp/content'

import {
  CHANNELS,
  DIRS,
  EASINGS,
  channelRow,
  channelSegments,
  copyKeys,
  deleteKeys,
  moveChannelKey,
  moveKeys,
  nudgeKey,
  pasteKeys,
  putKey,
  setEasingOn,
  setKeyPose,
  snapTime,
  sortedKeys,
  trackDuration,
  type Channel,
} from './trackEdit'
import type { ContextMenu, MenuItem } from './menu'

/**
 * The Animation panel: a dope sheet (ADR 0029 for the schema, ADR 0051 for this panel).
 *
 * Time lives here and space lives in the viewport. That split is the reason there is no curve editor — a curve
 * editor unifies them into one graph per channel, which is the right tool for character animation and the
 * wrong one for "this platform rises three metres and pauses", where nudging a platform sideways would mean
 * typing numbers into three graphs. So: rows of diamonds for *when*, the transform gizmo for *where*.
 *
 * **A row per channel.** A key carrying position and rotation used to be a single diamond with no way to grab
 * half of it. Dragging one on its own row splits it (`moveChannelKey`), which the schema always allowed and
 * the single-row panel simply could not express.
 *
 * **A real time axis.** A view window in milliseconds, positioned in pixels, so drawing and hit-testing share
 * one transform and zooming is possible at all. The old strip laid keys out in CSS percentages of a span fixed
 * at `duration * 1.25`, so the whole track always filled the width and nothing could be looked at closely.
 *
 * **The shell is built once.** Toolbar, gutter, lanes, ruler, playhead and marquee are created here and never
 * recreated; `render` replaces only the diamonds and segments inside the lanes, `layout` repositions them
 * without touching the tree, and `syncHead` moves the playhead alone, sixty times a second. The old panel
 * called `replaceChildren` on the whole strip for every edit, which is why the playhead needed a separate
 * escape hatch to avoid cancelling the drag it was drawing.
 *
 * **It edits one component's `keys` parameter**, or the animation clip that component names (ADR 0050/0051),
 * whichever the host hands it. `loop` and `phase` are not here: they are declared parameters of the component,
 * edited in its own Inspector section, and a second copy was the duplication worth deleting (ADR 0037).
 */

export interface TimelineHost {
  /** The keys being edited, or `null` when the selection has no keyframe parameter open. */
  keys: () => readonly Keyframe[] | null
  /** Replace them. */
  setKeys: (keys: readonly Keyframe[]) => void
  /** Whether anything is selected at all — the panel has nothing to show otherwise. */
  hasSelection: () => boolean
  /** Whose keys these are: the node and the component, so the panel says what it is editing. */
  label: () => string
  /**
   * The clip these keys live in, when the open component names one (ADR 0050).
   *
   * `null` means the keys are the component's own. The panel says which, because editing a clip changes every
   * object playing it and that must not be a surprise.
   */
  clip: () => { id: string; name: string } | null
  /** Lift the open inline keys into a new clip asset and point the component at it. */
  saveAsClip: () => void
  /** Copy the clip's keys back inline and clear the reference, leaving this object on its own. */
  unlinkClip: () => void
  /** Playhead, in milliseconds into the track. */
  time: () => number
  setTime: (ms: number) => void
  /** Preview playback: the panel's own clock, not the game's. */
  previewing: () => boolean
  setPreviewing: (on: boolean) => void
  /**
   * Armed to record: a gizmo drag writes a key at the playhead on the channel it touched (ADR 0051).
   *
   * The panel owns the button and nothing else — the write happens where the drag is handled, since only that
   * code knows which channel moved.
   */
  recording: () => boolean
  setRecording: (on: boolean) => void
  /** Selected keys, as indices into the sorted array, **primary last** — the ADR 0031 convention. */
  selection: () => readonly number[]
  setSelection: (indices: readonly number[]) => void
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
  /** The track's shape changed — rebuild the rows. */
  render: () => void
  /**
   * Move the playhead only. Called every frame while previewing and on every scrub, where a full `render`
   * would rebuild the rows sixty times a second for a picture that is identical.
   */
  syncHead: () => void
}

/** Narrowest and widest the view may get, in milliseconds across the panel. */
const MIN_SPAN = 40
const MAX_SPAN = 600_000

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (cls !== undefined) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

/** Seconds, at a tenth — the unit a person thinks in, where the data is milliseconds. */
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

/**
 * A tick spacing that gives roughly one label every 90px, from a 1/2/5 series so the numbers stay round. A
 * ruler labelled every 137ms is worse than no ruler.
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
 * The window a fresh track opens at: its length plus headroom, so a key dragged off the right-hand end
 * **extends** the track instead of hitting a wall. A minimum of one second keeps a one-key track from being an
 * infinitely zoomed ruler.
 */
export const fitSpan = (durationMs: number): number => Math.max(1000, durationMs * 1.25)

/** Keep the window over the track: a little slack each side, never so far out that the keys leave the panel. */
export const clampStart = (startMs: number, spanMs: number, durationMs: number): number => {
  const slack = spanMs * 0.05
  return Math.max(-slack, Math.min(startMs, Math.max(0, durationMs) + slack))
}

export const createTimeline = (root: HTMLElement, host: TimelineHost): Timeline => {
  /** The visible window. Persists across selections, so scrubbing between two objects keeps your zoom. */
  const view = { startMs: 0, spanMs: 4000 }
  /** Keys lifted by Copy, rebased to 0. Survives a selection change, like any clipboard. */
  let clipboard: readonly Keyframe[] = []

  // ---- the shell, built once ---------------------------------------------------------------------------
  const bar = el('div', 'tl-bar')
  const body = el('div', 'tl-body')
  const gutter = el('div', 'tl-gutter')
  const lanes = el('div', 'tl-lanes')
  const ruler = el('div', 'tl-ruler')
  const head = el('div', 'tl-head')
  const marquee = el('div', 'tl-marquee')
  /** Where the track ends, since the view deliberately shows more than that. Part of the shell, not redrawn. */
  const endMark = el('div', 'tl-end')
  const fields = el('div', 'tl-fields')
  const hint = el('p', 'hint')
  marquee.hidden = true
  head.hidden = true
  lanes.append(ruler, head, endMark, marquee)
  body.append(gutter, lanes)
  root.append(bar, hint, body, fields)

  /** One per channel, in `CHANNELS` order. Created once; their contents are what `render` replaces. */
  const laneOf = new Map<Channel, HTMLElement>()
  for (const channel of CHANNELS) {
    const label = el('div', 'tl-name', channel)
    label.title = `${channel} keys — drag one to retime just this channel`
    gutter.append(label)
    const lane = el('div', 'tl-lane')
    lane.dataset.channel = channel
    lanes.append(lane)
    laneOf.set(channel, lane)
  }

  /** Every drawn key, so `layout` can reposition without touching the DOM tree. */
  let drawn: { node: HTMLElement; channel: Channel; index: number; t: number }[] = []
  let drawnSegments: { node: HTMLElement; fromMs: number; toMs: number }[] = []

  const width = (): number => Math.max(1, lanes.clientWidth)
  const pxPerMs = (): number => width() / view.spanMs
  const xOf = (t: number): number => (t - view.startMs) * pxPerMs()
  const tOf = (x: number): number => view.startMs + x / pxPerMs()
  const timeAtClientX = (clientX: number): number => tOf(clientX - lanes.getBoundingClientRect().left)

  const duration = (): number => {
    const keys = host.keys()
    return keys === null ? 0 : trackDuration(keys)
  }

  const fitView = (): void => {
    view.spanMs = fitSpan(duration())
    view.startMs = clampStart(0, view.spanMs, duration())
    layout()
  }

  // ---- layout: pixels from the view, no DOM churn ------------------------------------------------------
  const layout = (): void => {
    const span = duration()

    ruler.replaceChildren()
    const step = tickStep(view.spanMs, width())
    const first = Math.ceil(view.startMs / step) * step
    for (let t = first; t <= view.startMs + view.spanMs; t += step) {
      const tick = el('div', 'tl-tick')
      tick.style.left = `${xOf(t)}px`
      tick.append(el('span', undefined, secs(t)))
      ruler.append(tick)
    }
    endMark.style.left = `${xOf(span)}px`

    for (const k of drawn) k.node.style.left = `${xOf(k.t)}px`
    for (const s of drawnSegments) {
      const from = xOf(s.fromMs)
      s.node.style.left = `${from}px`
      s.node.style.width = `${Math.max(0, xOf(s.toMs) - from)}px`
    }
    syncHead()
  }

  const syncHead = (): void => {
    const keys = host.keys()
    head.hidden = keys === null
    if (keys === null) return
    head.style.left = `${xOf(host.time())}px`
  }

  // ---- selection helpers ------------------------------------------------------------------------------
  const selected = (): Set<number> => new Set(host.selection())
  const primary = (): number | null => {
    const sel = host.selection()
    return sel.length === 0 ? null : (sel[sel.length - 1] ?? null)
  }

  /** Add to, remove from, or replace the selection — the modifier rules the Hierarchy uses (ADR 0031). */
  const pick = (index: number, additive: boolean): void => {
    if (!additive) {
      host.setSelection([index])
      return
    }
    const sel = host.selection().filter((i) => i !== index)
    // Primary last, so the numeric fields and the gizmo follow the key you just touched.
    host.setSelection(host.selection().includes(index) ? sel : [...sel, index])
  }

  // ---- the toolbar ------------------------------------------------------------------------------------
  const buildBar = (keys: readonly Keyframe[] | null): void => {
    bar.replaceChildren()
    const who = el('span', 'tl-who', host.label())
    who.title = host.label()
    bar.append(who)

    const clip = host.clip()
    if (clip !== null) {
      const tag = el('span', 'tl-clip', `clip: ${clip.name}`)
      tag.title = `these keys live in an animation asset — every object playing "${clip.name}" changes with them`
      bar.append(tag)
    }

    if (keys === null) {
      const add = el('button', 'ctl', '+ Add Track')
      add.title = 'give this object a Track component — the same thing the Inspector adds'
      add.addEventListener('click', host.addKeyComponent)
      bar.append(add, presetControls())
      return
    }

    const rec = el('button', 'ctl rec')
    rec.textContent = '● REC'
    rec.title = 'armed: moving the object with the gizmo writes a key at the playhead, on the channel you moved'
    rec.classList.toggle('on', host.recording())
    rec.addEventListener('click', () => host.setRecording(!host.recording()))

    const play = el('button', 'ctl')
    play.textContent = host.previewing() ? '■' : '▶'
    play.title = 'preview this track in place (the level keeps its own clock)'
    play.classList.toggle('on', host.previewing())
    play.addEventListener('click', () => host.setPreviewing(!host.previewing()))

    const addKey = el('button', 'ctl', '+ key')
    addKey.title = 'record the current pose at the playhead, both channels'
    addKey.addEventListener('click', addKeyAtHead)

    const fit = el('button', 'ctl', 'Fit')
    fit.title = 'zoom the view to the whole track (wheel zooms, shift+wheel pans)'
    fit.addEventListener('click', fitView)

    const more = el('button', 'ctl', '⋯')
    more.title = 'presets, clip actions, and what to do with the selected keys'
    more.addEventListener('click', () => {
      const box = more.getBoundingClientRect()
      host.menu.open({ x: box.left, y: box.bottom }, trackMenu(), 'track')
    })

    bar.append(rec, play, addKey, fit, el('span', 'tl-dur', `${secs(trackDuration(keys))} · ${keys.length} keys`), more, presetControls())
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

  // ---- edits -----------------------------------------------------------------------------------------
  const addKeyAtHead = (): void => {
    const keys = host.keys()
    const pose = host.poseNow()
    if (keys === null || pose === null) return
    const t = host.time()
    const next = putKey(keys, { t, position: pose.position, rotation: pose.rotation })
    host.setKeys(next)
    // Select what was just recorded, so the gizmo is immediately editing that key rather than the object.
    host.setSelection([sortedKeys(next).findIndex((k) => k.t === t)])
  }

  const deleteSelected = (): void => {
    const keys = host.keys()
    const sel = host.selection()
    if (keys === null || sel.length === 0) return
    host.setKeys(deleteKeys(keys, sel))
    host.setSelection([])
  }

  const copySelected = (): void => {
    const keys = host.keys()
    if (keys === null) return
    clipboard = copyKeys(keys, host.selection())
  }

  const pasteAtHead = (): void => {
    const keys = host.keys()
    if (keys === null || clipboard.length === 0) return
    const next = pasteKeys(keys, clipboard, host.time())
    host.setKeys(next.keys)
    host.setSelection(next.indices)
  }

  /** Everything that acts on the track or the selected keys, in one menu rather than a row of buttons. */
  const trackMenu = (): MenuItem[] => {
    const keys = host.keys()
    const sel = host.selection()
    const clip = host.clip()
    const many = sel.length > 1 ? ` (${sel.length})` : ''
    return [
      {
        label: `Ease out of selected key${many}`,
        enabled: sel.length > 0,
        why: 'select a key first',
        items: EASINGS.map((easing) => ({ label: easing, run: () => keys !== null && host.setKeys(setEasingOn(keys, sel, easing)) })),
      },
      { label: `Copy key${many}`, enabled: sel.length > 0, why: 'select a key first', run: copySelected },
      { label: 'Paste at playhead', enabled: clipboard.length > 0, why: 'nothing copied', run: pasteAtHead },
      {
        label: 'Duplicate 1ms later (instant jump)',
        enabled: sel.length === 1,
        why: sel.length === 0 ? 'select a key first' : 'one key at a time',
        run: () => {
          const at = primary()
          if (keys !== null && at !== null) host.setKeys(nudgeKey(keys, at))
        },
      },
      { label: `Delete key${many}`, divider: true, enabled: sel.length > 0, why: 'select a key first', run: deleteSelected },
      {
        label: 'Clear all keys',
        enabled: keys !== null && keys.length > 0,
        why: 'already empty',
        run: () => {
          host.setKeys([])
          host.setSelection([])
        },
      },
      clip === null
        ? {
            label: 'Save as clip…',
            divider: true,
            enabled: keys !== null && keys.length > 0,
            why: 'nothing to save',
            run: host.saveAsClip,
          }
        : { label: `Unlink from ${clip.name}`, divider: true, run: host.unlinkClip },
    ]
  }

  // ---- rows ------------------------------------------------------------------------------------------
  const buildLane = (channel: Channel, keys: readonly Keyframe[]): void => {
    const lane = laneOf.get(channel)!
    lane.replaceChildren()

    for (const seg of channelSegments(keys, channel)) {
      const node = el('div', 'tl-seg')
      node.classList.toggle('step', seg.easing === 'step')
      node.append(el('span', undefined, seg.easing))
      node.title = `click to change the curve out of the ${secs(seg.fromMs)} key`
      node.addEventListener('click', (e) => {
        e.stopPropagation()
        const next = EASINGS[(EASINGS.indexOf(seg.easing) + 1) % EASINGS.length]!
        host.setKeys(setEasingOn(keys, [seg.index], next))
      })
      lane.append(node)
      drawnSegments.push({ node, fromMs: seg.fromMs, toMs: seg.toMs })
    }

    const sel = selected()
    for (const key of channelRow(keys, channel)) {
      const dot = el('div', 'tl-key')
      dot.classList.toggle('on', sel.has(key.index))
      dot.classList.toggle('stacked', key.stacked)
      dot.classList.toggle('shared', key.shared)
      dot.title = `${secs(key.t)} · ${channel}${key.shared ? ' (also keys the other channel — dragging splits it)' : ''}`
      dot.addEventListener('pointerdown', (e) => beginKeyDrag(e, channel, key.index, key.t))
      dot.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        e.stopPropagation()
        if (!selected().has(key.index)) host.setSelection([key.index])
        host.menu.open({ x: e.clientX, y: e.clientY }, trackMenu(), `key at ${secs(key.t)}`)
      })
      lane.append(dot)
      drawn.push({ node: dot, channel, index: key.index, t: key.t })
    }
  }

  const render = (): void => {
    drawn = []
    drawnSegments = []
    endMark.hidden = true

    const has = host.hasSelection()
    const keys = has ? host.keys() : null
    body.hidden = !has || keys === null || keys.length === 0
    fields.hidden = body.hidden

    if (!has) {
      bar.replaceChildren()
      hint.hidden = false
      hint.textContent = 'Select something in the viewport or the Hierarchy to animate it.'
      for (const lane of laneOf.values()) lane.replaceChildren()
      return
    }

    buildBar(keys)
    hint.hidden = keys !== null && keys.length > 0
    if (keys === null) hint.textContent = 'Nothing animatable selected. Add a Track in the Inspector, or start from a preset.'
    else if (keys.length === 0) hint.textContent = 'No keys yet. Arm REC and move the object, press + key, or start from a preset.'

    if (keys === null || keys.length === 0) {
      for (const lane of laneOf.values()) lane.replaceChildren()
      return
    }

    endMark.hidden = false
    endMark.title = `track ends at ${secs(trackDuration(keys))}`

    for (const channel of CHANNELS) buildLane(channel, keys)
    buildFields(keys)
    layout()
  }

  // ---- the numeric row -------------------------------------------------------------------------------
  /**
   * Typed values for the primary selected key.
   *
   * The panel had nothing typeable at all: a key's time was whatever a diamond dragged at percentage
   * precision landed on. Rotation is in **degrees** here, matching the Inspector, because radians are the
   * storage format and degrees are what a person types.
   */
  const buildFields = (keys: readonly Keyframe[]): void => {
    // Not while one of these has focus: committing a typed value re-renders, and replacing the input the
    // person is still in would eat the next keystroke. The Inspector guards its name field the same way.
    if (fields.contains(document.activeElement)) return
    fields.replaceChildren()
    const at = primary()
    const sorted = sortedKeys(keys)
    const key = at === null ? undefined : sorted[at]
    if (at === null || key === undefined) {
      fields.append(el('span', 'tl-lbl', 'no key selected — click a diamond, or drag a box over several'))
      return
    }

    const num = (value: number, step: number, onCommit: (v: number) => void): HTMLInputElement => {
      const input = el('input', 'ctl num')
      input.type = 'number'
      input.step = String(step)
      input.value = String(Math.round(value * 1e4) / 1e4)
      input.addEventListener('change', () => {
        const v = Number(input.value)
        if (Number.isFinite(v)) onCommit(v)
      })
      return input
    }

    fields.append(el('span', 'tl-lbl', `key ${at + 1}/${sorted.length}`))
    fields.append(el('span', 'tl-lbl', 't'))
    fields.append(
      num(key.t, 50, (v) => {
        const next = moveKeys(keys, [at], Math.max(0, v) - key.t)
        host.setKeys(next.keys)
        host.setSelection(next.indices)
      }),
    )

    const axes = ['x', 'y', 'z'] as const
    if (key.position !== undefined) {
      const p = key.position
      fields.append(el('span', 'tl-lbl', 'pos'))
      for (const ax of axes) {
        fields.append(num(p[ax], 0.1, (v) => host.setKeys(setKeyPose(keys, at, { position: { ...p, [ax]: v } }))))
      }
    }
    if (key.rotation !== undefined) {
      const r = key.rotation
      fields.append(el('span', 'tl-lbl', 'rot°'))
      for (const ax of axes) {
        fields.append(
          num((r[ax] * 180) / Math.PI, 5, (v) => host.setKeys(setKeyPose(keys, at, { rotation: { ...r, [ax]: (v * Math.PI) / 180 } }))),
        )
      }
    }

    const easing = el('select', 'ctl')
    for (const name of EASINGS) {
      const opt = el('option', undefined, name)
      opt.value = name
      easing.append(opt)
    }
    easing.value = key.easing ?? 'linear'
    easing.title = host.selection().length > 1 ? 'the curve leaving every selected key' : 'the curve leaving this key'
    easing.addEventListener('change', () => host.setKeys(setEasingOn(keys, host.selection(), easing.value as (typeof EASINGS)[number])))
    fields.append(el('span', 'tl-lbl', 'ease'), easing)
  }

  // ---- gestures --------------------------------------------------------------------------------------
  /**
   * Drag a key in time.
   *
   * One selected key moves **its own channel**, splitting a key that carries both. Several move as whole keys,
   * because a bulk drag is about shifting a passage of time and a selection can span both rows (see
   * `moveChannelKey` and `moveKeys`).
   */
  const beginKeyDrag = (e: PointerEvent, channel: Channel, index: number, t0: number): void => {
    e.stopPropagation()
    if (e.button !== 0) return
    pick(index, e.shiftKey || e.ctrlKey)
    host.setTime(t0)

    let at = index
    let moved = false
    const onMove = (m: PointerEvent): void => {
      const keys = host.keys()
      if (keys === null) return
      const target = snapTime(timeAtClientX(m.clientX), host.snapMs())
      if (!moved && Math.abs(target - t0) * pxPerMs() < 3) return
      moved = true
      const sel = host.selection()
      if (sel.length > 1) {
        const now = sortedKeys(keys)[at]
        const seat = sel.indexOf(at)
        if (now === undefined || seat < 0) return
        const shifted = moveKeys(keys, sel, target - now.t)
        host.setKeys(shifted.keys)
        host.setSelection(shifted.indices)
        // `moveKeys` returns the new indices in the order it was given, so the dragged key keeps its seat —
        // reading the last one instead would start tracking whichever key happened to end up latest.
        at = shifted.indices[seat] ?? at
      } else {
        const shifted = moveChannelKey(keys, at, channel, target)
        at = shifted.index
        host.setKeys(shifted.keys)
        host.setSelection([at])
      }
      host.setTime(target)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  /**
   * Scrubbing is on the **ruler**, box-select is in the lanes.
   *
   * The old panel scrubbed on a press anywhere in the strip, which is why it could never have had a marquee.
   */
  ruler.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || host.keys() === null) return
    e.stopPropagation()
    const scrub = (m: PointerEvent): void => host.setTime(Math.max(0, snapTime(timeAtClientX(m.clientX), host.snapMs())))
    scrub(e)
    const onUp = (): void => {
      window.removeEventListener('pointermove', scrub)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', scrub)
    window.addEventListener('pointerup', onUp)
  })

  /** Box-select. Vertical extent matters: a marquee over one lane selects only that channel's keys. */
  lanes.addEventListener('pointerdown', (e) => {
    if (host.keys() === null) return
    if (e.button === 1) {
      beginPan(e)
      return
    }
    if (e.button !== 0) return
    const box = lanes.getBoundingClientRect()
    const from = { x: e.clientX - box.left, y: e.clientY - box.top }
    let dragging = false

    const onMove = (m: PointerEvent): void => {
      const to = { x: m.clientX - box.left, y: m.clientY - box.top }
      if (!dragging && Math.abs(to.x - from.x) < 3 && Math.abs(to.y - from.y) < 3) return
      dragging = true
      marquee.hidden = false
      marquee.style.left = `${Math.min(from.x, to.x)}px`
      marquee.style.top = `${Math.min(from.y, to.y)}px`
      marquee.style.width = `${Math.abs(to.x - from.x)}px`
      marquee.style.height = `${Math.abs(to.y - from.y)}px`

      const lo = Math.min(from.x, to.x)
      const hi = Math.max(from.x, to.x)
      const top = Math.min(from.y, to.y)
      const bottom = Math.max(from.y, to.y)
      const hits: number[] = []
      for (const k of drawn) {
        const x = xOf(k.t)
        if (x < lo || x > hi) continue
        const r = k.node.getBoundingClientRect()
        const ky = r.top + r.height / 2 - box.top
        if (ky < top || ky > bottom) continue
        if (!hits.includes(k.index)) hits.push(k.index)
      }
      host.setSelection(hits)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      marquee.hidden = true
      // A press with no drag is "deselect", which is what clicking empty space should mean.
      if (!dragging) host.setSelection([])
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  })

  const beginPan = (e: PointerEvent): void => {
    e.preventDefault()
    const from = e.clientX
    const start = view.startMs
    const onMove = (m: PointerEvent): void => {
      view.startMs = clampStart(start - (m.clientX - from) / pxPerMs(), view.spanMs, duration())
      layout()
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  /** Wheel zooms about the cursor; shift+wheel pans. The panel does not scroll, so nothing is being stolen. */
  lanes.addEventListener(
    'wheel',
    (e) => {
      if (host.keys() === null) return
      e.preventDefault()
      if (e.shiftKey) {
        view.startMs = clampStart(view.startMs + (e.deltaY / pxPerMs()) * 0.5, view.spanMs, duration())
        layout()
        return
      }
      const anchor = timeAtClientX(e.clientX)
      const offsetPx = e.clientX - lanes.getBoundingClientRect().left
      const next = Math.max(MIN_SPAN, Math.min(MAX_SPAN, view.spanMs * (e.deltaY > 0 ? 1.15 : 1 / 1.15)))
      view.spanMs = next
      // Keep the instant under the cursor under the cursor, which is what makes zoom feel like a lens.
      view.startMs = clampStart(anchor - offsetPx / (width() / next), next, duration())
      layout()
    },
    { passive: false },
  )

  /**
   * The panel lives inside a hand-rolled splitter (`splitter.ts`), so dragging the divider resizes these
   * lanes without the window changing size at all — a `resize` listener would miss every one of those.
   */
  new ResizeObserver(() => layout()).observe(lanes)

  return { render, syncHead }
}
