# ADR 0181 — Data assets

Status: accepted. Extends ADR 0159 (data-file assets are live documents) and ADR 0161 (per-game libraries).

## Context

Kodjo wants Keyboard boards to share a look — a palette, later more — defined once and referenced from each
Keyboard component, as a Unity ScriptableObject would be. Asset kinds were fixed (prefab, model, material, shader,
texture, sound, font). A material came closest — a shared file with typed fields, live-edited, its own Inspector,
dropped on component fields — but its fields are its shader's, and it cannot hold anything else. Kodjo: build the
backend now, holistically, with a placeholder type; the style's real fields come later.

## Decision

- **A new asset kind, `data`**: `<name>.data.json` holding `{ type, fields }`. One typed-asset path with two places
  fields are declared: a material's by its shader, a data asset's by a **data type** in a game's code
  (`defineDataType`, the component parameter kinds). Live editing, undo, field rings, the asset Inspector, Used by,
  the needs list and loading are the materials' path, not a second one.
- **Each game keeps its own** (Kodjo): a game declares its types (`ModeDescriptor.dataTypes`); a data asset of one is
  made only in that game's library, never in Shared, and never moves to another library. The server, which has no
  game's code, enforces the library by kind and the shape by `isDataAsset`; the editor checks fields against the type.
- **New data › folders › type**, from each type's own menu path (Kodjo: classify as wanted), as Unity's
  `CreateAssetMenu`.
- **A component points at one** with an asset field `{ of: 'data', dataType }`: the picker and a drop take only that
  type. The game reads one with `levelHost.data(id)` and `readData(def, asset)`.
- **Keyboard Style**, Keyboard's first type, is a placeholder: one field, nothing reads it.

## Rejected

- **Materials moved onto data types now.** Every material file rewritten for nothing anyone sees; they already share
  everything but where their fields are declared, so it stays possible.
- **Fields on the Keyboard component itself.** Every board would carry its own copy; a look shared by many boards is
  the point.
