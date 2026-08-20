# ADR 0048 — Lighting is level data: `config.environment`, and the hemisphere fill is a game object

## Context

ADR 0047 made lights authorable as nodes with a `Light` component, but left three things as renderer constants:
the sun, a `HemisphereLight` fill, and `scene.environmentIntensity` — the strength of the environment map the
sky bakes. None were reachable from the editor, so every level had identical lighting and there was no way to
author a night or an indoor one. The parkour debug pane could tune the sky live but saved nothing, so lighting
could be previewed and never authored.

The third one is the trap. It is **image-based lighting, not a light object**, so setting the sun to zero and
switching the fill off still leaves a level lit — dimly, and blue, because this sky's irradiance measures
`[0.19, 1.59, 4.03]` at full strength. Kodjo found exactly that.

## Decision

**`LevelConfig.environment`**, one block holding `sun`, `ambient` and `sky`. Every part optional, and the block
itself optional.

One block rather than three sibling keys because these are one subject and are tuned against each other: the
sun's angles move the sky's glow (ADR 0046), and `ambient` is the strength of the map the sky bakes. Balancing
coupled numbers across three places is how they drift. It also matches the Environment row in the editor, which
is the same thing wearing a UI.

The **hemisphere fill is a node** with a `Light` of new kind `hemisphere` — because unlike these three, it is
something a level can have several of, or none.

That split is Kodjo's, and it is the reverse of what was recommended. His reasoning is better: sun and sky are
one input, so a sun *node* would mean the sky has to chase an object somebody can drag, reintroducing the two
sources of truth ADR 0046 existed to remove.

### Optionality is load-bearing

A level that pins only its sun keeps this sky. A level written before any of this loads unchanged. So absent is
never an error and malformed always is, which is what `validateEnvironment` encodes and what its tests pin.

`applyEnvironment` takes the whole block and rebakes. Deliberately not a setter per field: setting the light
without rebaking the sky is the drift being avoided. `skyParams` is assigned key by key rather than replaced,
because it is the object the debug pane is bound to — swapping it would leave the pane editing a value nothing
reads.

### The sky's shape lives in `@mp/content`

`SkyConfig` is declared there because a level file holds it, and `@mp/content` is headless and never imports
rendering. `@mp/render-three` aliases `SkyParams` to it and keeps `DEFAULT_SKY_PARAMS`, which is a renderer
opinion rather than a schema.

### The hemisphere node's transform is inert

Three's `HemisphereLight` reads only the world Y axis. It has no position and no direction, so moving its node
does nothing. Kodjo was told this before choosing and chose it anyway; a test pins the behaviour so nobody later
"fixes" it into something that appears to work.

`groundColor` is the light coming up — the ground bounce a sky with a dark underside does not provide — gated by
`ParamWhen` to the `hemisphere` kind. `castShadow` is gated away from both `ambient` and `hemisphere`, since
neither has a direction to cast along.

### The hardcoded lights are gone, and every level was migrated

`fillIntensity` now defaults to **0** with the sky on, where it was 0.4. Leaving it would light every level
twice, once from the constant and once from the authored node.

So the six files under `content/levels/` are the only source of their own lighting, and all six were migrated:
a `config.environment` block and a `Hemisphere Fill` node, both carrying **exactly** the values that were
hardcoded (30°/38°, intensity 2.4, white; ambient 0.2; the measured sky defaults; white-over-grey at 0.4). No
level changes appearance.

### The editor surface

An **Environment row** above the Hierarchy tree, not in it, because none of this is an object. Selecting it
shows Sun, Ambient and Sky sections; every edit calls `applyEnvironment`, so the viewport relights and the sky
rebakes as you drag.

`envSelected` is its own flag rather than a sentinel index in `selection`. Every structural operation reads that
list — delete, duplicate, reparent — and a fake index in it would eventually reach one of them.

The sections are hand-built rather than generated from declarations, because none of this is a component. All
three write back together, since they are one field and a fresh level has none of them. In prefab mode the
section says so and offers nothing, and `setEnvironment` refuses there rather than writing into a wrapper level
that is never saved.

## Rejected

**The sun as a game object** (recommended, and what Kodjo first asked for before the split). A node carries
rotation, which is the natural way to aim a light, but it puts the sky's source of truth inside a draggable
object.

**The hemisphere fill as a level setting** (also recommended). Rejected for consistency: every light except the
sun is a node now.

**Three flat sibling keys — `config.sun`, `config.ambient`, `config.sky`** — which is what this ADR said in its
first draft, justified by avoiding a migration. That is not a reason to shape a schema, the migration is one
command, and Kodjo said so.

**A fallback that keeps the hardcoded lights when a level has none.** Two sources for one light, and the drift
would be invisible.

## Consequences

- Levels can now differ in lighting, completely. Nothing about how a level is lit is a constant any more.
- A level can be authored into darkness: sun 0, fill off, ambient 0. It loads, looks black, and is obviously
  fixable — preferred over a hidden floor that makes a missing light impossible to notice.
- `exposure` (1.0) and `shadowRadius` are still per-app options. Exposure is a tone-mapping concern rather than
  a lighting one, and the shadow radius is framing.
- `packages/components/src/levels.test.ts` validates every file in `content/levels/` against the real registry.
  The only test that reads `content/`, and it exists because nothing checked the authored files at all — this
  ADR's own migration is exactly the kind of thing that would otherwise have failed in a browser.
- The parkour debug pane still binds the same live `sunAngles`/`skyParams` objects, so it keeps working as a
  tuning surface. It still saves nothing; the editor is where lighting is authored now.
