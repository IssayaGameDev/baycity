# ADR 0149 — The tools float over the viewport; the top bar is the document and running it

Status: accepted, amended: the top bar also holds the lock, the Motion clock, undo / redo and the bell ([ADR 0155](0155-the-status-bar-becomes-notices.md)). Amends [ADR 0094](0094-the-viewport-has-a-navigation-gizmo.md)'s gizmo. Every choice below
that a person sees is Kodjo's, asked with the question tool and two options each.

## Context

One toolbar held everything: a greyed-out name field, New, Duplicate, Back, four tools, Global, a snap
checkbox with its word and its number, four view toggles, Motion and Play — words on buttons in one strip.
New and Duplicate repeated the Project panel (ADR 0108, ADR 0110). The navigation gizmo worked and was hard to
use: small balls, faint unlettered negatives, nothing lit under the pointer, a projection toggle nothing showed
was there.

## Decision

| | |
| --- | --- |
| layout | **Unity's split.** The top bar: the level's name, `level › prefab` inside a prefab (the level is the way back, replacing Back), Motion and Play in the middle. Over the viewport: the tools down the left edge; Global / Local and snap at top left; the view toggles at top right beside the gizmo |
| buttons | **icons only**, the name and the key in the tooltip |
| view toggles | **one icon each**, lit when on; Keys and Reveal still appear only when they apply |
| gizmo | **Unity's**: cones round a cube, positive lettered in the axis colours, negative grey; the part under the pointer lights up; the Persp / Iso label under it is a button |
| gone | New and Duplicate (the Project panel's) |

Technical choices under it: the overlays are one layer (`#overlays`) that passes the pointer through and whose
panels take it back, so the viewport keeps every click around them; the layer hides while playing, as the
gizmo already did, because the viewport is the game's then. Each gizmo part answers over an invisible sphere
larger than its shape, and the nearest part under the pointer wins. The label is HTML, not drawn in the gizmo,
so it stays pressable when a cone pointing out of the screen covers the cube. The snap increment is a
`scrubField`, the sequence editor's control (ADR 0147). Icons live in `icons.ts`, renamed from `seqIcons.ts`
now that both share it; no dependency.

## Rejected

- **One strip across the top of the viewport.** Everything together, and a long bar over the level where
  Unity's split leaves the middle clear.
- **Icon and word.** Clear on the first day, twice as wide over the viewport.
- **One eye menu for the view toggles.** Tidier, and two clicks for each.
- **Our balls, fixed.** Bigger, lettered, lit — and still not the gizmo Kodjo reaches for from Unity.
