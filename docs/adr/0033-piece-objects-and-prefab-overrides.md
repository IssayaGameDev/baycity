# ADR 0033 — A piece is an object; a placement overrides it

Status: accepted. Extends the prefab model of ADR 0023 and the hierarchy of ADR 0024.

## Context

Kodjo, on trying to change a bumper's power: *"it seems that they exist, but not really at the same time."*
He was right, and the diagnosis was worse than the symptom.

A `Prefab` holds `pieces`, flat. The editor's `Doc` addressed **instances** only. An instance reported all of
its prefab's pieces as its own meshes, so the scene graph had one object where the Hierarchy drew several. Those
piece rows were synthesized by the panel from `meshSpecs`, could not be selected, had no gizmo, and were
reachable only by double-clicking to step into the shared prefab.

The twist made it worse. Two collapse sets — `collapsed` for child instances, `piecesOpen` for pieces — with the
twist writing to whichever the row happened to need. So the moment an instance gained a child, the twist wrote
only to `collapsed`, `piecesOpen` could never be set again, and **the pieces became unreachable with no
workaround.**

And the division of labour was wrong in the data too. The `trampoline` instance carried a material override
that applied to every piece; the `pad` piece carried the collider, the visual and the trigger. The thing with
no visuals had the material field; the thing with the visuals could only be edited by leaving the level.

## Choice

### One twist, everything shut

`Openness` is a single `expanded` set, absent meaning collapsed. A row's contents are its prefab's pieces
followed by its child instances, and one twist hides both. Everything starts shut, so opening a level shows its
top-level objects rather than every piece at once.

### A piece is a node the document addresses

`levelDoc` walks **instance, then its pieces, then its children**, and every one of those is an index.
`Doc.kindOf(i)` says which. Pieces first because they are what the object *is*; a child is something placed on
it.

Consequences that fall straight out, and are the point:

- **An instance draws nothing of its own.** `meshSpecs` of an instance is empty; a piece draws itself. The
  scene graph now matches the Hierarchy, and matches the loader's frame tree, where an instance is a transform
  and a piece is the thing with a collider.
- **The Hierarchy stopped synthesizing rows.** Every row is a document node, so a piece is selectable,
  renameable and movable by the same code as anything else. `rowsOf` got shorter.
- **Indices interleave.** Four one-piece platforms number 0, 2, 4, 6. Every test that wrote a literal index was
  addressing a piece where it meant a placement; they look nodes up by name or ordinal now, which is more
  robust than the literals were even before, since any structural edit renumbers.
- **What a piece cannot do is enumerated rather than implied**: it cannot be re-parented, re-ordered, deleted
  or copied through a placement, because its position belongs to the prefab. Those operations refuse.

### Per-instance overrides, keyed by a piece id

An edit to a piece *through a placement* writes an override on that placement. Editing the shared definition is
what prefab mode and "Open" are for.

```ts
Piece.id?: string                                   // minted on demand
PrefabInstance.overrides?: Record<string, PieceOverride>
PieceOverride = { transform?, material?, trigger?, behavior?, name? }
```

**Keyed by a stable id, not by array index.** An index re-targets silently the moment somebody inserts a piece
above it — the same failure the asset layer avoided with sidecar ids (ADR 0026), except the symptom here is one
instance's override quietly landing on a different piece. A test reverses a prefab's pieces and asserts the
override follows the piece.

**Minted on demand.** A piece gains an id the first time something refers to it, so **no authored content had
to migrate**. A piece with no id is simply not overridable, which is the honest fallback: better than guessing
a position.

**Absent means inherit, so clearing needs a value.** `material: ''` is "no material here" and
`trigger: { kind: 'none' }` is "not a trigger here", both distinct from saying nothing. Motion needed no new
sentinel because `Behavior` already has one in `{ kind: 'static' }`. Without this, "this instance's hazard is
not a hazard" would be inexpressible.

**One resolution, shared.** `effectivePieces(level, inst)` in `resolve.ts` applies the overrides, and both the
loader and the editor read it — the same reason `resolvePrefab` lives there. Two implementations would
eventually disagree, and the symptom would be a level that looks one way in the tool and behaves another in the
game.

It returns **the prefab's own object for pieces that changed nothing**, and a fresh object only where an
override applied. That is deliberate: the editor writes through the objects it is handed when editing the
shared definition, and copying unconditionally would turn a prefab edit into a silent no-op.

**`inst.material` still wins.** The blunt all-pieces override predates this (ADR 0028) and is the coarser
statement, so it beats a per-piece one.

### Writing needs a setter

`Doc.setTransform(i, t)` replaced mutating whatever `transformOf` returned. For an overridden piece those are
different objects — reading gives the prefab's value, writing creates the placement's own — so handing out a
mutable reference could not work. This also closes the wart ADR 0030 recorded in its rejected section: the doc
no longer hands out references it expects callers to mutate.

### The Inspector says what is overridden

`overridesOf` lists the differing fields, with **Revert to prefab** and **Apply to prefab (all instances)**.
Listed rather than bolded in place: Tweakpane owns its label markup, so marking one would mean reaching into its
DOM, and a list says the same thing without breaking when Tweakpane's internals change.

A piece that matches its prefab says so explicitly, because "nothing here" and "no override" look identical
otherwise.

## Consequences

- **`childCount` counts pieces as well as children**, since both are what one twist opens.
- **`Row.index` is the node's own index.** It used to be the owning instance's, with a piece number beside it.
  `parent` is what says whose piece it is now, and `onOpenPiece` is gone entirely.
- **Selecting a piece no longer changes documents.** No breadcrumb change, no stepping in and back out.
- **`applyToPrefab` changes every other instance,** which is why it is a deliberate button and not something an
  edit does on its own.
- **Structural overrides are not supported.** Adding or removing a piece for one placement only is Unity's
  "added component / removed component", and it needs more than a field-level patch. A piece can be overridden,
  not deleted.
- **Overrides for a piece the prefab no longer has are inert, not an error.** That is what lets a prefab lose a
  piece without every placement that touched it failing to load, and it is why the validator checks the shape
  of an override but never its key.
- **This was the fourth restructuring of these fields in a row** (style → material, behavior → track, both →
  parameterised trigger, now piece overrides). Worth recording as a cost: the shape kept moving because there
  is no authored content pushing back on it, which is the argument against building more schema before there is
  a level worth the trouble.

## Rejected

**Editing a piece through a placement changes the shared prefab.** Simpler, needs no new data, and it is what
stage 1 of this work shipped as an interim. Rejected because it makes every prefab a liability: the moment a
prefab is used twice, adjusting one of them silently adjusts the other, and the editor gives no sign. Kodjo
picked overrides explicitly when asked.

**Overrides keyed by piece index.** No ids, no minting, less schema. Rejected for the silent re-targeting
above: the failure is invisible until somebody edits the prefab, and then it is data corruption rather than an
error.

**A separate compound address for pieces** (`{ instance, piece }`) instead of one interleaved index space.
Avoids renumbering every index and would have left the tests alone. Rejected because it pushes the compound
address into every consumer — selection, the scene groups, undo paths, the multi-select roots — where the
interleaved list keeps one index space and let the Hierarchy get simpler rather than more complex.

**Property-path overrides** (`"pieces[2].visual.material"`), which is closer to what Unity actually stores.
More general, and it would cover fields nobody has thought of. Rejected as stringly-typed and unvalidatable
against a schema that is small enough to enumerate.
