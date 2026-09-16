# ADR 0111 — A placement can be unlinked

Status: accepted. Opens a door onto machinery [ADR 0097](0097-deleting-a-prefab-unlinks-its-placements.md)
already built; nothing about prefab references (ADR 0091) changes.

## Context

Kodjo asked whether the editor could unlink a placed prefab instance. Measured: the machinery was complete and
reachable from exactly one place — **deleting the prefab file**.

- `unlinkedNode(level, node, assetId, deps)` already turned one placement into a plain node.
- `unlinkPrefab(level, assetId, deps)` did it to every placement in a level.
- `Doc.unlinkPrefab(id)` did it as ops on the open document.

But the only caller was `deleteAsset`, which unlinks *every* placement in *every* level as a consequence of
destroying the file (ADR 0097). There was no way to say "make this one a plain object and leave the prefab
alone". The hierarchy menu had Open prefab, Save as prefab…, Revert to prefab and Apply to prefab — every
direction but out.

## Decision

`Doc.unlinkNode(i)`: one placement, one op, reported as a boolean. It refuses a node that is not a placement
and an **inherited** node — an inherited node also carries a `prefab` ref, because it is part of some prefab's
own definition, and there is nothing in this level to rewrite for it.

Two entry points, both on the selected object, as Kodjo asked:

- **Hierarchy right-click** → `Unlink from prefab`, beside the other prefab items.
- **Inspector**, on the row that already names the prefab and its placement count → an `Unlink` button
  **left of** `Open`. That order is how far each reaches: this object, then the shared definition behind it.

**No confirm.** It is one op, so Ctrl+Z puts the link back, and it replicates to the room like every other
edit. Deleting the prefab *file* asks because that destroys the asset id and cannot be undone; unlinking
destroys nothing.

The node keeps its own id, transform and place in the tree, and takes the resolved name, components and
children it was drawing — an override becomes the value, because the override is what was on screen. The
inherited subtree is cloned and its **node** ids re-minted: a prefab's ids are scoped to itself, so two
inlined placements would otherwise give the level duplicates and `validateLevel` would refuse it. Component
ids are per node and may repeat, so they are left alone.

## Rejected

- **Unlink every placement of the prefab in this level.** That is `Doc.unlinkPrefab`, which exists and which
  deleting the file already runs. Offering it from a node's own menu would make a per-object gesture reach
  objects the person did not select.
- **A confirm.** Undo already covers it, and a dialogue on a reversible edit teaches people to dismiss
  dialogues.
