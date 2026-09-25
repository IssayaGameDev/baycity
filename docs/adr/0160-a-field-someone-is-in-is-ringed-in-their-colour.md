# ADR 0160 — A field someone is in is ringed in their colour

Status: accepted.

## Context

Anyone edits anything, and the last change to land wins (ADR 0158, ADR 0159). Two people in one Inspector field
saw only the value change under them: nothing said someone else was about to overwrite it, or had just been in it.

## Decision

Kodjo's call: **a ring in their colour round the field someone else is in**, their name on hover, while they are
in it — typing, dragging a number, a dropdown or a picker open. Nothing else: no flash, no badge.

| Part | Now |
| --- | --- |
| a line's name | its card and its label, which every tab draws the same: `data-card` on the card (a component by type and ordinal, as a multi-selection matches it; the Transform, the Game and Environment cards by key; `asset` for the asset Inspector) and `data-field` from `fieldRow` |
| in a field | `fieldPresence.ts`: focus in the line, or a pointer pressed on it (a number drag takes no focus). Leaving is said 150 ms late, so moving across or a rebuild is one move |
| what it writes to | `targets`: the selected nodes (`<kind>:<doc>\|<refKey>`), the level's settings (`@game`, `@env`), or `asset:<id>` |
| the server | `POST …/field`; one spot per connection, whole set to **every** connection in every document (`fields`), to a joiner after its snapshot, dropped on leaving — the state open assets keep too (`everyoneSees`) |
| the rings | the others whose targets hold what this panel shows: the primary node, the level's settings or the asset; repainted as the panel rebuilds |

One mechanism for both Inspectors, which is why the material Inspector moved onto the shared controls first.

## Rejected

- **A flash in their colour when their change lands.** No new messages, but it tells you after the overwrite, not
  before.
- **Room presence (`presence`), unkept.** A joiner would not see who was already in a field, and a material's
  fields are open from every level.
