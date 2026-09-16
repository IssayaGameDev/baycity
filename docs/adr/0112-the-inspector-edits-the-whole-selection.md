# ADR 0112 — The Inspector edits the whole selection

Status: accepted. Settles the asymmetry [ADR 0031](0031-multi-selection-with-a-primary.md) shipped knowingly,
and takes back its "the Inspector edits the primary only" consequence.

## Context

Kodjo: *"currently there's no multi object editing, meaning if you have multiple objects selected in the
Hierarchy you can't edit components they have in common at once like you can in Unity."*

Half of multi-selection already worked. A gizmo drag moved every selected object; delete, duplicate, copy and
cut took the whole selection. The Inspector did not — and neither did **typing** a transform, so dragging
three platforms moved three and typing a position moved one. ADR 0031 named that asymmetry and named the
blocker too: *"applying every property to every selected item needs a mixed-value display to be honest about
what it is about to overwrite."*

Unity's rules, which Kodjo asked for: show the components they all have, blank a field whose value differs,
write an edit to all of them, and add a component to all of them.

## Decision

**Show the intersection.** A component is offered only when every selected node has it, paired up by **type
and ordinal** (`peersOf`) — the nth `Collider` with the nth `Collider`. Ids cannot do the pairing, because
`addComponent` mints them per component, and the type alone cannot either, because a node may carry two.

A component only some of them have is **hidden**, Kodjo's call and Unity's. The alternative — show it and
decide what a write means for a node without it — is a decision with no good answer.

**Blank what differs.** A parameter the selection disagrees about is drawn empty with a `—` placeholder, and
an untouched control writes nothing. Vec3 and the transform are per **axis**: position may be blank on X and
show a number on Y.

**One write reaches all of them, once.** `Doc.setParamsAcross(targets, patch)` concatenates each node's ops
and commits them in a single batch, so it stays one undo entry and one message to the room. `patchParams` was
split into `paramOpsFor` + a commit to make that possible; the single-node path is unchanged.

Reset to defaults, Remove and the enable checkbox reach every selected node too, and the menu labels say how
many. Add Component offers anything **any** of them can take and adds it to each that can — otherwise the
case the gesture is for, three objects where one already has a Collider, is the case it refuses.

## Blank is not Tweakpane

The params grid is Tweakpane (ADR 0024) and **its number input cannot be empty**. A pre-filled box would be a
claim about values the selection has not got, so a mixed row is drawn with plain inputs in a `.irow` instead —
the row type the panel already had for text. The moment a value is typed the selection agrees and the row
comes back as the normal widget on the next rebuild.

So a mixed row looks different from an agreeing one, which is not a compromise so much as the point: it is
visibly the state where the panel does not know a single answer.

A **compound** value — a collider shape — is reported as differing rather than offered blank. Reconstructing
that picker in a blank state is a lot of surface for a case the shape picker already covers one object at a
time.

## Rejected

- **Show the primary's value and mark the row.** What ADR 0031 refused, for the reason it gave: the field
  would be about to overwrite two values it never showed.
- **Diff Tweakpane's vec3 object to work out which axis moved.** Keeps the widget, at the price of inferring
  intent from a value comparison; three inputs say which axis was typed because each one is an axis.
- **Match components by id.** Cannot work: ids are per component.
- **Match by type only.** Wrong the moment a node has two colliders, and silently so.
