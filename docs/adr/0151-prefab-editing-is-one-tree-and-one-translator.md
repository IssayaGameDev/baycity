# ADR 0151 — Prefab editing is rebuilt on one tree and one translator

Status: accepted, in progress. Step 1 of 4 has landed: the grid (`tools/editor/src/prefabGrid.test.ts`).
Kodjo's calls: rebuild rather than patch, and migrate existing levels once.

## Context

Every session on prefabs found another case missing (ADR 0098, 0130, 0133, 0135 were each one). A survey of
the editor document found why: **the editor edits the file format directly**, and a node can be stored five
ways — an object of the level, a placement, a piece, a child a placement added under a piece, a child added to
the placement itself — so every edit is written once per case.

- About 75 places in `editorDoc.ts` branch on which kind a node is.
- The list of `NodeOverride` fields is written out by hand in 7 places, each with a different subset.
- About 10 functions walk the tree; 2 know about added children.
- The placement's top level has two storages for children (`children`, ADR 0130, and the record's
  `addedChildren`, ADR 0135) and two for components, which ADR 0135 said it had replaced.

Seventeen gestures in the grid fail today, each for a traced reason (the grid names them).

## Decision

| | |
| --- | --- |
| one tree | the editor edits a plain tree where every piece is a node like any other, linked to its prefab original; every edit is written once |
| one translator | after an edit, one function compares a placement with its prefab and writes the differences — what `diffStages` already does for sequences (ADR 0139) |
| one storage | everything a placement adds or changes lives in its override records; nothing in its own `children` or `components` |
| one walk | one walk of a tree, added children included, and one table of override fields; every walker and every field consumer uses them |
| kept | the file format apart from the one storage; the loader, the server and the ops on the wire; undo by inverse ops; a piece moved out of its placement becomes a copy and the placement records it removed (ADR 0133); reordering a piece keeps it a piece |
| safe to revert | until the migration, the new code writes only shapes today's code reads |

**Steps**, each ending green and committed: (1) the grid — every gesture on every kind, checked in the editor,
after reopening from the file, in what the game builds, and through undo; (2) the tree and the translator;
(3) every edit moved onto them, the per-case code deleted, the grid's `it.fails` turned into `it`; (4) a one-time
migration of existing levels on the box into the one storage.

## Rejected

- **Patching the seventeen one by one.** Faster now; the next feature would miss a case again, since the cause
  is that each feature has to be written per case.
- **Reading both storages for ever** instead of migrating. No script to run, and the old storage stays a sixth
  case in the editor and in the game.
- **Storing the expanded tree in the file.** Unity does not either: a level would stop following its prefab
  anywhere the copy was written out, and every file would carry every prefab's contents.
