# ADR 0038 — The Inspector's chrome is ours; Tweakpane keeps the value widgets

Status: accepted, amended: the value widgets are ours too, and Tweakpane has left the editor ([ADR 0152](0152-the-inspector-is-cards-of-our-own-fields.md)); the header, the menu and the kept state stand. Narrows ADR 0024 (which put Tweakpane in the Inspector) now that the panel lists components
rather than a fixed set of fields.

## Context

Kodjo, after using the component system: *"it's serviceable and I can use it, but it's very hard to read, hard
to edit."*

Counted before changing anything. The simplest possible object (Collider + Visual) rendered **18 rows**. The
trampoline pad — Collider, Visual, Bumper, Track, seen through a placement — rendered **30**, about 600px of
content in a 300px-wide column. Of those 30, **8 were per-component chrome**: four `enabled` checkbox rows and
four `Remove` buttons, 27% of the panel spent on furniture that Unity puts in a title bar and a context menu.

Every one of those was a consequence of one thing: **Tweakpane's folder is a title string and a stack of
full-width rows.** It has no header slot, so component state had to be spelled into the title
(`Track (added here) — off`), which a 300px column truncates. It has nowhere to put a checkbox or a menu, so
both became rows. And it cannot remember whether it was open, so every rebuild re-expanded everything.

Five more defects found in the same pass:

- **A field that did nothing was shown as if it did.** The panel looped over *every* declared parameter, so a
  `Visual` drawing its colliders still showed an editable `model` dropdown. The enum handler even carried a
  comment claiming it rebuilt because "an enum can gate other fields" — nothing gated anything.
- **Every rebuild jumped the panel to the top.** A rebuild happens on every enum change.
- **Per-component revert existed and was unreachable.** `Doc.revert(i, field)` takes a component id; the panel
  only ever called it with no argument, so overriding one number left "throw away everything" as the only undo.
- **Four disabled text inputs pretended to be fields.** Tweakpane's `view: 'text'` monitor draws a bordered
  input box: the override list, a key count, a hull's point count and the unknown-component warning all looked
  editable.
- **A multi-selection was invisible.** Select three objects and the panel silently showed one; only the status
  bar said otherwise.

## Choice

**Our chrome, their widgets.** Tweakpane is genuinely good at one thing — a labelled number you drag to scrub,
and its three-axis Vec3 row — and that is what it keeps. Everything structural is ours:

- **A section per component**, with a header row we draw: twist, `enabled` checkbox, name, badge, `⋯` menu.
  That is the 8 chrome rows recovered outright.
- **The badge replaces title-string state.** `added`, or the number of overridden parameters. It cannot push
  the component's name out of the header the way appended text did.
- **The `⋯` menu** holds Remove, Move up / Move down, and *either* Reset to defaults *or* Revert to prefab —
  never both, because they are the same gesture pointed at different baselines and only one applies. On an
  inherited component, "reset to defaults" would **write** an override for every parameter, which is the
  opposite of what anybody reaching for it wants.
- **Collapse state and scroll position live here**, not inside a widget library. Collapsing `Collider` to work
  on a `Bumper` means it for the session, not until the next dropdown change. Keyed by component id, so two
  colliders on one node collapse independently.
- **Transform is a section** like the rest. It used to be three rows floating above everything with no owner.
- **One `Add Component` button** opening a list, where a dropdown plus a button cost two rows and two clicks.
- **The override strip moved to the top**, under the header, where it describes what follows instead of
  summarising it twenty rows later. Object-level Duplicate and Delete moved to a compact footer.

**A parameter can declare when it is relevant.** `ParamWhen` (`{ param, is }`) on any spec, and
`visibleParams(decls, values)` in `@mp/components` decides what to draw. `Visual.model` declares
`when: { param: 'source', is: ['model'] }`, so it appears only when this Visual draws a mesh. Hiding is
presentation only: the value is still stored, still validated, still there when you switch back.

**Overridden rows get a bar down their left edge** — Unity's cue — via a class added to `BladeApi.element`.
That is Tweakpane's own public accessor for the row it built, not a reach into its internals. It replaced a `•`
prefixed onto the label, which ate label width and was easy to miss. The section gets the same bar, so it reads
while scrolling.

**Read-only lines are ours**, a label and a value with no border. Nothing in the panel now looks editable
without being editable.

**`sync` refreshes only the transform pane.** Each section owns its own small pane, and nothing a gizmo drag
does touches a component's values — so the per-frame refresh no longer walks bindings it cannot affect, and
cannot fire their handlers.

## Consequences

- **18 rows became 12** for the simplest object, and **30 became 18** for the trampoline pad. Zero of them are
  `enabled` checkboxes or `Remove` buttons.
- **A section hands out a *lazy* pane.** Tweakpane appends inside one element, so a row of ours emitted after a
  pane would land after everything that pane ever holds. `pane()` returns the current one and `row()` retires
  it, so a `Track` comes out as `keys` (ours) then `loop`/`phase` (Tweakpane's) — declaration order.
- **Component order is now authorable** (`Doc.moveComponent`), which matters: it is the order hooks run in
  (ADR 0036) and the order several colliders draw in. Refused on an inherited node, like every other structural
  edit — the list belongs to the prefab.
- **The scroller is the panel's body**, not `#inspector`. Making our container a second scroller would nest two.
- **More panes, not one.** One Tweakpane instance per section run. They are disposed together on rebuild.
- **A `keys` row is ours**, so the timeline button sits on the same line as the count instead of below it.

## Rejected

**Deleting Tweakpane from the Inspector entirely.** Total control and one visual language, at the cost of
rebuilding drag-scrub number inputs and a three-axis Vec3 row that already work. Kodjo picked the hybrid when
asked. The seam is now inside a section body, where it does not read as two designs.

**Moving the timeline into the Inspector** — already rejected in ADR 0037, for the same reason a timeline is a
horizontal instrument.

**Marking overrides by styling the label text.** Tweakpane renders the label; targeting one row's label meant
either a per-row class anyway or a `:has()` selector over its internals. A bar on the row is the same
information, and the class goes on the element Tweakpane hands out.

**A search box over parameters.** Unity has one and it earns its place at Unity's component counts. Nine
component types and at most four on a node is not that, and it would be a row on every object to save scrolling
on none.
