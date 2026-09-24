# ADR 0146 — My selection shows its edges

Status: accepted. Beside [ADR 0145](0145-a-selection-is-outlined-in-one-pass.md)'s outline. Kodjo's calls: the
shape's edges rather than every triangle, and on my selection only.

## Context

The outline shows a selection's silhouette, and nothing of its form inside it: a box seen from a corner is a
hexagon with no sign of where its faces meet. Unity also draws the selection's wireframe.

## Decision

**Thin white lines where the selected shape's faces meet, wherever they can be seen** (`selectionEdges.ts`,
`shapeEdges.ts`), on every mesh of my selection's subtrees.

| | |
| --- | --- |
| which edges | `EdgesGeometry` at 20°: a box's 12, a cylinder's two rims, a hull's creases; a sphere or a capsule has none. A **rounded box** gets one line along the middle of each rounded edge instead: its bevel facets are a little over 20° apart, so the angle finds nothing, or a band of five lines per edge |
| hidden edges | not drawn: depth-tested, pushed a thousandth of the distance toward the eye so an edge on its own faces does not flicker |
| whose | mine only; collaborators' outlines carry their colour, and edges on five selections would be clutter |
| skipped | a board's surface cells, and a light's gizmo, which is a wireframe already |

`materials.ts` records a rounded box's size and radius on its geometry (`userData.roundedBox`), since three
keeps neither.

## Rejected

- **Every triangle**, Unity's wireframe. A rounded box is hundreds of triangles, and an imported model more.
- **Everyone's selection.** See above.
