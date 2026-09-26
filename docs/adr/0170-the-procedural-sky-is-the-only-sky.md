# ADR 0170 — The procedural sky is the only sky

Status: accepted. Settles the comparison ADR 0046 kept the photo for, and withdraws ADR 0045's photo backdrop.

## Context

ADR 0045 hung a photograph behind the scene; ADR 0046 replaced it with the designed gradient and kept the photo only
as a "backdrop" toggle in the Sky debug folder, to judge the procedural sky against, "deleted once the comparison is
settled". Every game still downloaded the photo (842 KB) before it could start, including Keyboard, whose players
never see the debug folder. The toggle could also say "photo" while the procedural sky showed, since any Sky slider
re-baked the background, and the photo was never freed.

Kodjo: the procedural sky is the one; the photo was the first attempt.

## Decision

The photo backdrop is deleted: `installSky`, `loadSky` and `Sky` in `@mp/render-three`, the load in `createScene`,
the Sky folder's backdrop toggle, and `CODE_ASSETS` — assets the game's code loads by path — which held only the
photo, so a level's list (ADR 0169) is exactly what the level uses. The Sky folder keeps its procedural controls.

The texture file stays in `content/assets/textures/` until someone deletes it in the editor: content changes on the
box, not in a code commit.
