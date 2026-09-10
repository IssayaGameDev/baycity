# ADR 0075 — A game picks its debug folders

Status: accepted. `TpsClientOptions.debugFolders` lists which of the platform's twelve debug-pane folders a game
gets. Absent is all; `[]` is none. Keyboard passes `[]`.

## Context

The debug pane built the same twelve folders for every game: Camera, Sky, Touch, Movement, Render, Gait, Idle,
Inertia, Head, Joint lag, Jump / air pose, Death. Most of them date from tuning the humanoid (ADR 0018) and the
sky (ADR 0046), which is finished work. Keyboard had added three of its own underneath — Keycaps, Progression,
XP popups — two of which Kodjo never asked for either: sliders invented alongside the features they tune.

## Decision

A list on the options, not a deletion. `DEBUG_FOLDERS` names the platform's folders; `debugFolders` is the
subset a game wants, built in platform order. The frame meter is always built — it is about the frame, not about
any tunable.

Why not delete the stale folders: which are stale is a per-folder judgment about what Kodjo still reaches for,
and it would change every game at once. A list is one line to turn a folder back on for an afternoon of tuning,
and leaves parkour and swing exactly as they were.

`pane.ts` became a map of builders keyed by folder, which is the same code as before with each block behind a
key. Nothing inside a block changed.

## Consequences

- Keyboard's pane: Debug → frame meter, Progression. Nothing else. Progression is Kodjo's list: Reset
  experience, Reset wins, and a grant (an amount and an **Add experience** button, for reaching a level without
  walking there). The curve sliders and the Keycaps and XP popups folders are gone; every value keeps its
  default.
- Parkour, swing, `_template`: unchanged.
- To get a platform folder back in keyboard, list it: `debugFolders: ['movement']`.

## Rejected

**Deleting folders.** The judgment call above, and irreversible for every game at once.

**A per-folder boolean bag.** Twelve optional booleans versus one list of keys; the list also fixes the order.

## Known open

- The `Movement` folder's `move speed` slider is dead in keyboard anyway (ADR 0071); it is now also absent,
  which is the better state.
