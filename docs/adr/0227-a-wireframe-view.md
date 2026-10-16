# ADR 0227 — A wireframe view

Status: accepted. Extends ADR 0146 (my selection shows its edges) to everything, on a toggle.

## Context

Kodjo asked for a wireframe view in the viewport. Two were possible: lines over the normal view (Unity's Shaded
Wireframe), or lines only, seeing through everything.

## Decision

- **Lines over the normal view** (Kodjo's call): every object keeps its look, with its edges drawn on it.
- **Edges, not triangles**: `shapeEdges`, the selection's lines — a box's twelve, a rounded box's one line along each
  bevel, nothing on a sphere. Every triangle turns a rounded box or a model into hatching (ADR 0146's reason).
- **Darker than a selection's** (black at 45 %), so my selection's white lines stay told apart.
- **The viewer's own**, a toggle in the viewport's top-right row beside Grid, not the room's; not kept across reloads,
  as Grid and Markers are not. None while playing. A board's cells and a light's gizmo are skipped, as for the selection.
- **Kept up as it goes** (`wireframeView.ts`): each frame lists the meshes under the item root, adds a line for a new
  one and drops a gone one's; a geometry's edges are worked out once and shared by every mesh drawing it.

## Rejected

- **Lines only**: not what was asked; the same code with the faces hidden, if it is wanted later.
- **`material.wireframe`**: every triangle, and it would change the materials the thumbnails share.
