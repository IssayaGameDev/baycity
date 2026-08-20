# ADR 0045 — An equirectangular sky as the background, and lossless WebP for source images

## Context

`applyGreyboxEnvironment` gave the scene image-based ambient from a `RoomEnvironment` PMREM and left
`scene.background` as whatever the stage set: a flat `0x0b1020` navy. Levels floated in a void.

The source (`sky_110_2k`) arrived as a 2048x1024 equirectangular PNG plus a 6x512 cubemap of the same sky,
both 8-bit `rgb24`.

## Decision

### The image

**Lossless WebP, converted with ffmpeg's libwebp** (already on PATH; no new dependency). The source is 8-bit
sRGB, so lossless WebP is genuinely lossless — there is no dynamic range to lose. Verified rather than
asserted: both encodings were decoded back to raw `rgb24` and hashed against the source. Bit-identical.

Settings picked by sweep, not by guess: `-lossless 1 -compression_level 6 -quality 100 -pix_fmt bgra`.
`compression_level 6` is libwebp's maximum effort, and `bgra` is required because libwebp's lossless path does
not accept a subsampled pixel format.

| | PNG | lossless WebP | saved |
|---|---|---|---|
| equirect 2048x1024 | 1,030,471 | 862,618 | 16% |
| cubemap 6x512 | 1,110,466 | 799,436 | 28% |

Sixteen percent is what lossless compression of photographic content buys. It is near the entropy limit;
anything dramatically better requires lossy encoding, which was ruled out.

### The shape

**The equirect**, at `content/assets/textures/sky_110_2k.webp`, despite the cubemap being 8% smaller. One file
is one asset, one id, one row in the Project panel, and one URL to resolve. Sixty-four kilobytes does not buy
six assets for one sky. `webp` was already a texture extension in `kindForPath`, so nothing in `@mp/content`
changed.

### The integration

`installSky(scene, texture)` sets `scene.background`, the mapping and the colour space, and returns a handle
whose `dispose` puts the previous background back. `loadSky(scene, url)` is that plus the fetch, and it warns
and returns `null` rather than throwing — a sky that will not load costs the backdrop, not the session, which
is the same stance `addLevel` takes on a stale material reference.

**Background only. `scene.environment` is untouched.** Hanging a sky does not relight the level, and with this
image it should not: 8-bit sRGB carries no sun, so a PMREM built from it would give flat ambient with none of
the directional energy an HDR sky has. Lighting the scene from a sky needs an HDR source and is a separate
decision.

Wired into the parkour mode and the editor, which both resolve content URLs already. **Not the viewer**, which
has no asset pipeline at all — adding one to hang a backdrop is not worth it.

## Rejected

**The cubemap.** Smaller, and native cube sampling has neither the pole pinch nor the seam-filtering care an
equirect needs. Lost on the authoring model: six files with six sidecars and six ids to describe one sky, in a
Project panel that lists assets flat.

**Lossy WebP.** Would have taken the equirect to roughly a fifth the size. Not asked for, and a sky fills the
frame at high magnification, which is where block artifacts are most visible.

**KTX2 / Basis.** Correct answer for GPU memory rather than transfer size, and the only one that would help the
2k softness by allowing a larger source. Needs `KTX2Loader` plus transcoder binaries served alongside, which is
real machinery for one image.

**A `sky` field on `LevelConfig`.** Would make the sky authorable per level. A schema addition nobody asked
for; the request was one sky, so it is one constant at each call site.

## Consequences

- **2k is soft for a fullscreen sky.** At a 60-degree horizontal FOV the visible slice is about 341 of the
  2048 texels, stretched across the viewport — roughly 5.6x magnification at 1080p. The cubemap is the same
  effective resolution, so this is the source, not the packing. A 4k sky would be about four times the bytes.
- The sky's `py` face was the largest of the six and `ny` the smallest by 5x, so the detail is overhead and the
  underside is nearly flat. Looking up during a jump is the case that matters.
- `scene.background` is now a `Texture` rather than a `Color`. `applyGreyboxEnvironment` derives its fog colour
  from the background and falls back to navy when it is not a `Color` — harmless today because nothing passes
  `fogFar` and there is no fog, but that fallback is where a bright sky and a dark haze would disagree.
- The parkour render step nulls and restores `scene.background` around the nametag overlay pass. It reads the
  value back rather than assuming a colour, so a texture works unchanged.
