# ADR 0204 — A frozen prefab copy yields to its prefab

Status: accepted. Amends ADR 0091 (hydration never replaces an entry the level carries) and ADR 0124 (levels already
carrying a copy were left for a one-off repair). Kodjo's call: heal those levels automatically.

## Context

Kodjo added a stage gate to the `InterLevel` prefab. `Roblox_World_1` showed it; `Roblox_World_1-copy` did not, and
*Revert overrides* there changed nothing while the editor still counted 19.

The copy carried frozen copies of `InterLevel`, `Spawn` and `Obstacle` under their asset ids. It was made with
Duplicate while its source was open live, and `GET /api/levels/:name` served the open document **as resolved** —
its table filled with every prefab definition — so the new file kept them. `keyboard` and `Roblox` carried
`Stage-End`, `kill-plane` and `Boss` the same way.

A copy under an asset's id was read **instead of** the asset for good (`hydratePrefabs` skips an id the level
carries). Worse, the two sides split: the server resolved the level from the copy, while the editor tab applied
each prefab edit to its own copy, which by then had a different layout. They disagreed about what a placement
contained, which is what the override count showed.

## Decision

- **`relinkPrefabs`**: before hydration, wherever a level is read to be used — the server's live documents and the
  game's loader — an entry under an existing prefab asset's id is dropped. The asset resolves in its place, is
  recorded as filled, and the next write leaves it off disk. An entry with no asset behind it stays.
- **`Live.levelAsFile`**: what leaves the server — `GET /api/levels`, the play routes — is the level as its file
  would be, never the resolved one.

## Rejected

- **Only stopping the leak**: the three levels would keep their copies until someone ran ADR 0124's script.
- **ADR 0124's reason against dropping these** — that the table might be one a level genuinely owns: a level owns a
  definition only where no asset has its id. Under an asset's id it is a copy of that asset.
- **Healing in the editor too**: it reads the server's resolution; a second rule there could disagree with it.
