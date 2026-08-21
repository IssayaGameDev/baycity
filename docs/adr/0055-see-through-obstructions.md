# ADR 0055 — An obstruction dithers away instead of shoving the camera

Status: accepted. Amends ADR 0020, which pulled the boom in for everything.

## Context

ADR 0020 gave the camera one sphere cast and one rule: the camera sits wherever the sweep cleared. That is
Roblox's behaviour and a good default, but it means a railing, a beam or a platform's lip yanks the view
across the level for a fraction of a second and puts it back.

Kodjo asked whether the obstruction could go locally invisible instead, with a shader.

It can — but **the pull-in was doing two jobs.** It kept the character visible, and it kept the camera out
of places it has no business being. Only the first job goes to the shader, and every problem this ADR
records came from forgetting the second.

## Decision

### One rule for the camera

The obstruction is holed and the camera keeps its distance, **unless** the camera would end up

- **inside solid** — the near plane in geometry, looking at the level's backfaces, or
- **below the character's feet** — where a hole is a view of the level's underside.

In either case the camera stops at whatever the sweep cleared, exactly as ADR 0020 made it stop. So the
behaviour changes where the pull-in read worst and nowhere it was load-bearing.

`modes/parkour/src/cameraOcclusion.ts`, pure with the physics queries injected, so it is tested against
slabs on a number line rather than needing a world.

**"Inside solid" needs a query a cast cannot answer.** `castSphere` deliberately ignores an overlap it is
*leaving* (ADR 0020 — the boom starts at the character's crown and would otherwise report zero every
frame), so from inside a wall it reports clear air. Hence `PhysicsWorld.sphereOverlaps`.

**"Below the feet" is about the camera, not about the surface.** Nothing in a level says which collider is
the ground and nothing should: the ground *is* a platform. Three sharper-sounding tests were tried and all
three were worse — see Rejected.

### Several sightlines, not one

The camera aims a metre above the capsule's centre, level with the top of the head. A platform can lie
across the whole body with the head clear above it, and a single cast reports nothing in the way. So the
boom is cast plus two more probes down the spine — the capsule's centre and the base of its spine, whose
caps the probe's own radius covers.

Casting to a few body points is what most third-person cameras do, and it is the cheap end of the options.
Frustum-corner casts (Roblox's Popper) sample a fan spreading *away* from the character: more casts, and
they still miss a narrow beam that falls between the rays. They answer a different question — what is
clipping the frame's edges, which is ADR 0020's known limit and still open.

### Only the surfaces actually in the way wear the hole

`packages/render-three/src/cutout.ts` plus `levelView.setOccluders(handles)`. A cast answers with a collider
handle; `VisualItem.colliderHandles` is the way back to the mesh. Those meshes get a **masked copy** of
their material while they occlude, and their plain one back afterwards.

A copy, because materials are cached by asset id in `assetRuntime.ts` and shared by every piece using them,
and only some of those pieces are in the way. One `onBeforeCompile` closure across every copy, so
`Material.customProgramCacheKey` — its source text — matches and they share one compiled program. The view
owns the copies and disposes them, like the geometry it builds.

This is the part that took three attempts, and the reason is worth keeping: **no test on a fragment's
position can tell the platform overhead from the floor beside the character's feet.** From a high camera the
floor is both nearer to the eye than they are and right beside the sight line. The sightline is the only
thing that knows which is which, and the sightline is a cast.

### The hole is a dithered cone, animated as an aperture

**A cone**, not a cylinder: it runs from the eye to the character's middle, widening to `radius` there and
holding that width beyond. A cone subtends a constant angle, so the hole is the same size on screen at 3 m
of zoom and at 14. Centred on the capsule's **middle**, not on the camera's look target — that is framing,
and it sits at the top of the head, which leaves the feet outside the hole.

**Dither**, not alpha: `discard` against interleaved gradient noise, so the copy stays opaque. No
transparency sorting, no `renderOrder`. Discarded fragments write no depth, so what is behind shows
through. Not a Bayer matrix — Three compiles its built-ins as GLSL ES 1.00, which forbids indexing a
constant array by a non-constant expression.

**The ease drives the radius, not the strength.** Ramping the dither's strength puts the whole disc through
a stipple on the way in and out, which across a wide surface is a great deal of crawling noise. Growing the
radius keeps the interior fully cut from the first frame, so stipple only ever lives in the feather ring and
the hole reads as an aperture opening around the character.

### Ambient occlusion has to be told, shadows must not be

**AO.** GTAO is screen-space: it reads depth and normals from a prepass of its own and multiplies the result
onto the colour image, which only holds while the two agree about what is at each pixel. A surface that
discards its own fragments breaks the agreement — the colour image has the character there, the prepass
still has the platform — and the character comes out wearing occlusion cast by something the player cannot
see. `PostFXOptions.aoIgnores` names the occluding meshes and two tiny passes bracket the AO pass to hide
them for it, so the prepass sees the character exactly where the colour pass drew it. The occluder loses its
own AO while holed, which on a flat slab is next to nothing.

**Shadows are deliberately untouched.** A surface whose pixels are gone still shades the level, so the world
does not brighten as the camera moves, and the character standing under a platform is in shade because they
are in shade. A hole in a shadow is not a thing (see Rejected).

`sun shadows` and `ambient occl.` are checkboxes in the Camera pane. They exist because a hole in a surface
leaves behind whatever *shading* that surface was responsible for, and no amount of looking at a screenshot
tells you which pass is doing it. They earned their keep immediately: the artifact that survived four fixes
was AO, and one toggle proved it in five seconds.

## Consequences

- One cast on a frame with nothing in the way. Two more probes plus one overlap query when there is.
- Four tunables under Camera — `hole m`, `hole edge`, `hole open s` — plus the two diagnostic toggles.
- `PhysicsWorld.sphereOverlaps` is new and general: "is this spot free", which nothing could ask before.
- `VisualItem.colliderHandles` is new: the link from a query's answer back to the thing on screen. A node
  drawing a model lists every collider it owns against its one mesh.
- `LevelViewOptions.cutout` is opt-in, so the editor and the viewer pay nothing at all.
- Tests: 16 on the decision, 21 on the mask (the cone's geometry, the shader edit, the uniform sharing), 9
  on the level view's swap, 7 on the new physics query.
- The **GLSL itself is not run** — `cutoutCoverage` in `cutout.ts` is the tested copy and `FRAGMENT_BODY`
  transcribes it, a seam that can drift and is labelled as such in both places. `injectCutout` hooks two
  string anchors in shaders this repo does not own, so there are tests against `THREE.ShaderLib.standard`
  and `.basic` themselves: a Three upgrade breaks a test rather than the picture.

## Known open

- **Frame-edge clipping**, inherited from ADR 0020: a wall can miss every sightline and still poke into a
  corner of the frustum. Frustum-corner casts are the fix if it is ever reported.
- **The dither swims** with camera motion — interleaved gradient noise is screen-space. A static
  blue-noise or halftone pattern would sit still and read as a deliberate texture.
- **The camera can still sit in a neighbouring interior.** A room's wall is thin and the far side is air, so
  the camera is neither in solid nor below the feet. Not distinguishable from a balcony by any local
  measurement, and not reachable in the parkour levels, which are open platforms.
- Point lights that cast shadows use a separate distance material; nothing about them was touched. They are
  off by default and capped at four (ADR 0047).

## Rejected

**Fading whole occluding objects out** (per-object opacity). Half the work, and it breaks on the common
case: most of what occludes you is a large wall or floor, and fading one whole shows the void behind it.

**Dropping the pull-in entirely.** The request taken literally. It gives up ADR 0020's no-clipping
guarantee and puts the near plane inside geometry.

**Drawing the rig a second time with `depthTest: false`** (an x-ray silhouette). Cheapest of all, and it
shows a flat ghost of the character floating over a solid wall while doing nothing about the camera being
inside that wall.

### Three ways of masking by position, all wrong

Recorded because each looked right on paper and each shipped a visible artifact.

1. **The cone alone, stopped short of the character.** The cut is a plane perpendicular to the view, so it
   slices the hole into a **half circle** with a hard straight edge, and it swallows whatever is nearer to
   the character than the cut — which is exactly a low ceiling, left completely solid.
2. **A depth slab from the probe's own two hits.** Correct only for a surface square-on to the view. An
   oblique platform's depth varies across its face, so the hole came out as a **band** across it.
3. **Cutting the cone out of the AO pass's override material.** Fixed the AO mismatch by deleting
   *everything* inside the cone from that pass, character included, so the rig lost its own contact shading.

The lesson each time was the same: position cannot separate the obstruction from the floor. Masking only the
meshes a cast names is what settles it, and then the cone needs no second test at all.

### And three ways of protecting the floor

**A thickness allowance** (`camSeeThroughMax`), on the theory that a hole through a large solid is a window
into nothing. Killed by the ordinary case — standing under a wide platform with the camera plainly above it,
where the camera is in open air and the hole is exactly right. It also made the camera flip between moving
and seeing through as it orbited, because a slab's *chord along the boom* grows without bound as the
crossing gets shallower. Dividing the crossing angle back out fixed the flip and not the case.

**Keying on the collider the character stands on.** Collapses the camera into the head on the most common
surface in the game, which is the behaviour the hole exists to remove.

**Clamping how far the camera may pitch down** to whatever keeps it above the surface underfoot. Keeps the
distance, but freezes the orbit outright — on flat ground at full zoom the camera could not go more than
about 19° below the aim point. Worse than the problem.

**Testing the _hit's_ height against the feet** rather than the camera's. Does nothing at all: a sphere
sweep stops its own radius short of what it meets, so a hit on the floor underfoot reports a centre a
quarter of a metre *above* the feet and the branch is unreachable.

### And one way of hiding a shadow

**A hole in the shadow map**, via a `customDepthMaterial` carrying the same cone. The cone is aimed at the
camera and the depth map is rendered from the sun, so the hole casts a beam along the sun's direction and
lands beside the character — a straight-edged lit patch sliding across the body. It was also solving a
problem that turned out to be AO.
