# ADR 0091 — A level references a prefab by id, and a prefab is edited live

Status: accepted. Amends ADR 0023's "placing a prefab writes a reference" (which interned a *copy*) and the
prefab-asset paragraph of ADR 0026. Amends ADR 0089: prefabs leave the per-file lock; materials keep it.

## Context

Two reports from Kodjo, one week apart, with one cause.

**The liminal tab.** The Project panel listed prefabs in two places: a `prefabs` folder of files, and a
pseudo-folder called *This level* holding `Level.prefabs`. His words: "they're in this weird liminal tab that's
called this level… Created prefabs should always be in the normal directory."

**Two doors to one room.** `Extract to prefab` interned a copy into the level and never wrote a file. A prefab
*file* was written only by switching the editor to prefab mode and pressing Save. "I don't want an extract to
prefab option as well as a save as prefab option. No one's gonna know which is which. There should be only
one."

Underneath both: **placing a prefab copied it.** `place` interned the tree into `Level.prefabs` under a key made
from the file's name, so editing the file never reached a level that had already placed it. The content had
already drifted three ways, each found by measuring rather than by reading code:

- `default.json` and `swing.json` held an entry named `FastElevator` whose contents were byte-identical to the
  **AlternatingDanger** file. Two levels showed a placement labelled FastElevator that was an AlternatingDanger.
- Their `Trampoline` entries named the pad `91521042` where the file names it `p0`, and both placements carried
  an override keyed on `91521042` — a material and `power: 60`.
- `keyboard.json` carried a `Trampoline` nobody had placed, and two prefabs (`Stage End`, `inter stage`) that
  existed only inside that level, which is what made Kodjo's own prefab "nowhere to be found".

## Decision

**A level references a prefab by asset id.** `node.prefab` holds the id of a `*.prefab.json` asset, and
`Level.prefabs` is **not part of the file**: it is an in-memory resolution map, filled by `hydratePrefabs`
before the level is used and removed by `stripHydrated` on the way back to disk. So a prefab has exactly one
definition, and editing it reaches every level that uses it.

**A prefab is its own live document.** Addressed `prefab:<assetId>` beside `level:<name>`, it is a `Level`
wrapper holding one root node — the shape a prefab document has always had in the editor — so every op, hold,
op log and debounced write applies to it unchanged. It loads from the prefab store, writes back to its own
file, and refuses to contain a placement. Chosen over "takes the file lock and leaves the live session",
knowingly, because the point of one definition is that everyone sees it change.

**One action makes a prefab.** `Save as prefab…` asks a name, writes the file into the folder open in the
Project panel, and points the selection at it. `Extract`, prefab mode and Save for prefabs are gone.

**A missing prefab draws nothing and says so.** The placement keeps its transform, draws nothing, and the
Hierarchy names the id. The level still opens and still plays.

## How it works

- **One lookup.** `effectiveNode` resolves `level.prefabs[node.prefab]`, as it always did, so the loader, the
  editor's `Doc`, op scoping and the hold machinery needed no change. Hydration is the whole seam.
- **One object per prefab.** Resolving a level's references takes each definition from that prefab's *open*
  document, opening one where there is none, so a prefab edit is in every open level's resolution the instant
  it applies. A prefab document stays open while any level resolves from it.
- **One delivery path.** A prefab's ops are relayed onto the streams of levels that reference it, as a `prefab`
  event carrying no sequence: the level's file did not change, so it is a repaint instruction. A tab is in one
  document at a time, so nobody receives a batch twice, and a reconnecting client takes definitions from its
  snapshot.
- **Apply to prefab spans two rooms.** The prefab's ops go first, from the level's own connection (the server
  accepts an op on a prefab from a connection in a level that uses it), and the override is cleared only once
  they are taken.
- **Coexistence, with no version field.** Hydration never fills a reference that already resolves and stripping
  removes only what it filled, so a level still carrying its own table keeps it and loses nothing when written.
  That is what let the code ship before the migration ran.

## The migration

`migratePrefabRefs.ts` matches each entry to a file — **contents first, name last** — or writes a new file for
it, then re-points every placement. The gate is what makes it safe: each level is fingerprinted by what it
draws and collides with, before and after, and the rewrite is thrown away unless the two agree line for line.

The fingerprint (`fingerprint.ts`) normalises the two ways a size can be written, because a prefab saved after
ADR 0090 says "unit collider, scale 3 × 0.3 × 3" where a copy interned before it says "half extents
1.5 × 0.15 × 1.5". It ignores world scale and a name a placement inherits — how a thing is written down rather
than what anyone can see.

Three rules came from the three drifts. Contents are matched before names, or both levels would have been
re-pointed at the wrong elevator. Override keys are remapped, or `power: 60` would have vanished. And an
override transform is completed from the node it now overrides, because `bakeOverrides` replaces a transform
wholesale, so an override carrying only a position would have wiped the file's scale and turned a 3 m pad into
a unit cube.

Verified over the live content: 253 resolved nodes across every level, no differences.

## Rejected

- **Keeping the copies and only merging the two actions.** It would have left "two prefabs of the same name
  that silently differ", which is the confusion being removed. Kodjo chose the larger change knowing the cost.
- **Threading a `PrefabSource` through `effectiveNode`, `walkNodes`, `instantiateLevel` and `validateLevel`.**
  Nine `validateLevel` call sites and three `effectiveNode` callers changed for no gain, and it would have lost
  the object sharing that makes a prefab edit visible to an open level with no data transfer.
- **A reverse index broadcasting a new event to dependents *and* clients joined to both.** Two delivery paths
  and two sequence spaces for one change. Since a tab is in one document at a time, the relay alone is exact.
- **One SSE stream per referenced prefab.** Six connections per origin is a hard browser cap that a level with
  six prefabs would hit.
- **Refusing to load a level whose prefab file is gone.** One deleted file would stop everyone working. Inert
  and visible matches the precedent that a dangling override is inert (ADR 0033) and a missing material
  greyboxes.
- **A version field, or detecting the old shape.** Hydration that never clobbers makes both shapes work at
  once, which removed the need for a deployment window.
- **Deleting the prefab file on undo after `Save as prefab…`.** By then another level may reference it.

## Consequences

- `Level.prefabs` no longer round-trips to its file. Every writer goes through `stripHydrated`.
- A hydrated level must never cross a process boundary: each side resolves from its own source.
- A refused prefab batch is rolled back by refilling that root object, never replacing it, because every level
  holding the prefab holds that object.
- `×N` on a Hierarchy row still counts placements in the open level; a prefab is shared across levels the
  editor cannot see.
- `PUT /assets/<path>` is refused while that prefab is open live, and `GET` serves the live copy — as a level's
  routes already did.
- Copying a placement between levels now shares the prefab instead of duplicating it, and a paste is refused
  when the prefab uses a component the game lacks, which interning used to gate by accident.
- Prefab-in-prefab stays forbidden. Nothing here needs it, and it would want cycle detection that exists
  nowhere.
