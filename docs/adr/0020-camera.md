# ADR 0020 — Third-person camera: wheel zoom, full overhead pitch, sphere-cast occlusion

Status: accepted. Supersedes nothing; the camera had no ADR before this.

## Context

The parkour camera was fifteen lines in the mode's composition root: a fixed orbit distance from a
pane slider, pitch clamped to `[-0.2, 1.2]` rad, and a `lookAt`. It phased through every wall in the
level, could not be raised above 69°, and had no zoom at run time.

Roblox is the reference for feel (SEED framing: "extremely simplified Roblox"), so the target
behaviours are its: the wheel zooms between a min and a max, the camera can sit directly over the
head, and geometry between the camera and the character pulls the camera *in* rather than stopping it
or being ignored.

## Decisions

**One boom, one probe.** The camera's ideal position is `target + boom`, where `boom` is the orbit
offset plus `CAM_RISE`. A sphere of `CAM_PROBE_RADIUS` is swept from `target` along that boom for its
full length, and the camera is placed at whatever fraction the sweep cleared. The camera therefore
only ever moves *along* the boom, never off it, so the point the probe cleared is exactly where the
camera lands. The look-at target is unchanged by occlusion.

**A sphere, not a ray.** The probe's radius is the clearance the camera keeps from what stopped it.
It has to beat the near plane — 0.1 m at a 60° vertical FOV puts the near plane's corner 0.12 m out —
or the wall the camera stopped against clips through the frame anyway. 0.25 m.

**A hard limit that clamps, and a soft limit that is eased toward.** The hard limit is the probe's
result for the boom as it is now; the camera is clamped to it unconditionally, and that clamp is the
entire no-clipping guarantee. Smoothing the clamp itself is not possible: anything slower than instant
means being further out than the clearance allows, which is by definition inside the obstruction —
character occluded, and the near plane in geometry while the camera crosses the wall's thickness.

So the smoothing goes on a *second* probe instead, run where the boom will be `lookahead` seconds from
now: same radius, aimed with the mouse's smoothed turn rate and the character's smoothed travel. An
obstruction about to cross the sight line shows up in that probe before it shows up in the live one,
and the head start is what lets the ease arrive before the clamp has to bite. `push-in s` and
`pull-out s` are the two half-lives; `lookahead s` at 0 disables the soft limit and restores the plain
instant pull-in.

Note which changes are smooth without any of this: clearance is continuous as the boom approaches a
surface head-on, so walking backwards into a wall never popped. Pops come from geometry entering the
boom *laterally*, at an occlusion edge, which is exactly what a lookahead in the direction of travel
and turn catches.

**The ground is not a special case.** Items 3 and 4 of the request — the camera stopping dead at the
ground, and phasing through geometry — are one mechanism. The floor is a collider like any other, so
the pitch floor is no longer structural: it is a tunable (`pitch floor °`, initially −80°) and the
probe handles what the camera meets down there. Pitching under the character now walks it in toward
the head instead of clamping.

**Orientation comes from the boom's direction, not from `lookAt`.** A fully squeezed boom puts the
camera exactly on its target, and `lookAt` then has a zero-length vector to build a basis from —
three falls back to looking along world −Z, a fixed heading that ignores the mouse. Observed as the
view snapping about 90° and the controls going dead under a low roof. The boom's *direction* is known
whatever its length is, so the camera's Euler is set from it directly (YXZ: yaw about Y, then pitch
about X, which keeps the horizon level). This also makes exactly 90° pitch well defined, so the
ceiling is a plain `π/2` with no epsilon.

**An overlap at the probe's origin is only a hit if the boom heads further into it**
(`stopAtPenetration: false`). The boom starts at the character's head, so standing under a low roof
grazes the probe sphere against the ceiling every frame. Stopping there collapsed the camera onto the
player even with the whole boom pointing down and away, clear of everything — the "camera gets super
close under a roof" report. Heading *into* the thing it starts inside still reports zero, which is
what keeps a wall the character is pressed against honest.

**Zoom is a goal plus a chase.** The wheel moves `camZoom`; the rendered `camDistance` follows it on
a half-life so a notch glides. One notch per wheel event from `Math.sign(deltaY)` only — the
magnitude is ±100 on one mouse, ±3 on another, a page height on a third — and the step scales with
the current distance, as Roblox's does, so the far end of the range is not thirty notches away.
Gated on pointer lock, so scrolling the debug pane does not move the camera.

**The player's own body is not scenery.** The probe excludes the character capsule (the boom starts
at its crown, so the probe overlaps it every frame and would report zero clearance) and, while dead,
the ragdoll's ten parts. Hazard and checkpoint pads are *not* excluded: they are solid pieces you
stand on (ADR 0014), so the camera treating them as geometry is correct.

**Your own rig is hidden when the camera is inside it, rather than floored at a minimum distance.**
A low ceiling squeezes the camera into the head, because the probe ignores your own body. Flooring the
boom would push the camera *through* the ceiling instead — trading your body for the whole world — so
the body goes and the collision stays exact. Roblox does the same (it fades own parts). Hidden, not
faded: `setVisible` on the rig root already existed for death and assembly, and a fade would need
per-part material transparency in `@mp/render-three`.

The test is against the character capsule — the rig's proportions are derived from it — as distance
from the camera to the capsule's spine less its radius, versus `rig hide m` (0.15, just over the
near plane's 0.12 m corner). A plain distance threshold from the target would hide the rig on close
passes where nothing is clipping.

Visibility of your own rig now has **one writer**, in the render loop after the camera is placed,
because three things have a say and the third needs the final camera position: death (the ragdoll has
the floor), the spawn assembly (the body has not landed), and the camera being inside you.

**Cast from the render loop, against a 30 Hz sim.** This needed `castSphere` in `@mp/physics`
(the wrapper had no general query, only the character's own downward `probeGround`) and exposed that
Rapier's scene-query index is only refreshed by `step()`. The wrapper now tracks staleness and
refreshes on demand — see `docs/physics.md`.

## Rejected

- **Rapier's `castRay`.** Cheaper, and already wrapped for `probeGround`, but a zero-radius hit puts
  the camera flush against the surface and inside its own near plane.
- **`lookAt` plus a small floor on the boom** to keep its direction defined. Two mechanisms where the
  Euler is one, and the floor is the rejected minimum-distance idea in another guise.
- **A wider probe as the soft limit** (the obvious way to see obstructions early). A fatter sphere sees
  anything running *alongside* the boom, not only what is about to cross it: a wall 0.3 m to the side of
  a 0.25 m tube is parallel, so a 0.45 m tube overlaps it along the boom's whole length and reports
  near-zero clearance. Corridors, beams and doorways would hold the camera at the character's head. The
  lookahead probe keeps the thin radius and buys the same warning from time instead of volume.
- **A fast inward ease** (~50 ms) as a compromise. Cheapest smoothing available, and it gives up the
  guarantee for a few frames of the wall in frame on every event.
- **Roblox's Popper approach — casting through the frustum's corners.** More casts for a strictly
  better result at extreme angles, where a single centre boom lets a wall clip a frame edge. Rejected
  as unrequested scope; the known limit is recorded here instead. If frame-edge clipping is reported,
  this is the fix.
- **Dollying the look-at target with the camera** (keeping the character off-centre when squeezed).
  Changes framing on every wall brush; a pure boom slide does not.
- **Folding `CAM_RISE` into the look-at target** instead of into the boom. Simpler cast, but it
  raises the aim point and drops the character in frame.
- **Colliding with the player's own ragdoll.** A corpse falling past the death spot would shove the
  camera around during the one moment the player is only watching.
- **A minimum boom length.** The literal fix for the camera reaching the head under a low roof, and it
  breaks the guarantee that matters more: below the floor the camera sits inside the ceiling and you see
  through the level.
- **A dedicated camera collider in the world.** A query is cheaper than a body, and a body would be
  pushed by dynamics.

## Known open

- The lookahead extrapolates at a constant rate, so it predicts a turn or a run continuing. A reversal
  inside the lookahead window is mispredicted: the camera eases in toward something it never reaches
  (then eases back out), or gets no warning at all and the hard clamp pops as before.

- Peers have no collider in the local world (client-authoritative relay, ADR 0011/0013), so another
  player standing between you and your character does not move the camera.
- Nothing fades or hides *level* geometry between the camera and the character — only your own rig is
  hidden, and only when the camera is inside it.
- Squeezed all the way in you are effectively in first person with no body. There is no first-person
  mode as such: the camera is still an orbit boom that happens to be short.
