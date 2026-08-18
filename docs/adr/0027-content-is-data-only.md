# ADR 0027 — Geometry is authored data; the code kit and its generators are deleted

Status: accepted. Supersedes ADR 0014's greybox kit and its parametric generators. Follows the editor
(ADR 0023/0024), nesting (0025) and the asset layer (0026).

## Context

Placeable geometry existed twice over. `@mp/content` shipped a **kit** of eleven prefab constructors
(`platform`, `ledge`, `beam`, `ramp`, `gapJump`, `movingPlatform`, `rotatingBar`, four pads) and five
**generators** that computed their pieces from parameters (`staircase`, `spiralStaircase`, `padChain`,
`curvedBeam`, plus `curvedBeamExit`, which returns where an arc ends). Everything the game showed was built
from them: `showcase.ts` — the gym, the level the mode loaded with no `?level=` — was 21 `platform` calls, 10
`beam`, 6 `padChain`, 3 `curvedBeam` and the rest.

That was the right call when there was no editor: a function was the fastest way to get geometry, and a
parametric one was the only way to get a staircase without placing eight boxes by hand.

It is not the fastest way any more. The editor places, nests, names and previews prefabs, and prefabs are
assets on disk with ids that survive a rename (ADR 0026). Kodjo's judgement: *"we used that because it was an
easier way to create geometry, but it's not anymore"*.

Keeping both had a visible cost. The Project explorer had to show a "Kit" node beside the folder tree —
placeable things that were not files, could not be previewed as files, had no folder and no id — and prefab
files appeared under it *as well as* in `prefabs/`, so the count read 17 for 15 makers.

## Choice

**Delete the kit and the generators.** `kit.ts`, `generators.ts` and their tests are gone; nothing in
`@mp/content` produces geometry any more. The package is schema, validation, resolution, the loader, and the
asset layer — a description of content, not a source of it.

**Everything placeable is data.** The editor's palette is prefab files (`*.prefab.json` assets) plus whatever
the open level already defines in its own table. Primitives — box, platform, wall, ball, capsule — stay in
prefab mode as literal pieces, because a prefab has to be built out of *something* and those are one
collider each rather than a parameterised construction.

**The gym is deleted with them,** since it was made of them.

**A default level file replaces it**: `content/levels/default.json`, loaded when there is no `?level=`. It
exists so `pnpm dev:parkour` cannot boot into an empty void. A placeholder and it says so — a floor, a climb,
a gap, an elevator, a turntable, a hazard, a checkpoint, a goal: one of each mechanic so the systems stay
exercised and visible, with every gap inside the measured envelope so it is walkable.

**It is a file, so the editor can edit it.** It was briefly a hardcoded module, on the reasoning that nothing
the editor can delete should be what stops the game starting. That bought non-deletability by making the one
level a new player sees the one level nobody could edit — the wrong trade, and unnecessary: **the editor has
no delete for levels at all.** The level routes are read and write only; deletion exists solely for assets.
So a file is already non-deletable from the tool, and editable, which is what was actually wanted.

The remaining exposure is somebody deleting `default.json` outside the editor. `levelByName` then throws and
names what it does have, rather than booting into an empty void with no explanation.

**Parametric generators in the schema were rejected for now.** They were the alternative — a prefab file
carrying `{ generator: 'padChain', opts: {...} }`, expanded at load, which would have kept the parameters
editable as numbers and lost nothing. Kodjo chose deletion instead. Worth recording what that costs, because
it is the reason the option existed: **a baked prefab cannot be re-parameterised.** Scaling covers the simple
pieces, since scale bakes into collider dimensions, but scaling a 4-pad chain cannot make it 5 pads and
scaling an arc cannot change its radius. Those shapes now have to be built piece by piece in the editor.

## Consequences

- **`gym.test.ts` is deleted (9 tests).** It asserted every authored jump in the gym against the measured
  envelope — the beam course's margins, the pad chains' gap-versus-rise. Its subject is gone. The envelope
  itself is still measured, by `packages/character/src/envelope*.test.ts`, so the *numbers* in
  `docs/obstacles.md` remain honest; what no longer exists is anything checking that authored content
  respects them. **Nothing verifies a level is clearable.** That is a real loss, and the replacement is a
  reachability check in the editor rather than a test over a fixture.
- **The viewer lost its element catalogue.** It listed every maker on its own pad, which was the way to look
  at one piece of geometry when geometry was code. It now lists level files; the editor previews prefabs and
  models itself.
- **`convex` colliders have no producer.** `curvedBeam` was the only thing that emitted them (ADR 0017), so
  the loader, the scaler and `geometryForCollider` still support a shape nothing currently creates. Kept:
  the support is correct and cheap, and swept surfaces are exactly what an imported model will bring.
- **`Doc.place` returns `-1` for a name it cannot resolve** instead of throwing. A palette entry can now
  name a file that was deleted between the panel drawing and the click landing.
- `content/prefabs/` moved into the asset tree as part of ADR 0026; with the kit gone, prefab *files* are
  the only prefabs, so there is one place they live.
- **`default.json` is a level like any other**, so it can be opened, edited and saved over. It carries no
  protection beyond the editor having no delete for levels — which is also to say that keeping the game
  bootable rests on a convention, not a guarantee.

## Rejected

**Keeping the kit in `@mp/content` and only hiding it from the editor.** Cheaper and nothing would have
broken, but it leaves two ways to make geometry and one of them unreachable from the tool that authors
content — the exact drift that had `beam`, `padChain` and `curvedBeam` shipping unplaceable for four commits.

**Baking the 15 makers into 15 prefab files.** Tempting, and it is what the simple ones amount to. Rejected
because it bakes the five generators at one parameterisation while *looking* like a faithful conversion, and
because the files would be default-sized furniture nobody chose. An authored prefab should be something
somebody meant.

**Deleting them without a default level.** `pnpm dev:parkour` would boot into nothing until a level was
authored, on the strength of prefab files that do not exist yet.
