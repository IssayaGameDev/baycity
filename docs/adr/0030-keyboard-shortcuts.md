# ADR 0030 — Shortcuts match the character, not the key position; undo is a snapshot

Status: accepted. Extends the editor of ADR 0023/0024.

## Context

The editor had five shortcuts, all matched on `KeyboardEvent.code`:

```ts
if (e.code === 'KeyT' || e.code === 'KeyG') setMode('translate')
else if (e.code === 'KeyR') setMode('rotate')
...
else if (e.code === 'KeyD' && (e.ctrlKey || e.metaKey)) duplicateSelected()
```

`code` is the key's **physical position**, named after where it sits on US QWERTY. `key` is the **character it
produced**, which is what is printed on the cap. The five bindings happened to be unaffected by AZERTY, since
T, R, S, D and G sit in the same places — but the moment Ctrl+Z was added the difference would bite:
`KeyZ` is the bottom-left letter key, which AZERTY labels **W**. An AZERTY user pressing the key marked Z
would get nothing, and pressing the key marked W would get undo. Dvorak and Colemak move nearly every letter.

There was also no clipboard and no undo at all. Every edit was permanent.

## Choice

### Match on the character, fall back to the position

`shortcuts.ts` resolves a key in this order:

1. A `key` longer than one character is already a layout-independent name (`Delete`, `Escape`, `ArrowUp`,
   `F2`) — lowercase it and use it.
2. A single Latin letter or digit is taken **as typed**. This is the whole point: Ctrl+Z is the key marked Z on
   every Latin layout, which is what a menu label promises.
3. Anything else falls back to the physical position via `code`. This covers two real cases: a Cyrillic or
   Greek layout, where `key` is `я` and no Latin binding could ever match; and French AZERTY's digit row, where
   unshifted `Digit1` produces `&`.

The ordering is the design. `code` alone is wrong for AZERTY; `key` alone is unreachable on non-Latin layouts.

Bindings are **data, not an if-chain** — one table with an id, chords, a label, a `run` and an optional
`enabled`. That makes the table the single answer to "what does this key do", lets a cheat sheet be generated
from `list()`, and makes a chord bound twice throw at construction instead of one binding silently losing.

`mod` folds Ctrl and Cmd together, so one table serves Windows, Linux and macOS. Ctrl on a Mac therefore also
fires, which is the lesser evil: the alternative is every binding declared twice, and a Mac user pressing
Ctrl+Z expects undo more than they expect nothing.

A binding that is not `enabled` **does not consume the key.** That is what keeps WASD working during
play-in-place while `s` is the scale tool during editing, and it is why `isEditable` skips the layer entirely
inside a text field: typing "d" in a rename box must not delete the selection, and Ctrl+C in a number field
has to reach the browser's own copy.

| chord | command |
| --- | --- |
| `Ctrl+Z` | Undo |
| `Ctrl+Y`, `Ctrl+Shift+Z` | Redo (both spellings, since both are conventional) |
| `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | Copy / Cut / Paste as sibling |
| `Ctrl+Shift+V` | Paste as child |
| `Ctrl+D` | Duplicate |
| `Delete`, `Backspace` | Delete |
| `T`/`G`, `R`, `S` | Translate, rotate, scale tool |
| `Escape` | Cancel placement, deselect, or leave play |

### Undo by snapshot, not by command log

`history.ts` holds clones of the whole open file. The editor mutates the `Level`/`Prefab` object in place and
everything visible is already rebuilt from that object after each edit, so undo is "put the old object back and
rebuild" — a mechanism that already existed and cannot drift out of step with the edits. A command log would
need an inverse per operation, and the day one of them is wrong it corrupts the document silently.

The trade is memory: a level is a few hundred lines of JSON, so a hundred steps is well under a megabyte, and
a clone costs less than the mesh rebuild that follows it.

**Snapshots are of the root document,** `docStack[0]`, never the prefab open on top of it. Editing a prefab
from a level mutates that level's own table entry, so a root snapshot already covers it, and one history per
file is what a person expects Ctrl+Z to walk.

**A baseline clone is held one step ahead** rather than snapshotting at each mutation site. Most mutations
reach the composition root as a *notification*: the Inspector and the Hierarchy call `doc.setName`/`setProps`
themselves and then say so, by which point the old state is gone. Keeping one clone ahead costs a clone per
edit and removes the need for every call site to remember to snapshot first.

**An edit that changed nothing is dropped,** compared by stringify. Not a nicety: a click on a gizmo handle and
picking the material a piece already had both notify exactly like a real edit, and without this Ctrl+Z would
need pressing two or three times to undo one visible change — the way undo stops being trusted.

**A gizmo drag is one entry,** recorded when the drag ends. A flag suppresses the hundred `objectChange`
notifications in between, which is also what leaves the baseline sitting on the pre-drag state for that one
record to use.

**Selection is restored by sibling path** (`"0/2"`), not by index: an undone paste renumbers everything after
it, and an index would land on a different object.

### The clipboard carries prefab definitions

A copy holds the detached subtree **plus the prefab definitions it references**. An instance can name a prefab
by id, and that id resolves against the *level's* table — so an instance alone would paste into another level
as a dangling reference that `validateLevel` rejects, and would break even in the same level if the entry were
deleted in between. With the definitions along, a paste is self-contained: any id it names is interned into the
destination, and `freeTableId`'s comparison means pasting back into the source level reuses the entry rather
than duplicating it.

Instances and pieces do not interchange — a level holds instances, a prefab holds pieces — so a paste across
that boundary is **refused with a message** rather than guessed at.

## Consequences

- **It is an in-memory clipboard, not the system one.** Reading the system clipboard needs a permission prompt
  or a paste event, and a scene object is not text anybody would paste elsewhere, so that would be a
  permission dialog in exchange for nothing. The cost: copying between two editor tabs does not work.
- **Undo drops you back to the root document.** Undoing an edit made inside "Edit prefab" closes the prefab
  view, because restoring rebuilds the root and resets the stack to it.
- **Asset edits are not undoable.** Editing a material writes a file; the history covers the open document
  only. Ctrl+Z after changing a material colour does nothing, which is honest but worth knowing.
- **A collision in the real table is caught at boot, not by a test.** `createShortcuts` throws on a duplicate
  chord, and the table lives in the composition root, which imports Three.js and touches the DOM and so has no
  test harness. The throw itself is tested; the table is exercised every time the editor opens.
- **`isEditable` duck-types** on `tagName`/`isContentEditable` rather than using `instanceof HTMLElement`, so
  the layer is testable in the node test environment with no jsdom dependency — and so it still works on an
  element from another document, where `instanceof` quietly returns false.

## Rejected

**Matching on `code` throughout, i.e. physical position.** What Unity does, and defensible for the
single-letter tool keys (`T`/`R`/`S` stay under the same fingers on any layout). Rejected because it is wrong
for exactly the shortcuts that were asked for: Ctrl+Z, Ctrl+C and Ctrl+V are named after letters people read
off their keycaps, and binding them to positions makes the editor disagree with every menu and every other
application on the machine.

**`navigator.keyboard.getLayoutMap()`**, which reports the actual character for each physical key. It would
allow position-based bindings with correct *labels*. Rejected as Chromium-only, asynchronous, and unnecessary:
`key` already carries the character for the key that was actually pressed.

**A command log with per-operation inverses.** Smaller snapshots, and it scales to documents a clone could not
handle. Rejected for the size of document this is: every operation would need an inverse written and tested,
the mutation sites would all have to route through it, and a wrong inverse is silent corruption where a wrong
snapshot is merely a wasted clone.

**Snapshotting inside `Doc`** so mutations are recorded at the source rather than on notification. Cleaner in
principle. Rejected because the doc is a thin wrapper over the live object and hands out mutable references
(`transformOf` returns the actual `Transform`, which the gizmo writes into) — so it cannot see every mutation
either, and the two would disagree about what an edit was.
