# ADR 0076 — The editor refuses a prefab the game cannot load

Status: accepted, **amended by ADR 0077** — the refusal now applies only to another game's *private*
components. A *shared* component the game lacks is added to the game instead. The editor's palette greys out a
prefab file whose components the open level's game cannot have, says which, and `Doc.placePrefab` refuses it. A
level a game cannot load is no longer producible from the palette.

## Context

Kodjo placed the `Trampoline` prefab into the keyboard level. The editor accepted it. The game threw at load:

```
ComponentError: level.prefabs['Trampoline'].children[0].components[2].params: unknown component type 'Bumper'
```

A level is validated against **its game's** registry (ADR 0052; `levels.test.ts` checks every shipped level the
same way). Keyboard's registry has no `Bumper`. A prefab file is written against whichever game was open when it
was authored, and the palette offered every file to every game.

The hot fix — add `Bumper` to keyboard's registry — was proposed and rejected by Kodjo, correctly: it would have
made this one prefab load and left the door open. The next prefab, the next component, the same crash.

## Decision

**Check at the palette, refuse at the document.**

- `unknownComponentTypes(root, registry)`: the component types in a prefab tree that a registry lacks. Pure.
- `Doc.unplaceable(root)`: that list as a reason, or `null`. The document owns the registry, so it answers.
- The palette asks the host per tile and draws a foreign prefab **greyed, with the reason in its tooltip**.
  Clicking does nothing; the context menu's "Place in the level" is disabled with the same reason.
- `Doc.placePrefab` refuses a foreign prefab regardless — the palette is one door, and a level the game cannot
  load must not be producible by any.

Greyed rather than hidden: the file exists and is worth seeing; it is *this game* it cannot go into.

## Consequences

- Trampoline in keyboard: greyed, "uses Bumper, which this game does not have". In parkour: placeable.
- If keyboard wants trampolines, that is one line in its registry and the tile lights up. That is now a
  decision about the game, made in the game, rather than a crash discovered in the browser.
- 4 tests.

## Rejected

**Adding the component to the game's registry.** Fixes one prefab; leaves the editor able to author a level the
game refuses.

**Validating on save.** Later than the mistake and after the work of placing and arranging. The palette knows
before the click.

**Hiding foreign prefabs.** Makes a file look deleted from one game's point of view.

## Known open

- **Paste** across games is a second door: nodes copied from a level of one game can be pasted into another's
  and are not checked here. The game still refuses the level at load, as before.
- A level's **own** prefab table is not re-checked when the level's game is changed in the editor; the game
  refuses it at load, as before.
