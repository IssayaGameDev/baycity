# ADR 0163 — The Project window is folders of square tiles, under two roots

Status: accepted. Amends ADR 0161's Project panel, which drew the shared library above the game's own.

## Context

The Project panel was functional but, in Kodjo's words, bad: levels drawn as small rectangles, assets as squares,
folders as tall rectangles; a bar of a kind dropdown, a search box, a *subfolders* tick nobody could explain and a
`+ folder` button; a tree with counts and uneven indents; no way to stand at the top and walk down, as in Unity.
Levels left it for the games window (ADR 0162), so it is the asset libraries only.

## Decision

Kodjo's calls, Unity's Project window the reference:

| # | Decision |
| --- | --- |
| 1 | Built around **folders**; kind is only a filter |
| 2 | **Two roots**: the open game's own library, then **Shared** (ADR 0161) |
| 3 | The tree: folders only, one indent at every depth, a folder icon on every row, an arrow only over subfolders, no counts, no *All folders* row, its own scroll, the folder you are in lit |
| 4 | Click a root or a folder in the tree to see its folders and files as tiles; **double-click** a folder tile to go in; **click the path** to go back up |
| 5 | **One square tile** for everything, **picture and name only**; a folder is a folder icon |
| 6 | A **size slider**, from big pictures down to a **one-line list** |
| 7 | Top bar: a **+** menu (New folder, New material, Upload files), the path with each part clickable, search on the right with a **kind button** inside it |
| 8 | The *subfolders* tick goes: **searching looks in every folder** (of both roots); not searching, you see the folder you are in |
| 9 | Bottom bar: the selected item's path on the left, the slider on the right |
| 10 | Faces on a tile for who has that asset open (ADR 0159) |

A kind chosen with no text is a search too, as in Unity: "every material". The slider's size is the viewer's own,
kept in the browser.

## Rejected

- **Sections by kind** (Levels, Prefabs, Materials…). Not how the files sit on disk and in git.
- **Fixed tiles.** A folder of a hundred files wants a list; picking a material wants a big picture.
- **Kind, warnings and more on each tile.** Kodjo: picture and name.
- **A typed filter** (`t:material`). The content people would not know it exists.
- **One root, `content`.** A folder name that says nothing of what is shared.
