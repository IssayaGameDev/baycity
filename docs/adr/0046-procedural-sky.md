# ADR 0046 — A designed gradient sky, and the sun as a single input

## Context

ADR 0045 hung a 2048x1024 photograph behind the scene as `scene.background` and deliberately left the lighting
alone, because an 8-bit sRGB sky carries no sun. That left three problems: the sky was soft (about 5.6x
magnification at 1080p), it could not light anything, and the key light pointed nowhere near the sun in the
image. Measured off the equirect by luminance-weighted centroid, the photo's sun sits at **8.4° elevation,
-96.4° azimuth**, while `sunPosition` `[18, 30, 14]` is **52.7°, 37.9°**. Forty-four degrees too high and a
hundred and thirty-four off in bearing.

Matching them meant analysing the image at load to recover the sun. Going procedural means never having to.

## Decision

### The sun is one input

`GreyboxEnvironmentOptions.sunPosition` is replaced by `sunElevation` and `sunAzimuth` in degrees. Those two
numbers drive the key light's position, its shadow frustum, the sky shader and the environment map. A raw vector
plus an independently-lit sky is how a scene ends up lit from a direction its own sky disagrees with, which is
the state ADR 0045 left things in.

`sunDirection` uses the same convention as three's `equirectUv` (`azimuth = atan2(z, x)`, `elevation = asin(y)`)
so an angle measured off an equirectangular image lands where the image shows it.

Default **30° elevation** (Kodjo): shadows run 1.73x the caster's height, against 0.76x before. Default **38°
azimuth**, the bearing `[18, 30, 14]` already had, so elevation is the only deliberate change. A test pins that
equivalence.

### The sky is a designed gradient, not atmospheric scattering

A hand-written `ShaderMaterial`, about 30 lines of GLSL:

```glsl
float t = pow( clamp( dir.y * 0.5 + 0.5, 0.0, 1.0 ), gradientBias );
vec3 color = mix( bottomColor, topColor, t );
color += glowColor * glowStrength * pow( max( 0.0, dot( dir, sunDir ) ), glowSharpness );
```

**Monotonic by construction.** `t` rises with height and `pow` preserves that, so no combination of parameters
can put a bright band between the two ends. The failure mode is unrepresentable rather than tuned away. There is
no horizon and no ground as separate concepts; the horizon is a point on the way down.

Parameters: `topColor`, `bottomColor`, `gradientBias`, `gain`, `glowColor`, `glowSharpness`, `glowStrength`,
`sunDiskIntensity`.

Defaults `#2f86cc` over `#0a1424`, bias 1.15, gain 2.6, chosen by evaluating the ramp through three's ACES and
the sRGB encode rather than by eye. Resulting luminance: **zenith 0.58, 30 up 0.47, horizon 0.32, 20 down 0.20,
50 down 0.05, nadir 0.01**, holding a blue hue throughout (`#91d0ed` to `#04122b`).

`gain` 2.6 is not a mistake. ACES desaturates highlights hard, so a saturated input must be driven well past 1
for its chroma to survive: authoring `#a8d2f0` at gain 1 measures out as `#c8d9e3`, a grey.

### Baked to a cubemap, not drawn per frame

`createProceduralSky` renders into a `WebGLCubeRenderTarget` (512 per face, `HalfFloatType`) and builds a PMREM
from the same bake. A fixed sun makes a fixed sky, so per-frame evaluation would re-render an image that never
changes; rebaking is what a slider does.

Baking also avoids three problems a sky mesh in the scene has: it must be scaled inside the camera's 1000 far
plane and a box big enough to enclose a level has corners past it; it must follow the camera or the horizon
parallaxes; and GTAO renders its own depth pass with an override material, so a sky shell can land in that
buffer and halo every silhouette.

Resolution is a non-issue: a gradient has no detail to resolve, so 512 per face (the same 5.7 texels per degree
the photograph had) is already past the point where more helps.

The shader writes **linear radiance** and includes no tonemapping or colour-space chunk, so ACES runs exactly
once, at output. `WebGLBackground` tone-maps a non-sRGB background (`WebGLBackground.js:150`), and the
half-float target is `NoColorSpace`, so that is confirmed rather than assumed.

### The environment map is disc-free

The bake runs twice into one target: PMREM first with `sunDiskOn` at 0, then the background re-rendered with the
disc on. The `DirectionalLight` already is the sun, and at these magnitudes the disc carries more irradiance than
the whole sky, so counting it twice would make the duplicate the brightest thing lighting the level.

### The sky lights the scene at 0.2, with a neutral counterweight

A saturated sky makes a saturated light. Measured irradiance from the environment map at full strength on an
up-facing surface: **`[0.19, 1.59, 4.03]`** — blue twenty-one times red, and stronger than the 2.4 key light. It
washed the level blue and flattened its shadows. The red channel at 0.19 is what does the damage: a warm
material gets essentially no fill, which kills a palette in shadow.

Two causes, only one of which is intensity. The other is that the environment map has a near-black lower
hemisphere where a real scene gets roughly neutral sunlight bounced off the ground.

`scene.environmentIntensity` defaults to **0.2** and the `HemisphereLight` comes back at **0.4**, white over mid
grey: white to restore the red channel, grey below to stand in for the missing bounce. Total on a floor becomes
`[0.44, 0.72, 1.21]`, blue to red 2.8x, at about half the key light. `environmentIntensity` is independent of
`backgroundIntensity`, so this does not dim the sky you look at.

### Everything is on the parkour debug pane

Sun elevation and azimuth, the eight sky parameters, `env light`, `neutral fill`, `sun W`, and a `backdrop`
toggle between the gradient and the ADR 0045 photograph. None of these can be chosen in the abstract, and the
photograph is the control: the toggle swaps the **background only**, so it compares two backdrops under
identical light.

## Rejected

**Preetham atmospheric scattering** (`three/examples/jsm/objects/Sky.js`), which this shipped as first, twice.
Its defining behaviour is that the horizon is brighter than the zenith, because that is what looking through
more air does. That is the opposite of the shape wanted here, and it is not a parameter:

- Measured, it put a band of luminance 0.64 between a 0.22 zenith and the ground. A bright strip across the
  middle of the sky.
- Its optical depth is `acos( max( 0.0, dot( up, direction ) ) )`. That `max` clamps at the horizon, so **every
  direction below it renders as the horizon value** — a flat `#c6c6c6` slab over the entire lower hemisphere,
  which is most of what a player sees, and no parameter reaches it.
- Mie is forward scattering, so it heaps brightness around the sun; at `mieCoefficient` 0.008 the region near
  the sun hit 8.6 radiance against a 0.9 zenith, and ACES saturates above roughly 2.
- Turbidity is not "pale haze" at a fixed exposure. It lifts horizon radiance, and lifting it means clipping it.
  Haze reads as white, not as soft.
- Its output passes through `pow( texColor, vec3( 1.0 / ( 1.2 + 1.2 * vSunfade ) ) )`, a hand-rolled tone curve
  predating ACES in the engine. Display-referred, so baking it as linear radiance tone-maps twice: a mid sky of
  0.19 radiance reaches 0.885 sRGB.

Reasoning about it in the abstract produced a white sky twice. Evaluating the function in JS produced usable
numbers once. Dropping it also deleted the shader-patching machinery and its anchor guards, so a three upgrade
can no longer silently disable the controls.

**Analysing the photograph at load** to recover its sun. Roughly 120 lines plus an 8 MB canvas readback, and its
failure mode is invisible: swap the sky and the lighting quietly stops matching, with nothing broken.

**A live sky mesh.** Infinite resolution and zero VRAM, against the three problems above. The right call for a
continuous day cycle, where a bake stops amortising.

**A separate, neutralised environment bake** — its own bounce colour, desaturation and intensity, using the
disc-free pass that already exists. Addresses the blue cast directly rather than diluting it, and is the better
mechanism: the two knobs shipped instead scale a 21x cast down without correcting it, so they get balanced
against each other by eye. Kodjo chose the cheap pair. Revisit if the cast returns.

**Clouds.** Parked deliberately, and named as the next item.

## Consequences

- **The sky has no features.** A vertical ramp plus a sun glow, identical in every direction but the sun's. Not
  a quality problem, an emptiness problem, and clouds are the fix.
- **No night, no stars, no moon.** The ramp has no notion of the sun being down; it would need authoring.
- 862 KB of download and about 11 MiB of texture leave with the photograph, replaced by roughly 12 MiB of
  half-float cubemap. Even on memory, a clear win on transfer. The webp and `installSky`/`loadSky` survive only
  as the comparison toggle and go when it is settled.
- `sunIntensity` stays at 2.4 and is on the pane, untuned, because how bright the sun is is a look decision.
- `fogFar` is still unused and there is still no fog. Fog tinted to the bottom of the ramp is the biggest
  remaining integration win and it costs view distance, so it is a decision, not an omission.
