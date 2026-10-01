# ADR 0189 — Text and quads in the world

Status: accepted; its fonts and bold amended by ADR 0190. Extends ADR 0082 (world labels) and ADR 0090 (built-in shapes). Kodjo's calls: the sharp-text
library over canvas text; text on the object by default, facing the camera as an option; mirrored from behind
by default, hidden as an option; never seen through walls; the old labels reworked onto the same drawing.

## Context

Kodjo wants text and textures placed in a level. Text existed only as game code: a canvas drawn to a sprite that
faced the camera (nametags, the keyboard's pad signs). Textures could go on any shape through a material, but every
built-in shape was a solid, so a picture went on six faces of a box.

## Decision

- **`troika-three-text`** draws all text: signed-distance glyphs, laid out in a worker, one atlas shared by every
  text, one draw call a block — sharp at any size. Measured: 117 KB, 43 KB compressed, against the game's
  1.26 MB compressed. The fonts are ours, Roboto regular and bold (OFL, 21 KB each), so text never waits on another
  site; the library goes to a CDN only for a character neither file has.
- **One drawing**, `createText`: facing the object (the node's XY plane, read from +Z, Unity's TextMeshPro) or
  the camera; mirrored or hidden from behind; in the world or over it. Nametags and pad signs are labels built
  from it, so there is one text in the game.
- **A `Text` component** (Rendering): words in a text area, font size in metres, colour, alignment, wrap width,
  bold, facing, from behind. Read once by `textOf` for the loader and the editor; surfaced as a light is, riding,
  fading and switching off with its node. Kept out of the AO prepass, where a glyph's quad would ghost.
- **A built-in Quad**: a face toward +Z, one-sided, colliding as a centimetre-thick box — a texture shows once.

## Rejected

- **Canvas text.** No new library, but blurry close up or large, and a texture per sign.
- **A free choice of font now.** One shipped pair; a font field on the component is its own job.
- **A Text entry in the Create menu.** Not asked for: a Text goes on any node by Add Component.
