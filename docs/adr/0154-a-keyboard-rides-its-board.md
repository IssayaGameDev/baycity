# ADR 0154 — A keyboard's caps ride the board a sequence carries

Status: accepted. Extends ADR 0069's caps to boards that move. Kodjo's calls: follow the board in every way a
sequence changes it, keep it cheap for levels with a very large number of caps, and fade in the shader rather
than with a mesh per fading board.

## Context

A board's caps were laid out once, at load, in world space, into one `InstancedMesh` per glyph pooled across the
level. A `Sequence` on the platform — or on anything above it — moved, turned, scaled, faded and switched the
platform off every tick; its caps stayed where they were built, and a footfall was looked up against the
board's load-time frame, so on a moving board it pressed the wrong caps or none.

## Decision

| | |
| --- | --- |
| which boards | a board whose visual is `animated` (new on `VisualItem`: a sequence drives the node or one above it, fixed at load). Every other board is built as before, and pays nothing new |
| drawing | carried boards' caps go into their own **riding** meshes, one per glyph, each cap tagged with its board's slot (`boardSlot`, 4 bytes). A float texture holds one row per carried board — its transform since load, then its opacity — and the vertex shader substitutes `instanceMatrix` with that transform times the cap's own, so position, normal and the world position its received shadows use all follow. The colour's alpha takes the opacity |
| per frame | `follow`: one row per carried board from its visual (`carry`, the level view's pose: position, rotation, `drawScale`), uploaded only when a row changed. None of it is per cap |
| hidden | not drawn (switched off, or a fade at nothing, as the level view decides for the platform): the row folds every cap to a point, so nothing is rasterised, and the board takes no footfalls |
| pressing | a footfall is taken back through the board's inverse transform to where the caps were built, and the lookup is ADR 0069's unchanged; a struck cap's top is carried forward for the popup |
| cost | draw calls: up to 26 more, for the glyphs on carried boards. Vertex work: a few texel fetches per vertex of a carried cap only. Riding meshes are not frustum-culled — the still ones' bounds were a sphere around the level anyway. Client only: the server already moves the platforms, and caps pay nothing (ADR 0081) |

Riding materials are `transparent` from the start, as a fadeable platform's own are (ADR 0137), so a fade
recompiles nothing; at full opacity they draw as opaque.

## Rejected

- **A mesh per fading board.** Simpler, and up to 26 draw calls per board that fades.
- **Rewriting the carried caps' instance matrices every frame.** No shader patch, but CPU work and an upload per
  cap per frame, which a level of many moving boards cannot afford.
- **Per-cap opacity.** A value per cap where one per board says the same thing.
