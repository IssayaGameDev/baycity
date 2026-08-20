# ADR 0035 — A node holds components; `Piece` and `PrefabInstance` are gone

Status: accepted, stage C1 of `PLAN-component-system.md` (with C3 landing alongside it). Replaces the
schema halves of ADR 0023, 0025, 0028, 0029, 0032 and 0033; the *reasoning* in those still applies and is
cited where it survives.

## Context

Kodjo, four times, wanted a component system. I argued against it four times and was wrong. His words the
time it landed: *"if the bumper sits on the collider itself, then we're not having a component system,
you're just rewriting things in a different way that's still the exact same behavior in the end"*.

He was also right that one already existed. `Piece.trigger` was a name plus optional parameters attached to
a collider and read by a mode — a component in everything but structure. `Piece.behavior` was a second one,
built separately, with the same shape. Neither had a registry, so both were spelled out by hand everywhere.

Measured before starting: adding one parameterised trigger kind touched **6 files in about 18 places** —
the union and `TriggerKind`, the validator's set and its per-kind check, seven sites in `editorDoc.ts`, five
in `inspector.ts`, the gizmo colour table, and the mode's own lookup. `ItemProps` carried `bumperPower` on
the properties of every object in the project, including ones that would never bounce.

Three defects worth naming, because they are what a registry fixes rather than what it tidies:

- **The default lived in the tool.** `DEFAULT_BUMPER_POWER = 26` sat in `editorDoc.ts`, so hand-written JSON
  had no default and the validator could not fill one.
- **Three spellings of "no trigger":** `undefined` on a piece, `'none'` in the editor's `TriggerChoice`, and
  `{ kind: 'none' }` in an override.
- **One rule per object, decided by the schema.** A checkpoint that also bounces was inexpressible.

## Choice

### One node type

```ts
interface Node { id; name?; transform; components: ComponentData[]; children?; prefab?; overrides? }
interface ComponentData { id; type; params: Record<string, unknown>; enabled? }
```

`Piece` and `PrefabInstance` merge. `Marker` goes with them: a checkpoint marker with a radius is a node
with a ball `Collider` and a `Checkpoint`.

The distinction that replaces instance-versus-piece is about **ownership**, not kind: a node is *own* (this
document authored it, edits write straight to it) or *inherited* (it belongs to a prefab this placement
references, edits become overrides). That is the honest version of what ADR 0033 was reaching for, and it
retires the whole class of bug that ADR documented.

### Parameters are declared, not reflected

TypeScript types are erased, so there is nothing at load time to say that `power` is a number between 1 and
60. Unity gets this from C# reflection over serialized fields; without reflection the declaration has to be
a value:

```ts
export const Bumper = defineComponent({
  type: 'Bumper',
  params: { power: { kind: 'number', default: 26, min: 1, max: 60, label: 'launch (m/s)' } },
  singleton: true,
})
```

One declaration, five uses: the Inspector's controls, the validator, the defaults, the serializer, and the
typed read (`componentOn(node.components, Bumper)?.power` is a `number` with no cast). Nine parameter kinds:
`number`, `bool`, `string`, `enum`, `vec3`, `asset`, `collider`, `keys`, `nodeRef`.

**Authored parameters and runtime state stay separate.** Unity conflates them — public fields serialize,
private do not — which is what makes its saved scenes surprising. Here `params` is authored; anything a
component computes at runtime lands in C2's state, which never touches JSON. That split is also what makes
C2's determinism story checkable.

### The engine knows five types; the mode knows the rest

`nodeLoader.ts` reads `Collider`, `Visual`, `MaterialOverride`, `Track` and `Spawn`, and **no gameplay names
at all**. It hands a mode every component on the node that owns a collider (`LoadedNodeLevel.nodeOf`) and
lets the mode recognise what it knows. Adding a rule is a definition plus a branch in the mode, and touches
nothing in between — that is the difference between a component system and a switch statement.

The mode's three lookup shapes (an array of checkpoints, a Set of hazard handles, a Map of bumper powers)
became one `nodeOf(handle)`.

### `Collider` gained a `center`

Without an offset a second collider sits exactly on the first and is the same collider twice, so
repeatability would have been a claim rather than a feature. It is Unity's `BoxCollider.center`, defaults to
the origin, and every migrated piece leaves it there. The loader scales and rotates it with the node, and
`Dynamic` carries it so a moving node re-applies it each tick.

### `enabled` per component

Absent means enabled. It is how a level is tested without deleting things, and it earned its place
immediately: it is what makes the dead checkpoint markers convertible without changing behaviour (below).

### Overrides, including structural

`NodeOverride` carries `transform`, `name`, `params` (per component id), `enabled` (per component id),
`added` and `removed`. Unity's added and removed components, which a component system needs because "this
one placement also bounces" is the ordinary case rather than an exotic one — so **stage C3 landed with C1**
rather than after it. Revert works per field, per component, or wholesale; Apply pushes the lot into the
shared definition.

`enabled` is a map of its own rather than folded into `params`, because it is not a parameter: it sits beside
them on `ComponentData`, and folding it in would collide with a component that happens to declare a
parameter called `enabled`.

Two sentinels ADR 0033 needed are gone. `trigger: { kind: 'none' }` and `behavior: { kind: 'static' }` said
"not that, here" because absence meant inherit; a component can simply be **removed**, which is the same
statement without a special value.

### The Inspector generates itself

`inspector.ts` reads `registry.get(type).params`, maps each declaration to a control, and writes values back
by key. It knows what a bumper is nowhere. An overridden parameter is marked with a leading `•` rather than
by reaching into Tweakpane's label DOM — the same reasoning that kept ADR 0033's override list a list.

`keys` is deliberately not editable here: a property grid can show one instant of a track, which is the
mistake ADR 0029 removed. It shows the count and points at the timeline.

### Dependency direction

`@mp/components` depends on `@mp/content`, never the reverse. Content owns the schema and takes capabilities
as arguments: `validateNodeLevel(json, registry?)` checks parameters only when handed a registry, and
`effectiveNode(level, node, types)` needs to know one thing about a type — whether it is a singleton. Two-way
would be a cycle; a registry as an argument also means a test can build one out of two fakes.

## Migration

`packages/components/src/migrate.ts`, run once, rewrote **6 levels and 3 prefab files**.

| was | became |
|---|---|
| `Piece.collider` | `Collider { shape, center }` |
| `Piece.visual` (or its absence) | `Visual { source, model, material }` — **always written** |
| `Piece.trigger` | `Checkpoint` / `Goal` / `Hazard` / `Bumper { power }` |
| `Piece.behavior`, `Prefab.behavior`, `PrefabInstance.behavior` | `Track { keys, loop, phaseMs }` |
| `PrefabInstance.material` | `MaterialOverride { material }` on the placement |
| `PieceOverride` | `NodeOverride`, re-keyed from piece ids to node ids |
| `Marker` (spawn) | `Spawn` |
| `Marker` (the other three) | the rule plus a **disabled** ball `Collider` |

Three decisions inside that table are worth their own lines:

**A `Visual` is written even where the piece had none.** An omitted `Piece.visual` greyboxed the collider; a
node with no `Visual` draws nothing, because absent has to mean absent once it is a component — the way a
GameObject with no renderer is invisible. So the old default became explicit data instead of a rule in the
renderer.

**A placement's own components layer over what it inherits**, with a singleton replacing and a repeatable
appending. That reproduces `inst.behavior ?? prefab.behavior` and `inst.material` beating a piece's own
exactly, with no override bookkeeping — and it is symmetric with children, which the loader already appended
after a prefab's own.

**`MaterialOverride` cascades to the whole subtree**, where `PrefabInstance.material` stopped at the
instance's own pieces. There is no longer a distinction between a node's pieces and its children to stop at.

### The one deliberate behaviour change

Three levels carry two `checkpoint` markers each — six positions that have **never done anything**, because
every consumer of `LoadedLevel.markers` filters for `spawn` and the mode takes its checkpoints from piece
colliders. They convert to the rule plus a ball collider that is **disabled**, which is the only mapping that
keeps all three promises: the authored position and radius survive in the file, the node is as inert as it
was, and switching it on is one checkbox rather than an archaeology exercise. Whether they *should* be on is
Kodjo's call, not a migration's.

### How the migration was verified

`packages/components/src/legacy.test.ts` loads **every authored level both ways** — the captured pre-migration
JSON through `instantiateLegacyLevel`, the converter's output through `instantiateNodeLevel` — and compares:

- every `VisualItem`, field for field (collider, position, rotation, model, material) **in order**
- the spawn markers
- the gameplay rules, with their parameters, in creation order
- `basePoseOf(i, 'tick')` for the first 64 dynamics, because that index is a rider's movement base on the
  wire (ADR 0021) and a mismatch desyncs riders rather than erroring
- every visual's pose at t = 0, 250, 500, 1000, 2500, 4001, 7777 ms

It also validates the converted level **against the registry**, which is what proves the converter emits
parameters matching every declaration rather than JSON of the right shape.

The legacy loader, the converter and its fixture stay until Kodjo has confirmed the editor and the game in a
browser. They are the proof and the rollback path; they are deleted after that, together with `Piece`,
`PrefabInstance`, `Prefab`, `Marker`, `Trigger` and `validateLevel`.

## Consequences

- **Two colliders on one node are one object with two shapes.** A ramp with a lip was two pieces; it is one
  node now, and a rule on it covers either shape.
- **A node can be a checkpoint and a bumper.** Impossible before.
- **A visual with no collider, and a collider with no visual, are both expressible**, as is an empty node used
  only for grouping. `Piece.collider` was mandatory.
- **`source: 'collider'` with no collider draws nothing.** Inventing a unit box would put geometry in the
  world that no data asked for; the case is reachable two ways (a Visual added before a Collider, a Collider
  switched off) and both should be invisible.
- **A prefab is a node tree, so prefab mode is a level of one node.** `levelDoc` and `prefabDoc` are one
  implementation over `docOver`, where they used to be two. The prefab's **root is protected** from delete and
  duplicate: it *is* the file.
- **A prefab may nest plain nodes**, which `Prefab.pieces` could not. Prefab-in-prefab stays out (ADR 0023's
  reason holds: a reference graph needs cycle detection a tree does not), and the validator refuses it.
- **Colliders are validated for the first time.** Nothing checked them before — `validateLevel` walked pieces
  only as far as their behaviors and triggers, so a box with no `halfExtents` reached Rapier as `undefined`.
  Free, once a collider is a declared parameter.
- **`cylinder` is not offered in the Inspector.** The physics wrapper has no cylinder shape and the loader
  throws on one, so offering it would let the editor author a level that cannot load.
- **An unknown parameter key is dropped, not rejected.** Erroring would turn every parameter rename into a
  content migration, and Unity drops unknown serialized fields for the same reason. The cost is that a rename
  loses values silently, so a rename is a migration.
- **`min`/`max` are not enforced at load.** They drive the Inspector's slider; a value outside them is honest
  data and rejecting it would make a bound a schema change. Non-finite numbers *are* rejected — `NaN` reaches
  the character as a position and disappears it.
- **This is the fifth restructuring of these fields in a row** (style → material, behavior → track, trigger →
  parameterised, piece overrides, now components). Recorded as a cost, as ADR 0033 recorded the fourth. The
  difference this time is that the shape stopped being a guess: it is Unity's, which has authored content
  behind it.

## Rejected

**A parameter table on the existing `trigger` field** — the proposal I made first. It removes the copy-paste
but leaves one rule per node, keeps the piece/instance split, and would have been thrown away by this. Kodjo
called it a rename, and it was.

**A rule holding a reference to its collider** — my second proposal, and not Unity's model. Contact is
delivered to the node and every component on it hears about it, no wiring. The version with a pointer also
has a dangling state the version without cannot have.

**Runtime-compiled component scripts** (esbuild-wasm in the browser, hot reload). More Unity-like, and what a
plugin platform needs. Rejected: a compiler dependency, a sandbox question and a source-map story, for an
audience of one author with the repo open. Definitions compile in; adding one is a rebuild.

**Overrides keyed by array index.** Same silent re-targeting ADR 0033 rejected, one level deeper.

**Two component lists on a placement** (inherited plus own, merged by every consumer) instead of overrides
carrying `added`. Rejected for components because "what does this node have" would have two answers, which is
exactly where the piece/instance split went wrong. Kept for *children*, where nothing conflicts and the
loader already appended.
