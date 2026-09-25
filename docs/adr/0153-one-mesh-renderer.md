# ADR 0153 — `Mesh` folds into `Renderer`: one Mesh Renderer

Status: accepted, done. Step 1 landed the component, both shapes read, and the fold
(`deploy/editor/migrate-mesh-renderer.sh`); the fold ran on the box (705 Meshes, 5 placement records, 18 files, content
`5c9a5ea`); step 2 deleted `Mesh`, `retired` and `modelOf`'s second half. A file still carrying a `Mesh` no longer loads. Supersedes the split of [ADR 0039](0039-mesh-and-renderer.md). Kodjo's calls: merge for real
rather than one card over two components, and the name **Mesh Renderer**.

## Context

ADR 0039 split `Visual` into Unity's `MeshFilter` and `MeshRenderer`. Its reason was the greybox: a `Renderer`
with no `Mesh` drew the node's colliders, and that was most content. ADR 0090 then made every shape a built-in
mesh, and the content stopped using the split. Counted across every level and prefab: 650 drawn objects carry
both, 3 a `Renderer` alone drawing their colliders, 2 a `Renderer` with nothing to draw, none a `Mesh` alone.
Every mesh was a built-in shape. The split cost two cards on every object and bought nothing in use.

## Decision

| | |
| --- | --- |
| the component | `Renderer` gains `model`, first: `{ model: asset(model), material: asset(material) }`, labelled **Mesh Renderer**. An empty `model` draws the colliders, as a `Renderer` alone did |
| the type | stays `Renderer` in the file, so what a placement already overrides on one keeps naming it; only records naming a piece's `Mesh` move |
| `Mesh` | **retired** (`ComponentDef.retired`): still registered and read, never offered. `modelOf(components)` is the one rule: the `Renderer`'s own model, else an enabled `Mesh`'s |
| deploy order | deploy, then fold. The code reads both shapes, so nothing draws differently in between |
| the fold | `meshRenderer.ts`, from the box's own checkout: each `Mesh` into its node's `Renderer` (which keeps its id), a `Mesh` alone into a switched-off `Renderer` holding the model; records naming a piece's `Mesh` onto its `Renderer` — a `Mesh` switched off or removed there drew the colliders, so it is that `Renderer`'s model cleared. Prefabs and levels **all or nothing**, every file checked to draw as before |
| step 2 | once the fold has run: `Mesh`, `retired` and `modelOf`'s second half go |

Revert: the code before this ignores `Renderer.model` (unknown parameters are dropped by `readParams`) and draws
each object's colliders — boxes, balls and capsules as before, a rounded box without its rounding. Nothing fails
to load.

## Rejected

- **One card over two components.** No migration, but one tick box, one Remove and one override count standing
  for two components, and the split everywhere else — the file, the loader, prefab overrides.
- **A new type, `MeshRenderer`.** Every placement override on a `Renderer` would have to move too.
- **Folding before the deploy.** The running code would draw every folded object from its colliders until the
  deploy.
- **Keeping `Mesh` read for good.** A second way to say one thing, in the loader and in every tool, for ever.
