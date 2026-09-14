# Making content

You build levels and obstacles in the editor at **https://editor.playgorbo.com**. Nothing to install.

## Getting in

1. Open the link. Type your email, you get a code by mail, type it in. That is the login.
2. Only listed emails get in. If yours is refused, ask Kodjo to add it.
3. Your name shows at the left of the bottom bar. Everything you save is recorded under it.

## Levels are shared, live

Several people can have the same level open. Every move, every placed piece shows up on the others' screens
within a second. There is **no Save for levels**: each change is saved as you make it. The bottom bar says
*live · with X* when someone else is in.

- Undo puts back what **you** did, even if someone moved the piece since.
- **New** asks for a name and creates the level at once. **Duplicate** copies the open level under a new name.
- If a change is refused (bottom bar says why), it is undone on your screen. Nothing is lost on the server.

## Prefabs and materials: one person per file

When you open a prefab, it is **yours** until you open something else or close the tab. Anyone else who opens
it sees it read-only, with your name on it, and their Save button is off.

- If the file you want says *locked by X*, ask X, or work on something else. There is no force-unlock.
- A tab that died (crash, laptop shut) lets go of its files after two minutes.
- Materials work the same: clicking one takes it; someone else editing it is refused.

## Saving

- **Save** (prefabs) writes to the server at once. Levels write themselves. Your work is never on your machine.
- Everything you changed is recorded as one entry in the history when you switch files or close the tab, and
  every ten minutes while you keep it open. Kodjo can see and undo any entry.
- A red *not on GitHub yet* in the bottom bar means the server could not upload history. Your files are safe;
  tell Kodjo.

## Textures and models

Drag a file from your desktop onto a folder in the **Project** panel (bottom), or onto the tiles of the folder
you are looking at.

- Allowed: `.png`, `.jpg`, `.webp`, `.ktx2`, `.glb`. Not `.gltf` — export a `.glb` instead.
- Max size is 10 MB per file.
- Dropping a file with the same name into the same folder **replaces** it everywhere it is used.

## What goes where

- **Obstacles are prefabs.** Make one, save it, place it in as many levels as you like.
- **Levels** are big. Work on the same one together, or split by area; say what you are touching.
- Do not rename or delete files you did not make without asking. Deleting a material breaks every piece using it.

## Playing

**Play** in the editor's toolbar, with a level open, runs the real game on it as it is right now, there in the
viewport: HUD, progress, everyone else who is playing that level. **Stop** brings the editor back. Esc inside
the game is its pause menu, not Stop.

The same game is at **https://dev.playgorbo.com**, same login, if you want it in its own tab. People are
together when they are on the same level. This is not the public game, it is the three of us.

## Where it ends up

Nothing you save is in the game until Kodjo has played it and merged it. Ask him when you want a look.
