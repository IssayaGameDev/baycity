# ADR 0040 — One context menu, and the commands it made reachable

Status: accepted.

## Context

Kodjo asked for right-click menus, naming three targets: a game object in the Hierarchy, blank space in the
Hierarchy, and an asset in the Project panel.

Surveying first turned up that most of what a menu would offer **already existed and could not be found**:

- Rename was double-click only, in both panels.
- Extract to prefab and Open prefab lived in the Inspector's header, reachable only after selecting.
- Copy, Cut, Paste-as-child, Duplicate and Delete were keyboard-only from the Hierarchy.
- Delete and Duplicate on a node inherited from a prefab **did nothing, silently**. No message, no disabled
  control — indistinguishable from a broken editor.

And three menus already existed, none of them alike: the timeline's right-click on a key, the Inspector's `⋯`,
and the Project panel's `window.prompt()` **in which clearing the name deleted the file** — a folder and all
its contents included. A blocking dialog whose empty state is destructive, reached by the same right-click that
now opens a real menu.

Four things a menu would offer did not exist at all: creating an empty object, focusing the camera, pasting at
a point, and finding an asset's usages.

## Choice

**One module, `menu.ts`, hand-rolled.** A menu library would be a new runtime dependency for about two hundred
lines, and the tree already had a `.menu` class and two working implementations to consolidate. Kodjo asked
whether a library was coming; this is the answer and the reason.

**An item is `{ label, run, enabled, why, hint, items }`** — the same shape `shortcuts.ts` uses for a key
binding, so a command reachable from the keyboard and from a menu is described once. `hint` shows the shortcut,
so the menu teaches the keyboard rather than replacing it.

**A disabled item stays, greyed, with `why` as its tooltip.** The alternative — omitting it — teaches nothing,
and the case that motivated the whole survey was an operation that silently did nothing on an inherited node.

**Placement flips, it does not clamp.** A clamped menu sits *under* the pointer, so its first item is whatever
the cursor happens to be over: that is how a right-click near an edge becomes an accidental delete. Both
`menuPlacement` and `submenuPlacement` are pure and tested, because the failure is invisible until somebody
right-clicks near an edge — which, in a panel docked to the right of the window, is most of the time.

**Submenus** open on hover or ArrowRight, sit beside the parent item with a three-pixel overlap so diagonal
travel has no gap to fall through, and flip to the parent's left when there is no room. A submenu overhanging
the bottom *slides* rather than flipping, because flipping would cover its own parent. Escape and ArrowLeft
close one level; the deepest first.

**Nothing is highlighted when a menu opens.** A menu that opens pre-selected is a menu where Enter deletes
something.

**Right-clicking a row or an object selects it first.** A menu that acts on a different object than the one
under the pointer is the classic way to delete the wrong thing.

### The viewport opens on the release, not the press

OrbitControls pans on right-drag, and `contextmenu` fires on the *press* — at which moment there is no way to
know whether a pan is starting. So the viewport menu opens on `pointerup`, after checking the pointer moved
less than four pixels. Both gestures share the button and neither has to be rebound.

### Commands this needed, which did not exist

- **`Doc.placeEmpty`** — a node with only a transform, Unity's Create Empty. It is the only thing in the
  document that makes a *grouping handle*; before it, the only way to get one was to place something and delete
  its components.
- **`focusSelection`** — frames the selection along the camera's **current** direction, so framing something
  never also spins the view, which is the one thing that makes a focus command disorienting. Sized from a
  bounding *sphere*, not the box diagonal, so a long thin platform is framed by its length rather than by a
  corner-to-corner measurement. Bound to `F` as well, because the menu shows that hint and a menu that lies
  about a shortcut is worse than one with no hint.
- **`pasteAt`** — the first item lands on the point and the rest keep their offsets, so pasting a group of five
  puts the group where you clicked instead of collapsing it onto one spot.
- **`Hierarchy.beginRename`** and **`Hierarchy.setAllOpen`** — the panel's private state, exposed for the two
  entries that need it. Collapse-all is the one that earns its place: thirty placements each showing their
  prefab's nodes is a hundred rows of which you want four.

`Find usages` was offered and not picked, so it is not built.

## Consequences

- **A latent bug surfaced.** The canvas's `pointerup` handler checked no button, so a right-click that did not
  move ran the whole click path — placing the armed prefab and moving the selection on its way to opening a
  menu. Now left-button only. It would have been blamed on the menu.
- **Two menus can no longer be open at once.** The Inspector and the timeline take the shared instance through
  their hosts rather than building their own, so dismissal — Escape, a press elsewhere, a scroll, a resize, a
  window blur — is written once instead of three times, two of them incompletely.
- **The timeline's key menu got a submenu.** Its five easings were five of eight flat entries and pushed Delete
  to the bottom.
- **A folder's delete says how many assets go with it** and confirms. A file's does not: it is one thing, and a
  confirm on every deletion is a confirm nobody reads.
- **Rename still uses `prompt`.** An inline field in a tile grid is its own piece of work, and a name is
  genuinely a question. What is gone is the version where cancelling into an empty string deleted the file.
- **The `contextmenu` handler on the canvas is redundant** — OrbitControls already suppresses the native menu
  there. Kept so the behaviour does not depend on its internals.

## Rejected

**A menu library.** A new runtime dependency, for a component whose entire behaviour is placement, dismissal
and a keyboard walk, in a codebase that already had two implementations of it.

**Submenus on click only.** Fewer moving parts, no hover timer. Rejected because every menu anyone has used
opens submenus on hover, and a hover timer is ~10 lines.

**Omitting refused operations instead of greying them.** Shorter menus, and it hides exactly the thing that
sent me looking: on an inherited node, "why did nothing happen" is the question, and an absent entry answers it
no better than silence.

**Letting the native menu through on the canvas.** Would have avoided the pointerup dance, at the cost of the
browser's menu appearing over the viewport.
