# ADR 0028 — One visual answer: `style` is deleted, materials are it

Status: accepted. Narrows ADR 0014's greybox visual language and completes ADR 0026's asset layer.

## Context

There were two ways to say what a surface looks like, and the weaker one had the better reach.

**`style`** was a string naming an entry in `STYLE_PALETTE`, a table of eight hex colours living in
`packages/render-three/src/materials.ts`. `createStyleMaterial` turned a key into a `MeshStandardMaterial`
at fixed roughness, with a hardcoded `ACCENT` set getting a 0.14 emissive lift. Content referenced palette
entries *by name*, so the renderer was a second authoring system: adding a colour meant editing a
TypeScript file, and the only per-instance visual override that existed was `PrefabInstance.style`.

**`material`** was an asset (ADR 0026): a shader name plus tagged parameter values, referenced by id,
editable in a generic inspector driven by the shader's own declared parameters. It could do everything
`style` could and textures, metalness, custom shaders besides. It was offered **only on prefab pieces** —
`inspector.ts` gated it behind `pieceLevel` — so it could not be overridden per placement.

The capable system was the one you could not override. The weak one was. Content had voted accordingly:
**45 `style` references across 7 files, 1 `material` reference, 1 material asset on disk.**

## Choice

**Delete `style`.** `Visual`'s primitive arm is `{ kind: 'primitive'; material?: string }`.
`PrefabInstance.style` became `PrefabInstance.material`. `VisualItem.style` and `MeshSpec.style` are gone,
along with `visualStyle`, `STYLE_PALETTE`, `colorForStyle` and `createStyleMaterial`.

**The greybox palette survives as content.** The seven keys content actually used ship as material assets
in `content/assets/materials/` (`ground`, `platform`, `ramp`, `moving`, `hazard`, `checkpoint`, `goal`) —
`standard` shader, the same hex colours, roughness 0.85, metalness 0, and for the four accent keys the same
emissive colour at 0.14. Nothing looks different; the visual language is now authored data that can be
edited in the tool instead of a table only a programmer can reach. `spawn` was in the palette but was never
used as a surface, so it did not become a material.

**All 45 sites migrated.** Both places the key appeared — a piece's `visual.style` and an instance-wide
override — mean the same thing now, so both became `material` carrying the new asset id.

**Material is offered at both levels.** The piece's own inside a prefab, an instance-wide override in a
level, labelled "material" and "material override". That is the reach `style` had and `material` lacked.

**What stayed, because it was never content:**

- **Marker colours.** The spawn/checkpoint/goal/hazard pads and their editor wireframes are debug chrome
  nobody authors. `MARKER_COLORS` + `colorForMarker` keep the four colours, typed to `WorldMarker['kind']`
  instead of an open string, which also removed a `m.kind === 'spawn' ? 'spawn' : m.kind` no-op.
- **The unsurfaced surface.** `createGreyboxMaterial()` is what a primitive with no material draws as: flat
  slate, no argument, deliberately not configurable. Making it tunable would recreate the palette this
  replaced. It is also the fallback for a *dangling* material id, so a broken reference costs one wrong
  surface rather than a hole in the level (unchanged from ADR 0026).

## Consequences

- **A broken visual reference changed cost, so it gained a test.** An unknown `style` fell back to a
  default colour *by design*, so it was harmless. A dangling material **id** greyboxes silently: the level
  loads, validates and instantiates, and looks wrong. `modes/parkour/src/references.test.ts` asserts every
  material and model id reachable from every shipped level resolves in `ASSET_DB`, that every texture a
  material names resolves, and that the seven palette materials exist by name. It reads the loader's
  `visuals`, so instance overrides and nesting are covered by the same flattening the game uses.
  Ids survive renaming and moving, which is the point of sidecars; deletion is what this catches.
- **It exposed an editor bug that made every material invisible.** The editor's viewport had *never* drawn a
  material. `reloadAssets()` ends with `runtime.load(doc?.assetIds() ?? [])`, but at boot it runs before the
  first document exists, so that list was always empty; and `showDoc()` — every file open, every step into a
  prefab — rebuilt the meshes without loading anything. `runtime.material(id)` returned null and every piece
  greyboxed. It went unnoticed because content used `style`, which the renderer resolved by itself with no
  asset involved, and because the Project panel's thumbnails have their own fetch path (`previews.ts`), so
  materials *previewed* correctly while never rendering in the scene. Migrating 45 sites turned it from
  latent into "the level is grey and changing the material does nothing". `showDoc` now preloads, and
  `loadNewReferences` draws with what is cached and redraws when the fetch lands — also on the two edits that
  add a reference mid-session, assigning a material and placing a prefab file that brings its own.
- **The editor's preload had to grow.** `Doc.assetIds()` walked prefab pieces only. An instance `style`
  needed no asset; an instance `material` does, so the override is now included or it would greybox in the
  viewport while looking correct in the JSON. The game path needed nothing: `assetIdsIn` reads
  `VisualItem.material`, which the loader fills from `inst.material ?? piece material`.
- **A hierarchy piece row shows the piece's name.** It read `box · <style>`, which had no input any more.
  `MeshSpec` carries `name` and the row falls back to the collider kind — better than the suffix was, since
  three boxes read as "left rail / floor / right rail" if somebody named them.
- **A new blank level's ground slab greyboxes.** It was `style: 'ground'`. Naming the ground *material*
  would put a content asset id in tool source, referencing a file somebody is free to delete; and greybox
  is honest for a slab a new level got for free.
- **Precedence is unchanged in shape and inverted in nothing.** Instance material beats the piece's own, and
  does not cascade to nested children, exactly as the `style` override behaved.

## Rejected

**Keeping `style` as a read-only legacy field.** No migration, nothing breaks, and the eight-colour table
stays as documentation of what levels already say. Rejected because two visual systems is the actual
complaint: the field would keep appearing in every reader's narrowing, in validation, in the loader's
precedence rule, and the inspector would either show a dead control or hide a field that still affects what
renders.

**Generating a material per style key at load.** A compatibility shim: read `style: 'hazard'`, synthesize
the material. It would have made migration unnecessary. Rejected because the synthesized materials are not
assets — no id, no file, not in the explorer, not editable, not previewable — so the palette would still be
a table in the renderer, just one that now lies about being content.

**Deleting `STYLE_PALETTE` entirely.** Four of its entries colour marker gizmos, which no material asset
should own: a marker pad is not a surface somebody authors, and making it one would put editor chrome in
the content tree.
