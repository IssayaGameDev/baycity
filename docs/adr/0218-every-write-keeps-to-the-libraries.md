# ADR 0218 — Every write keeps to the libraries

Status: accepted. Kodjo: "make sure that this never happens anymore".

## Context

ADR 0161's rule — a Shared asset uses only Shared's, a game's things only their own game's and Shared's — was kept
by each editor gesture on its own: pickers, drops, placing, moves. *Save as prefab…* had none. Adrien saved two
prefabs from a Keyboard level into Shared's `materials` folder, drawn with Keyboard's materials and styles; only
`libraries.test.ts` said so, at the commit after the content merge.

## Decision

- **The server refuses the write**, since every write of content goes through it (`api.ts`): a JSON asset's PUT, a
  level's PUT, and a live batch — level, prefab, material, game file — before it applies. 409 with the reason; a
  refused live batch is rolled back by the sender, as any refused batch. Ops carry only the values they set, so a
  fix is never refused for what it replaces.
- **One rule, in `@mp/content`**: `outOfLibrary` + `libraryRefusal`, which `libraries.test.ts` uses too.
- **Save as prefab goes where it may live** (Kodjo's call): the open folder when it can hold it, else the level's
  game's own `<game>/assets/prefabs/` (Kodjo's pick of name, the editor's existing default). Never another game's
  library: the level could not place it.

## Rejected

- **Patching each gesture**: the next gesture is the next hole.
- **Refusing Save as prefab and asking for a folder**: Kodjo chose the redirect.
- **`<game>/assets/Prefabs/`**: would change the existing default for every game.
