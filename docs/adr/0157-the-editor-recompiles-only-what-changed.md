# ADR 0157 — The editor recompiles only what changed, in place, and saves a material in order

Status: accepted. Step 2 of the asset rework (ADR 0156 is step 1). Supersedes ADR 0026's "every asset edit
reloads the runtime".

## Context

A material edit in the asset Inspector, on **each step of a colour drag**, did all of this: saved the file,
emptied every thumbnail, re-read the asset list and every material and prefab, disposed every loaded texture,
material and model and loaded them again, rebuilt every mesh in the viewport, and redrew the Inspector — the
colour field under the pointer included. The saves were separate requests with nothing keeping them in order, so
on the box an older value could land after a newer one and be what stayed on disk. Another editor applying a
collaborator's change (ADR 0156) paid the same full reinstall.

## Decision

| Part | Now |
| --- | --- |
| the runtime | `refreshMaterial(id)` recompiles a loaded material **into the object meshes hold** (`copy` + `needsUpdate`); `false` when the shader became another class of Three material, and only then is the viewport rebuilt. `refreshTexture(id)` fetches again past caches and recompiles every loaded material using it — each holds its own clone of the texture. `refreshModel(id)` fetches again; a model's placed clones are rebuilt |
| fade copies | a fadeable node's own material copies record their original, and `meshes.followMaterial(original)` brings them along, keeping the preview's opacity |
| one path | `refreshCompiled(ids)` in `main.ts`, used by a local material edit, `reloadAssets` (diffing the new library against the old: `libraryChanges`) and the watch |
| a material edit | the library takes it at once, the runtime recompiles it, the next frame shows it. The save goes behind: `latestWriter` — one write in flight per material, the newest value waiting, so writes land in order and collapse to what the network allows. The Inspector is redrawn only when the shader changed; its fields read the material as it is now (a panel left up across edits would otherwise put back what changed since). Thumbnails refresh 400 ms after the edits settle |
| uploads | name the paths they replaced, since an upload over a file keeps its id and only its bytes changed |
| a fresh start | at boot, and when the change feed lost track (410): the runtime is started over |

## Rejected

- **Throttling the saves to a fixed rate.** In order and newest-wins already bounds them by the round trip; a
  timer on top adds a delay to the last value for nothing.
- **Recompiling into a new object and pointing every mesh at it.** A walk of the scene per edit, and the fade
  copies and anything else holding the old one would be missed silently.
- **Keeping the reinstall and debouncing it.** Still a full reload per pause in a drag, and the field under the
  pointer still redrawn.
