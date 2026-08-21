# ADR 0051 — The Animation panel is a dope sheet, and a drag can record

Status: accepted. Rebuilds the panel ADR 0029 introduced and ADR 0037 re-aimed. The schema is unchanged;
ADR 0050 (keys are offsets, a track can be an asset) is what made this worth doing.

## Context

Kodjo's verdict on the old panel was that it was "extremely poorly implemented and poorly made". Reading it
back, the specific faults were:

- **One row for two channels.** A key carrying position and rotation was a single diamond, so there was no
  way to grab half of it — and no way to retime a spin without retiming the travel.
- **The whole track always filled the width.** `visibleSpan = max(1000, duration * 1.25)`, laid out in CSS
  percentages. No zoom, no pan, so a 20-second track with keys 100ms apart could not be looked at.
- **One selected key, ever** (`activeKey: number | null`). No box-select, no multi-drag, no copy/paste.
  Retiming a six-key sequence was six drags, each nudging times nobody meant to touch.
- **Nothing typeable.** A key's time was wherever a diamond dragged at percentage precision landed.
- **The strip was destroyed and rebuilt per edit** — which is per pointer event of a drag. That is why the
  playhead needed `syncHead` as a separate escape hatch and why the drag listeners had to be parked on
  `window` to survive their own element being deleted.
- Easing cycled on click through five values, so `linear` → `step` was four clicks; the preset bar was
  permanent chrome for something pressed once per track; and `KeyRow.at` was computed per key and read only by
  its own test.

Rebuilding this on ADR 0029's absolute keys would have kept every ceiling above it, which is why ADR 0050 came
first.

## Decision

### A row per channel

`position` and `rotation` lanes, from `channelRow`/`channelSegments`. Not per *axis*: a key holds a whole
`Vec3`, so an x-only row would draw something the schema cannot represent — and per-axis editing belongs to
the gizmo, in the viewport, which is ADR 0029's split and still the right one.

**Dragging a two-channel key on one row splits it** (`moveChannelKey`). This authors nothing new: two keys at
different times each carrying one channel is exactly what `poseAt` samples, since it filters to the channel
and then walks. The single-row panel simply had no gesture for it. Landing on a time that already has a key
**merges** instead of stacking, so a drag cannot accidentally author the instant jump `nudgeKey` exists to
author on purpose.

A channel's segments span a key on the *other* channel rather than being divided by it — again because that is
what `poseAt` interpolates, so the easing drawn is the easing applied.

### A real time axis

A view window (`startMs`, `spanMs`) positioned in **pixels**. Wheel zooms about the cursor, shift+wheel and
middle-drag pan, `Fit` frames the track. Drawing and hit-testing now share one transform, which is what makes
any of this possible: under percentages, the pointer maths and the layout were two coordinate systems that
happened to agree.

`clampStart` keeps the window over the track with a little slack each side — the slack is what lets a key be
dragged past the end to lengthen the track, which the old fixed `duration * 1.25` span provided by accident.

### Selection is a set, primary last

`keySelection: readonly number[]`, ADR 0031's convention, so everything with one subject — the gizmo, the
numeric fields, the status bar — still reads one index off the end. Box-select in the lanes, shift-click to
extend, and the viewport's path handles extend the same way.

**Scrubbing moved to the ruler.** The old panel scrubbed on a press anywhere in the strip, which is precisely
why it could never have had a marquee.

Two drag rules, and the split is deliberate:

| gesture | what moves |
| --- | --- |
| one key, on its row | that channel only, splitting a shared key — the precise edit |
| several selected | whole keys by one delta, clamped as a group — the bulk retime |

Clamping the bulk drag *as a group* matters: per-key clamping would collapse the early keys onto each other at
zero and destroy the shape.

### Record mode

Armed, a gizmo drag writes a key at the playhead instead of moving the object's rest pose.

**One channel, taken from the gizmo's own mode** (`putChannel`), not a whole pose. `putKey` would invent a
rotation key the moment you nudged a platform sideways, and a one-key rotation channel is a *frozen* spin
rather than an absent one. A fresh key inherits the easing in force where it lands, so recording inside an
eased segment adds detail instead of flattening it.

Scale falls through to the transform, armed or not, because scale is not animatable (ADR 0029).

Two guards, both because the playhead is where a key lands: arming stops preview playback, and changing the
selection disarms. Armed Record surviving a selection change would write keys onto the next object dragged.

**An empty track records.** `writeBackItem` routes to the track when it has keys *or* when armed — requiring a
key before you can record one is a chicken-and-egg the old code would have had.

### One seam for every key write

`writeKeys(index, editor, keys)` routes to the node's clip if it plays one, else to the component's parameter.
Every path goes through it: the panel, the gizmo dragging a key, Record mode. Routing only some of them would
let a gizmo drag write *inline* keys onto a node playing a clip — which ADR 0050's precedence would then
honour, silently overriding the clip for that one object. `keysOfItem` is clip-aware for the mirror reason.

Which sibling parameter holds the clip comes from the `keys` **declaration** (`KeysSpec.clip`, surfaced as
`KeyEditor.clipParam`). Reaching for a field called `clip` by name would have undone ADR 0037, whose whole
point is that the panel edits a declared parameter and does not know what a `Track` is.

### Clips are editable, and say so

The panel shows a `clip: name` tag when the keys live in an asset, because an edit there reaches every object
playing it. `Save as clip` lifts inline keys into a new asset and **empties the inline ones in the same edit**,
so the precedence rule never has to arbitrate something authored by accident. `Unlink` copies them back and
clears the reference.

Writes are debounced: in memory at once so the viewport follows, on disk 400ms after the last edit, because
the panel calls `setKeys` per pointer event and a PUT per event would flood the dev server.

## Consequences

- **A clip edit is not undoable.** `history.ts` snapshots the document, and an asset file is not in it. This
  is exactly how material edits already behave, so it is consistent rather than novel — but it is a real
  limitation and the panel names the clip so it is never a surprise.
- The numeric row skips its rebuild while one of its inputs has focus, or committing a typed value would
  replace the field being typed in. The Inspector guards its name field the same way.
- `render` still runs per pointer event during a drag, and that is fine: it replaces the diamonds in two lanes,
  not the panel. What it no longer touches is the shell — toolbar, gutter, lanes, ruler, playhead, marquee and
  the end marker are created once. The end marker was the one thing this got wrong first: created per render
  and appended, it leaked an element per edit until it was moved into the shell.
- A `ResizeObserver` on the lanes, not a `window` resize listener: the panel sits in a hand-rolled splitter
  (ADR 0024), so dragging the divider resizes it without the window changing at all.
- Deleted with the rewrite: `keyRows` (and its dead `at` field), `keyNear` and `dirNameOf` — the last two had
  no production callers, hit-testing being DOM elements now and the direction picker having outlived the
  behaviour form it was written for. `moveKey`/`deleteKey`/`setEasing` became the plural, channel-aware forms.
- Presets moved from permanent chrome into the `⋯` menu, alongside copy/paste/delete/easing and the clip
  actions — one menu, `menu.ts`, so the panel gained no bespoke popup (ADR 0040).
- `trackEdit.ts` is 16 pure functions with 55 tests. The panel is hit-testing and pixels, which is what makes
  splitting a shared key, clamping a group drag and rebasing a paste testable without a DOM.

## Rejected

**A curve editor** (value against time, bezier handles). Rejected again, and now for a second reason on top of
ADR 0029's: `Easing` is a named string, so handles would need per-key in/out tangents — a schema change. The
first reason still stands: space is edited in the viewport, so a graph per axis would mean typing numbers into
three of them to move a platform sideways.

**Several movers stacked in one view**, so a jump sequence could be timed against itself. Genuinely useful for
parkour, and Kodjo chose one object first: the selected object's panel is what was broken, and stacking is
additive later with no data-model change. `phaseMs` already staggers a row of pistons without a shared view.

**Keeping the explicit `+ key` as the only way to author.** It is still there, and still what you want for
recording a whole pose at once. But every key costing a trip to a button is the reason authoring felt slow.

**Per-axis rows.** The schema keys a whole `Vec3`; three rows would promise independence it cannot deliver.

**Canvas rendering.** Tens of keys, so DOM elements cost nothing and bring hit-testing, hover and titles for
free. Worth revisiting only if a stacked multi-object view ever lands.
