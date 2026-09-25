# ADR 0097 — Deleting a prefab unlinks its placements

Status: accepted. Amends ADR 0091's "a missing prefab draws nothing and says so", which stays for a file that
went missing and no longer covers one somebody chose to delete. Applies to a **folder** as well: deleting one
unlinks every prefab in it first, as deleting each would — it used to remove them as plain files.

## Context

Kodjo asked what happens today when a prefab is deleted in the Project panel. Measured rather than assumed:

- **No warning of any kind.** `deleteAsset` was one line straight to the server. No count of what referenced
  it, no confirmation.
- **The `.meta` sidecar goes with the file**, so the asset **id** is destroyed. Create the prefab again and it
  gets a new id: the old placements can never be re-linked.
- **The lock does not protect it.** The only server-side guard is `refuseIfLocked`, and prefabs left the lock
  system in ADR 0091 when they became live documents. You could delete one somebody was editing.
- **Anyone with the level open saw nothing change**, because resolution is in-memory and never re-clobbers
  itself. The delete looked like a no-op until the next open.
- **On the next open** the placement kept its transform, drew nothing, and the status line named the missing
  id. Designed (ADR 0091), and the right answer for a file lost by accident.
- **If the prefab was open live**, its next debounced write threw `the prefab asset is gone`, and kept
  throwing until everyone left the room.

So the graceful degradation worked and the delete itself was a trap.

## Decision

**A confirm, and the placements are unlinked rather than emptied.** Kodjo's words: nothing happens to them,
they are just unlinked from the prefab and stay in the levels.

`unlinkedNode` resolves one placement into a plain node — it keeps its own id, its own transform and its place
in the tree, and takes the resolved name, components and children, which is exactly what was on screen a
moment earlier. `prefab` and `overrides` go, because there is nothing left to override.

The confirm says how many placements are in the open level and which other levels use it, and states plainly
that the id does not come back.

## Why the editor does this and not the server

The unlink needs a **component registry** for two things: which component types are singletons, so a
placement's own components layer over the inherited ones correctly; and which parameters are `nodeRef`s, so a
reference between two inherited nodes follows them when they are re-idded.

The editor-server has no registry, deliberately — it depends on `@mp/content` alone, and `api.ts` already says
so where it explains why the editor validates parameters before sending. A server-side rewrite would have
silently broken every `nodeRef` inside a prefab.

So the pure function lives in `@mp/content` with the registry injected (`UnlinkDeps`), and the editor supplies
it. Two paths from there:

- the **open** level is unlinked through its own document, as `replaceNode` ops: one undo entry, and everyone
  in the room sees it.
- every **other** level goes through `GET` + `PUT`, which already 409s while that level is open live. That
  refusal is the guard — rather than rewrite a file under somebody, the whole delete stops and names the level.

The prefab file goes **last**. A failed unlink then costs nothing, where the reverse order would leave
placements pointing at an id that no longer exists.

## The two traps in the inlining

Both are about the inherited half entering the level's id space, and both are tested.

**Sharing.** `bakeOverrides` returns the prefab's *own* objects when an override changed nothing — deliberate,
so that editing a shared definition is not a silent no-op (ADR 0033). Inlining without cloning would leave two
placements sharing children, and editing one would silently edit the other.

**Colliding ids.** A prefab's ids are minted in its own scope, so inlining two placements of one prefab into a
level gives it duplicate ids, which `validateLevel` refuses. Every inherited subtree is re-idded.

And the re-id is over the whole **forest**, not each root in turn. A prefab root has several children and one
may reference another; re-idding them one at a time gives each its own map and leaves the reference naming an
id that exists nowhere. That was a real bug in the first version, caught by its own test.

## Rejected

- **Leaving it as it was**, with placements degrading to empty objects. Right for an accident, wrong for a
  decision — and irreversible, since the id dies with the sidecar.
- **Refusing the delete while anything references it.** Safe and useless: you could never delete a prefab
  without first hand-editing every level that used it.
- **Doing the rewrite on the server.** No registry, so it would break `nodeRef`s inside prefabs without
  saying anything. This is the reason the design is shaped the way it is.
- **Unlinking the open level through `PUT` like the others.** Its own `PUT` 409s, because it is open. It has to
  go through the document, and going through the document is better anyway: undoable, and live for everyone.
- **Deleting the placements outright.** Never suggested and worth recording: an object's position in a level is
  somebody's work, and the prefab is only where its contents came from.
- **Keeping the `.meta` so the id could come back.** A dangling sidecar with no asset is a new kind of broken,
  and the unlink removes the need.

## Consequences

- `GET /api/levels` reports `prefabs` — the asset ids each level references — in the pass it already made over
  every level file. That is what makes "N levels use this" cheap enough to show before a delete.
- Unlinking the open level is one undo entry. Unlinking the others is not undoable, and the confirm says the
  delete is permanent.
- A delete can now be refused because another level is open live. The message names it.
- Deleting a prefab nothing places is unchanged apart from the confirm.
- `unlinkPrefab` does not touch `Level.prefabs`: that is the resolution map, rebuilt on every open and
  stripped on the way to disk (ADR 0091).
