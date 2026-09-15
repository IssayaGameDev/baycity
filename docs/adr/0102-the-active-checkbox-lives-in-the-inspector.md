# ADR 0102 — The active checkbox lives in the Inspector, not the Hierarchy

Status: accepted. Amends ADR 0099, which put it on the Hierarchy row.

## Context

ADR 0099 gave a node an `enabled` flag and put its checkbox on the Hierarchy row, left of the twist. Kodjo,
having used it: that is not where he wants it. Unity puts it in the Inspector's header, left of the name.

He is right about Unity, and the reason holds here too: the Hierarchy is for **finding and arranging** things,
and a column of checkboxes running down it competes with the names it exists to show.

## Decision

The checkbox moves to the Inspector's header, **immediately left of the name field and nothing else** — which
is exactly a component section's header (`isec-en`, then the name) one level up, because it is exactly the same
control: a tick, then the thing it switches off.

A first attempt put it on its own line above the name with a label reading `in the level`. Kodjo's response was
that this is awful and that the component header already shows how it should look. He is right twice: the label
said nothing a tick does not, and a control that already exists in the product should not get a second shape.
Why an ancestor's state blocks it is a `title`, not a line of body text.

**The Hierarchy still dims a switched-off row.** That was never the complaint, it is how you see the state of
a whole tree at a glance, and Unity dims too. `Row.disabled` and `Row.disabledAbove` stay; only the control
went.

Still disabled as a control when an ancestor is off, for ADR 0099's reason: the node's own flag is not what is
keeping it out of the level then, and a checkbox that changes nothing visible is worse than none.

## Consequences

- `HierarchyHost.onSetEnabled` is gone; `InspectorHost.onSetEnabled` takes no index, because the Inspector
  already knows what is selected.
- The toggle is one click further away — you have to select the object first. Accepted: switching an object off
  is not a thing done in bulk down a list, and selecting it is how you were going to check what it was anyway.
- Nothing about the data, the ops or the loader changed. This is where a control sits.
