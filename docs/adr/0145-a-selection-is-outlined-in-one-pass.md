# ADR 0145 — A selection is outlined, everyone's in one pass

Status: accepted. Kodjo's calls: an outline like Unity's rather than a box, drawn in full behind walls, the
same for collaborators as for me, mine in white.

## Context

Collaborators' selections showed as tinted `BoxHelper`s (ADR 0089's holds); my own selection showed nothing
but the gizmo. Kodjo wanted Unity's cue: the object's real silhouette outlined. He asked that collaborators
match it, unless outlining three to five of them cost real performance.

## Decision

**One custom pass for every selection** (`SelectionOutlinePass`, `packages/render-three`), after tone mapping
and before SMAA, in the editor's composer only (`PostFXOptions.outlines`; the game passes none):

1. only the selected subtrees are drawn, into a mask, each group in its own id, with depth ignored;
2. the mask is dilated by 2 CSS px, across then down;
3. a pixel outside every silhouette that the dilation reached takes that id's colour.

| | |
| --- | --- |
| behind walls | drawn, as bright as in the open — which is also why the pass needs no depth |
| mine | white: collaborators' colours are strong hues (`HSL(h, 0.75, 0.6)` from their connection), so white is never one of theirs |
| theirs | the hold colour they already had, one group per connection; the boxes are gone |
| children | a node's group carries its subtree, so a parent's outline takes its children in, as Unity's |
| while playing | none |

The cost is drawing the selected meshes once more and three full-screen passes, whatever the level's size
and however many people are selecting. With nothing selected the pass is off.

## Rejected

- **Three's `OutlinePass`.** It re-renders the whole scene twice per pass and takes one colour, so five
  collaborators were ten extra scene renders a frame — the performance cost Kodjo said would rule the
  feature out.
- **Faint behind walls.** Kodjo wanted the whole outline, whatever is in front.
- **Keeping boxes for collaborators.** Two cues for one idea; Kodjo chose consistency once it was cheap.
