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

- You see the others drag as they drag, and they see you.
- A piece you have selected is **yours** while it stays selected: the others see it dimmed with your name in
  the list and a coloured box around it, and cannot select or move it. Click elsewhere to let it go.
- Undo puts back what **you** did, even if someone moved the piece since.
- The button at the top left (*Keyboard › Roblox*) opens the **games window**: every game, its levels, and who is in
  each. Double-click a level to open it. **New level** asks for a name and creates it at once; right-click a level
  for Duplicate, Rename and Delete.
- If a change is refused (bottom bar says why), it is undone on your screen. Nothing is lost on the server.

## Prefabs: build it once, use it everywhere

A prefab is a thing you build once and place in as many levels as you like. **It is one thing.** Change it and
every level using it changes, including levels you have not opened.

**To make one:** select what you built, right-click, **Save as prefab…**. Give it a name with no spaces. It
saves into whichever folder you have open in the **Project** panel, so click into `prefabs` first.

**To change one:** click the object and press **Open** in the Inspector, or right-click it and pick *Open
prefab*. One that is placed nowhere is opened from its tile in the Project panel. You are now editing the
prefab itself, and everyone sees your edits as you make them. **Back** returns you to the level.

- There is **no Save** for prefabs or levels. Everything is saved as you do it.
- The Inspector tells you how many placements of it are in the level you have open.
- **Apply to prefab** takes the changes you made to one placement and pushes them into the prefab for
  everybody. Ctrl+Z puts your placement's changes back; it does **not** take them out of the prefab.
- A prefab whose file is deleted leaves an empty spot that says *missing prefab*. The level still opens and
  still plays.
- One tab shows one thing. To watch a prefab edit land in a level, open a second tab.

## Materials: everyone at once

Anyone can edit any material, at the same time. You see other people's changes as they make them, on every
object that uses it. Two people changing the same value: the last change wins.

- Ctrl+Z undoes material edits too, in the same order as your level edits. One colour drag is one undo.
- The icons next to an asset's name in the Inspector are the other people who have it open, in any level.
- A field with a coloured ring round it is one someone else is in right now. Hover its name to see who.

## Saving

- Nothing to press. Every change is on the server as you make it.
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

## Making a shape

Right-click in the viewport and pick **Create**: Box, Rounded box, Platform, Wall, Sphere, Capsule. Platforms
are rounded boxes, which is what everything in the game is made of.

- **Scale is the size.** A platform 6 m wide, 0.5 m thick and 6 m deep is scale `6, 0.5, 6`. Nothing else.
- The **Model** field in the Inspector (under Mesh Renderer) swaps between the six, or an uploaded model.
- Rounded corners stay the right size however you scale it.
- A few old pieces still keep their size in the collider's *half extents*. Those read `size is in the
  collider` and are the exception; ask Kodjo before reshaping one.

## What goes where

- **Obstacles are prefabs.** Make one with *Save as prefab…*, then place it in as many levels as you like.
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
