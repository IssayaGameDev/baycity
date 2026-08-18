# ADR 0026 — Assets are referenced by id, and a material is a shader instance

Status: accepted. Builds on the content pipeline (ADR 0014) and the editor (ADR 0023/0024). Supersedes
ADR 0014's "glTF is in the schema, not built" — the seam is now consumed.

## Context

Content could only reference its own authored primitives. `Visual` had a `{ kind: 'gltf', src }` variant
and the loader threaded `src` onto every `VisualItem`, but **nothing consumed it**, so no level could show
a mesh, and there was no notion of a texture, a material, a sound or a font at all.

Two facts shaped the order of work more than the wishlist did:

- **The Unity project holds 1570 PNGs and one TTF, and zero meshes.** It is a GUI sprite pack. So the
  first asset kinds that exist in reality are textures and a font, and most of those PNGs belong to Pixi
  (game UI, ADR 0015), not to the 3D renderer. Model support is built ahead of any model.
- **There is no audio anywhere in the repo** — no `AudioContext`, no loader, nothing. "Sounds as an asset
  kind" therefore means listing and auditioning them; playing one in game is a separate feature.

## Choice

**Assets are referenced by id, and the id lives in a `.meta` sidecar beside the file** — Unity's model.
`crate.glb` is described by `crate.glb.meta` holding `{ id, kind }`, written once by the importer and never
re-derived. Deriving an id from the path, or from a content hash, would need no sidecar and would defeat
the entire point.

The alternative was paths, which are readable and need no ceremony, and which break the moment a file is
renamed or moved — **at load, silently, in a level nobody was editing**. That is the one failure mode here
that cannot be fixed later without migrating every level, prefab and material, which is why it was Kodjo's
decision to make rather than a default to assume.

**The extension decides the kind; the sidecar only carries identity.** Renaming `.png` to `.glb` changes
what a file *is*, and a sidecar claiming otherwise is repaired in place with its id kept. Materials and
shaders use compound extensions (`brick.mat.json`, `water.shader.json`) rather than living in a magic
folder, so a file can be moved anywhere under the assets root and still be what it is.

**Duplicate ids are reissued.** Copy-pasting an asset usually copies its sidecar too, which would give two
files one identity and make every reference to it ambiguous. First one keeps the id.

**A material is a shader plus values for that shader's parameters.** Kodjo's framing, and it is the right
one: materials are instances of shaders, and we are parameterising Three.js rather than writing an engine.
So the property set belongs to the **shader**, not to the material schema:

- A `ShaderDef` declares its parameters (key, label, kind, fallback, range). `standard` maps onto
  `MeshStandardMaterial` — colour, metalness, roughness, emissive, albedo, tiling, the default for 3D
  objects — and `unlit` onto `MeshBasicMaterial` for surfaces that should ignore the scene lighting.
- **The inspector is generic**: it reads the parameter list off the shader and renders a field per entry.
  Nothing in the editor knows what "roughness" is, so adding a normal map to `standard`, or bringing a
  custom shader with its own uniforms, changes no code there.
- `registerShader` is the extension point custom shaders arrive through. A custom shader would describe
  uniforms for a `ShaderMaterial` exactly as a built-in describes a Three material class.
- Parameter values are **tagged with their type** in the JSON even though the shader already declares it,
  so a material stays inspectable when its shader is missing — an editor can still show and edit what is
  there rather than refusing to open the file.

**Two failure behaviours, chosen deliberately.** A material naming an unregistered shader renders as
`standard` with whatever parameters match, and still opens in the inspector. A dangling asset reference
greyboxes that one piece. Both turn a missing file into something wrong-looking rather than something
invisible or unopenable.

**Loading is a separate preload pass.** `addLevel` builds a mesh per visual in one synchronous sweep, and
keeping it that way is why `AssetRuntime.load(ids)` exists as its own step: anything else means meshes
popping in after the level is already walkable, and a `sync()` that has to cope with holes. Everything is
cached by id, and instances are cloned, so a level with forty crates fetches one model and the first crate
to be scaled does not resize the other thirty-nine.

**A model replaces the visual, never the collider.** Placing one wraps it in a one-piece prefab with an
authored box, so a detailed prop collides as a shape somebody can see and resize (ADR 0014's visual ≠
collision, now load-bearing rather than aspirational).

**The editor's dev server imports; the game bundles.** `GET /api/assets` runs the importer, so sidecars
exist before anyone looks at the panel, and `/assets/<path>` serves bytes. The game builds the same
database from `import.meta.glob` over the sidecars — no server, no runtime scan, the same trick
`levels.ts` uses. Both resolve the ids the editor stored.

## Consequences

- **`Visual` changed shape.** `{ kind: 'gltf', src }` became `{ kind: 'model', asset }`, and `primitive`
  gained `material`. Safe to do bluntly because nothing consumed the old variant, so no content migrated.
  `VisualItem` now carries `model`/`material` ids alongside `style`.
- **Reading the visual layer is a shared helper.** A `model` has no greybox `style`, so every reader needs
  the same narrowing — and the editor got it wrong in three places the first time the union grew.
  `visualStyle`/`visualModel`/`visualMaterial` are exported for that reason.
- **The editor's own mesh builder uses the same precedence as the game's level view** (model over
  primitive, material over style, greybox as the floor). Two implementations, one rule, because the editor
  draws items itself rather than through `addLevel` — the risk being an editor that shows a scene the game
  will not render.
- **The importer imports `@mp/content` by relative source path.** Vite loads its own config through plain
  Node, which cannot load a workspace package whose entry is a `.ts` file. The alternative was copying the
  extension→kind map into the dev server, and one odd import beats two mappings that drift.
- **Sidecars are read `?raw` and parsed by hand** on the game side: `.meta` is not an extension Vite knows,
  and importing one normally makes it try to parse a sidecar as JavaScript and fail the build.
- **Every asset edit reloads the runtime** rather than invalidating the entries a change touched. At this
  scale that is cheaper than tracking dependencies, and it is wrong the moment a level has hundreds of
  textures.
- Two 89-byte test PNGs and a material live in `content/assets/`, so the panel is not empty and the
  pipeline has something real to chew on.

## Not built

- **Sounds and fonts are referenced and previewed, not used.** The Project panel auditions a sound and
  renders sample text in a font; nothing plays a sound in game, and no font reaches the Pixi UI.
- **Custom GLSL shaders.** The registry, the parameter schema and the generic inspector are the seam;
  loading a `shader` asset's GLSL and compiling a `ShaderMaterial` is not written, and there is no shader
  to test it against.
- **Thumbnails for models.** A texture's tile is the texture; everything else is named text, because
  rendering a mesh offscreen for a thumbnail is machinery this does not need yet.
- **No drift test between the two database builders.** The importer (Node) and the game's glob (browser)
  agree by sharing `kindForPath`, but nothing asserts the two produce the same entries for one tree.

## Rejected

**Plain paths.** Readable and zero-ceremony, and silently broken by a rename. See above.

**Paths plus an editor-managed rename** that rewrites referrers. Safe only while every rename goes through
the editor, and broken the first time anyone uses Explorer or `git mv`.

**The full standard PBR slot set now** (normal, AO, roughness/metalness, emissive maps). `standard` takes
what MeshStandardMaterial supports natively and what Kodjo asked for as the default; the point of the
shader/parameter split is that adding a slot is a line in one shader definition, so pre-empting it buys
nothing but importer and inspector work.

**A Unity-side export script.** Deferred as its own item; assets are copied into `content/assets/` by hand
for now, and the importer picks up whatever is there.
