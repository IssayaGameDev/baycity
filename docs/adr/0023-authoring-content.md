# ADR 0023 — Content is authored in the in-browser editor; Unity supplies assets, not levels

Status: accepted. Supersedes ADR 0014's "a full editor is deferred" and its rejection of
"full in-viewer edit/save". Builds on the content pipeline (ADR 0014) and convex colliders (ADR 0017).

## Context

Three authoring paths existed at once, and none of them fed the game.

- `tools/editor` — a localhost Vite app with a gizmo, a palette, an inspector and **play-in-place
  running the real `createLocalController` and `stepCharacter`**. Wrote `content/{levels,prefabs}/*.json`.
  Read by nothing but itself.
- A Unity exporter (`MpExporter.cs` + five `MP/*` components, 611 lines of C#) writing the same JSON
  schema, one-way. Read by nothing.
- `modes/parkour/src/showcase.ts` — TypeScript calling kit generators. **The only path that ships.**

So the editor could build and walk a level no player could reach, and `content/levels/` held five files
of which one was real.

Three defects had accumulated in the gap:

- Placing a prefab **inlined a copy**, so editing a prefab did nothing to what was already placed.
  `Level.prefabs` + string refs had been in the schema and honoured by the loader the whole time; the
  editor never wrote them.
- Save took a file name and never touched the document's `id`, so three level files each claimed
  `"id": "level1"` and `prefabs/FastElevator.json` claimed `"untitled"`.
- The palettes were hand-kept lists that drifted: `beam`, `padChain` and `curvedBeam` shipped in the
  kit and sat unreachable in both the editor and the viewer for four commits — exactly the pieces
  `showcase.ts` is built from.

## Choice

**The in-browser editor is the content path.** Not for authoring comfort — Unity is far ahead there —
but for fidelity. Content is only correct if a jump is makeable, which is a question about *our*
solver: Rapier, `stepCharacter`, our gravity, our tick rate, the envelope measured in
[obstacles.md](../obstacles.md). Unity has PhysX and a different character; it cannot answer it. The
Unity loop is place → export → launch → discover the gap is 20 cm too wide → go back, and it is blind
the whole way. The editor answers in one keypress with the code the game runs. Same reason Roblox
Studio works: you edit inside the runtime.

**Unity's role is assets, and it lives outside this repo.** `Visual` already carries a `gltf` kind and
the loader already threads `src` through to every `VisualItem`; that is the seam. Unity is genuinely
good at meshes and materials and genuinely unable to match our solver, so it owns the visual layer and
stops owning collision. The scene exporter is retired.

**Placing a prefab writes a reference.** `place` interns the prefab in `Level.prefabs` and pushes an
instance holding its **id**. `prefabAt(id)` hands back the one shared object, so "Edit prefab" is a
`prefabDoc` over the thing every instance points at, and stepping back out rebuilds them all. Placing
the same kit piece twice reuses one entry (`freeTableId`, content compared with the id blanked); the
same id over different content takes a numeric suffix.

**Resolution lives in `@mp/content`, not in the loader.** `resolvePrefab` / `instancesOf` /
`freeTableId` are in `resolve.ts` — headless, no physics import — because the loader and the editor
were both about to answer "which prefab is this instance" and two definitions of that rule is one too
many.

**A `name` on instances and pieces (new).** Author-facing only — the loader ignores it and nothing derives
behaviour from it. It is what makes a hierarchy legible: two placements of one prefab become "first gap"
and "last gap", and a prefab of three boxes reads as "left rail / floor / right rail". Absent unless
typed, with the display name falling back to the prefab id (or the collider kind), so clean JSON stays
clean and clearing a name removes the key rather than blanking it. Per *instance*, like a GameObject's
name — renaming an instance never renames the prefab it references.

**Overrides are transform, behavior and `style` (new).** An override is the counterpart to a
reference: worth having exactly where instances of one prefab must differ, and no further. `style`
recolours **every** piece of the instance and beats the prefab's own. Everything else is shared, which
is the point of sharing it.

**Inline definitions stay valid.** Older files are full of them and the loader treats resolved and
inline identically. `extract` promotes a one-off into a table entry in place, which is how an existing
file becomes a referencing one.

**Save syncs the id to the file name.** The name is the identity; the editor no longer lets them drift.

**The palette is discovered, not listed.** A test enumerates every no-arg callable in `@mp/content`
returning something with `pieces` and asserts the palette can place each one. It immediately found
both directions of drift: three makers missing, and `curvedBeamExit` wrongly offered as placeable when
it is not a maker at all — it returns where a curved beam *ends*.

## Consequences

- **The mode loads a level by name** (`levels.ts`): `?level=<file>` from `content/levels/`, bundled with
  `import.meta.glob` so a malformed level is a build error rather than a blank screen; no param loads
  the gym, and an unknown name logs the alternatives and falls back rather than bricking the page.
- **The level name is a matchmaking filter.** Two clients on different levels must not share a room:
  the geometry differs, and so does the movement-base index a rider puts on the wire (assigned in
  instance order at load, ADR 0021), so a mismatched viewer would place a rider on whatever piece sits
  at that index. `define('parkour', ParkourRoom).filterBy(['level'])` — the server still loads no
  content and never learns what a level *is*. Colyseus filters only on options a client actually
  supplies, so **omitting `level` matches any room**; every client here names one, the bots harness
  included (it did not, and would have been silently split off or dropped into an authored level).
- **The gym stays in code, and stays a fixture.** Baking `showcase.ts` to JSON would discard the
  generator parameters `gym.test.ts` asserts against the measured envelope, and freeze the curve
  course's cursor layout. It would also silently *disable* those assertions: they filter instances by
  `typeof i.prefab !== 'string' && i.prefab.id === 'pad-chain'`, which matches nothing once placement
  writes references — passing on an empty set rather than failing. Parametric generators in the schema
  are the way to make the gym editable without that loss; deferred.
- **Nesting exists since ADR 0025** — instances nest to any depth and the loader composes a frame tree.
  What it cost, as scoped here beforehand and confirmed in the doing: a recursive `children`
  in the schema; a **rewrite of the loader's `update`**, since a `BehaviorHandle` stores an absolute base
  pose resolved once at load, and a child of a moving parent has a base that changes every tick, so the
  tree must be evaluated parents-first and composed; depth-first traversal becoming the order that
  checkpoint progression and base indices follow; and the editor mirroring the nesting in its own scene
  graph, so the gizmo can convert a world transform back into a parent's local frame instead of
  teleporting children. The wire is the one part that would *not* change — the base byte indexes the
  behaviors list, and every animated piece would still get an index, so `basePoseOf`/`baseCarry` keep
  working and compound motion falls out for free.
- **A prefab id is now load-bearing** in a way an inline definition never was: renaming a table key
  without repointing its instances breaks the level, and `validateLevel` rejects it at load (a dangling
  ref names the missing id).
- The base index a rider puts on the wire (ADR 0021) is unaffected — it is assigned in instance order
  at load, and references do not reorder instances.
- `content/levels/` still holds four throwaway files (two Unity smoke tests, two editor scratch, one
  of them a byte-identical duplicate) alongside `level1.json`. Not deleted here; they are Kodjo's.

## The Unity conversion, preserved

The exporter leaves the repo, so the parts that were hard to get right and would have to be
rediscovered:

- **Handedness.** Unity is left-handed, our runtime (three + Rapier) right-handed. Position mirrors as
  `(x, y, −z)`. A rotation conjugated by that mirror is `(−x, −y, z, w)`: for a reflection `M`,
  `M·R(n,θ)·M = R(det(M)·M·n, θ)` and `det(M) = −1`, so the axis maps to `−M·n` with the angle
  unchanged.
- **A move axis is a true vector** (flip z); **a rotate axis is a pseudovector** (flip x and y, keep z).
  Getting this wrong spins the piece the correct amount in the wrong direction.
- **Shapes.** Unity `BoxCollider.size × 0.5` → `halfExtents`, with `lossyScale` left on the instance
  transform for the loader to bake into dimensions. Our capsule `halfHeight = height/2 − radius`.
- **Order was the defect that mattered.** `FindObjectsByType(FindObjectsSortMode.None)` is explicitly
  unsorted, and checkpoint progression order *is* instance order, so re-exporting silently reshuffled
  which pad was checkpoint 1. Two committed exports of one scene prove it: the same seven pieces in two
  different orders. `A_`/`B_`/`C_` name prefixes had been tried; naming does nothing. Any future
  exporter must sort explicitly.

## Rejected

**Keeping both authoring paths.** Two sources of truth with no merge story: re-exporting from Unity
overwrites whatever was tuned in the editor, and with arbitrary ordering you cannot even diff to see
what was lost. Every schema addition would also be paid for twice, in C# and TypeScript.

**Blockout in Unity, tune in the editor.** Same missing merge, and it wastes the editor's one decisive
advantage by keeping the physics answer out of the blockout stage.

**Keeping prefab inlining and adding a "re-apply to instances" command.** Copies with a remembered
origin, which is the thing references already are, minus the guarantee.

**Overriding arbitrary piece properties per instance** (Unity's model). Unbounded serialization surface
for a schema this small; transform + behavior + style is what placing actually needs.
