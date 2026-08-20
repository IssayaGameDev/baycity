# ADR 0047 — A light is a node with a `Light` component

## Context

Nothing in the editor could make a light. The only lights in existence were the two
`applyGreyboxEnvironment` creates: the sun (a `DirectionalLight` driven by the sky's sun angles, ADR 0046) and a
`HemisphereLight` fill. Both renderer-owned, neither authorable.

A light has a transform, wants to be parented, prefabbed and overridden, and has a handful of typed parameters.
That is the definition of a node with a component, and the component system (ADR 0035) was built for exactly
this shape.

## Decision

`Light` joins `ENGINE_COMPONENTS`. **Singleton**, as in Unity — a node wanting two lights has two children.

Kinds: `point`, `spot`, `directional`, `ambient`. Parameters `color`, `intensity`, `range`, `decay`, `angle`,
`penumbra`, `castShadow`, gated by `ParamWhen` so a point light does not offer a cone angle and an ambient light
does not offer shadows. That mechanism had had **no user** since ADR 0039 removed its only one; a component with
four modes is what it was for.

`directional` and `spot` shine along the node's **forward** (`-Z` rotated by its transform), Unity's convention.
`point` ignores rotation, `ambient` ignores both.

### The sun is not one of these

It stays with the sky, where one pair of angles drives the key light, its shadow frustum and the sky itself
together (ADR 0046). Making it a prop somebody can drag would put the scene back to being lit from a direction
its sky disagrees with, which is the exact problem ADR 0046 existed to close. Content lights are *additional*.

Kodjo's call, and the reason exposing the sky itself in the editor is a separate, later job.

### `castShadow` defaults off, and there is a cap

**Three renders forward.** Two consequences that Unity's clustered forward path hides:

- Every light costs per-fragment work on every lit material, and the light count is compiled into the shader, so
  adding or removing one recompiles programs. Single digits of visible lights, not dozens.
- A shadow caster is a whole extra scene render per frame, and a **point** light is six of them, because its
  shadow is a cube map. `shadowPassesFor` is that number.

So `castShadow` defaults to `false`, and `addLights` caps casters at **4** by default, spending the cap only on
lights that actually asked. Ten shadowed point lights would otherwise be sixty extra scene renders against
budget 1 (16 ms, mid Android, still unmeasured). `ContentLights.cost` reports what was spent.

The cap number is a first guess and belongs to whoever can measure it, which is not this document.

### Where the code lives

The existing seams took it without argument:

- `@mp/content` gains `WorldLight` and `LoadedLevel.lights`. Headless data — kind, colour, numbers, a world
  pose. This package still does not know what a `THREE.Light` is.
- A light gets **its own `Dynamic`** rather than riding a collider's, because a node's light is independent of
  its collider count and a moving lamp may have no collider at all. `render` carries its pose like a visual's.
- `render-three/lights.ts` is the only file that knows what a spot light is. `createLight(desc, casts)` builds
  one; `addLights` positions a list of them and re-poses the moving ones.
- `LightDesc` is the shape with no position, so the editor and the game build lights from one implementation.
  `WorldLight` satisfies it structurally, so the loader's list needs no conversion.

### The editor needed a gizmo to have anything to click

A light node has no `Renderer` and no `Collider`, so `meshSpecs` returns nothing and there is nothing under the
cursor. `lightGizmo` adds a wireframe — a sphere, or a cone down `-Z` for a spot — into the node's own mesh
holder. That group already carries `userData.index`, so the existing pick walk finds it with no new code, and
the group's transform places and aims the light for free.

The editor also adds the **real** light, so the viewport shows what the level will look like. Play mode hides
`instanceRoot`, which hides those lights with it, so it builds its own from `loaded.lights`.

### A `color` parameter kind

The component parameter layer had no colour: nine kinds, none of them one. Added, validated as `#rrggbb`, so a
typo is rejected at load instead of reaching a shader as black. Materials have had a colour kind since ADR 0026
but that is the *shader* parameter system, a different layer.

### The Inspector switch now has an exhaustiveness guard

Declaring the kind was not enough. `inspector.ts` maps a parameter kind to a widget with a `switch`, and a kind
with no case renders **nothing** — no field, no error, nowhere. That is how this first shipped: a `Light`
component with no colour control.

The switch now ends in a `default` that assigns `spec` to `never`, so the next parameter kind fails typecheck
until it has a widget. The missing case was cheap; the silence was the problem.

The widget passes no `view` option, and the comment there says why: Tweakpane's string-colour plugin picks the
picker up from the value's *format* and only declines when told `view: 'text'`. Passing `view: 'color'` reads as
forcing it but does nothing, because `BaseInputParams` extends `Record<string, unknown>` — so any key, a typo
included, typechecks and is then ignored. What actually keeps it working is the declaration layer rejecting
anything that is not `#rrggbb`, which is the format the plugin detects.

## Rejected

**Making the sun a content light.** Above.

**`HemisphereLight` and `RectAreaLight` as kinds.** Hemisphere overlaps `ambient` and is already what the
environment's fill is, so a content one invites two things called fill. `RectAreaLight` needs LTC lookup tables
and cannot cast shadows at all.

**Baked lighting.** No lightmapper in this stack, and adding one is a different project.

**Letting a light cast unconditionally.** The forward-rendering cost above. A cap that reports what it dropped
beats a level that silently runs at 8 fps on a phone.

## Consequences

- Nothing on the wire. Lights are visual only, so no protocol change and no netcode risk.
- Prefabs, per-node overrides and `Track` parenting all came free, which is the return on ADR 0035. The
  Inspector *nearly* did: it generated every field from the declarations without being told about `Light`, and
  needed editing only because `color` was a parameter kind it had never seen.
- A level can still be authored into a performance problem: nine unshadowed point lights are legal and slow.
  The cap only bounds *shadows*.
- `ParamWhen` finally has a user, so its gating is now exercised by real content rather than only by its test.
- The viewer realizes lights too, so inspecting content shows its lighting.
