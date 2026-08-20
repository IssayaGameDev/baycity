import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { DEFAULT_SKY_PARAMS, skyUniformValues, sunDirection } from './sky'

/**
 * The sky's testable halves (ADR 0046). Baking needs a GPU; the sun maths and the parameter-to-uniform
 * conversion are pure, and both fail silently when wrong — a mirrored azimuth looks plausible, and a colour
 * converted in the wrong space just looks like a slightly-off choice.
 */

describe('sunDirection', () => {
  it('puts the sun overhead at 90 degrees, whatever the azimuth', () => {
    for (const azimuthDeg of [-180, -37, 0, 90, 180]) {
      expect(sunDirection({ elevationDeg: 90, azimuthDeg }).y).toBeCloseTo(1, 6)
    }
  })

  it('returns a unit vector', () => {
    expect(sunDirection({ elevationDeg: 30, azimuthDeg: 38 }).length()).toBeCloseTo(1, 6)
  })

  it('measures azimuth from +X toward +Z, matching threes equirectUv', () => {
    const east = sunDirection({ elevationDeg: 0, azimuthDeg: 0 })
    expect(east.x).toBeCloseTo(1, 6)
    expect(east.z).toBeCloseTo(0, 6)
    const quarter = sunDirection({ elevationDeg: 0, azimuthDeg: 90 })
    expect(quarter.x).toBeCloseTo(0, 6)
    expect(quarter.z).toBeCloseTo(1, 6)
  })

  /**
   * The angles that reproduce the `[18, 30, 14]` vector this replaced, so the default sun only *deliberately*
   * moved (52.7 degrees down to 30) rather than also swinging round to a new bearing.
   */
  it('reproduces the sun position it replaced', () => {
    const d = sunDirection({ elevationDeg: 52.72, azimuthDeg: 37.87 })
    const old = new THREE.Vector3(18, 30, 14).normalize()
    expect(d.x).toBeCloseTo(old.x, 3)
    expect(d.y).toBeCloseTo(old.y, 3)
    expect(d.z).toBeCloseTo(old.z, 3)
  })

  it('drops below the horizon for a negative elevation', () => {
    expect(sunDirection({ elevationDeg: -10, azimuthDeg: 0 }).y).toBeLessThan(0)
  })
})

describe('skyUniformValues', () => {
  // Authored hexes are sRGB; the shader works in linear. Getting this wrong is invisible except that every
  // colour is too bright, which reads as a bad choice rather than as a bug.
  it('converts authored hexes from sRGB into the linear working space', () => {
    const v = skyUniformValues({ ...DEFAULT_SKY_PARAMS, topColor: '#808080' }, { elevationDeg: 30, azimuthDeg: 0 })
    // Mid grey in sRGB is ~0.216 linear, not 0.502.
    expect(v.topColor.r).toBeCloseTo(0.2158, 3)
  })

  it('keeps white at white and black at black', () => {
    const v = skyUniformValues({ ...DEFAULT_SKY_PARAMS, topColor: '#ffffff', bottomColor: '#000000' }, { elevationDeg: 30, azimuthDeg: 0 })
    expect(v.topColor.r).toBeCloseTo(1, 6)
    expect(v.bottomColor.r).toBeCloseTo(0, 6)
  })

  /**
   * The ramp is `mix(bottom, top, pow(t, bias))` with `t` rising with height, which is monotonic for any
   * positive bias. A zero or negative bias is the one input that would break that, so it is clamped rather
   * than trusted.
   */
  it('clamps the ramp bias away from zero, since that is the one value that could flatten the gradient', () => {
    expect(skyUniformValues({ ...DEFAULT_SKY_PARAMS, gradientBias: 0 }, { elevationDeg: 30, azimuthDeg: 0 }).gradientBias).toBeGreaterThan(0)
    expect(skyUniformValues({ ...DEFAULT_SKY_PARAMS, gradientBias: -4 }, { elevationDeg: 30, azimuthDeg: 0 }).gradientBias).toBeGreaterThan(0)
  })

  it('refuses negative gain, glow and disc values', () => {
    const v = skyUniformValues(
      { ...DEFAULT_SKY_PARAMS, gain: -1, glowStrength: -1, sunDiskIntensity: -1, glowSharpness: -1 },
      { elevationDeg: 30, azimuthDeg: 0 },
    )
    expect(v.gain).toBe(0)
    expect(v.glowStrength).toBe(0)
    expect(v.sunDiskIntensity).toBe(0)
    expect(v.glowSharpness).toBeGreaterThanOrEqual(1)
  })

  it('carries the sun direction through', () => {
    const v = skyUniformValues(DEFAULT_SKY_PARAMS, { elevationDeg: 90, azimuthDeg: 0 })
    expect(v.sunDir.y).toBeCloseTo(1, 6)
  })
})

describe('the default gradient', () => {
  // The whole point of dropping Preetham: light at the top, darker all the way down, no band in between.
  it('is brighter at the top than at the bottom', () => {
    const v = skyUniformValues(DEFAULT_SKY_PARAMS, { elevationDeg: 30, azimuthDeg: 38 })
    const lum = (c: THREE.Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
    expect(lum(v.topColor)).toBeGreaterThan(lum(v.bottomColor))
  })

  it('is blue at both ends rather than grey', () => {
    const v = skyUniformValues(DEFAULT_SKY_PARAMS, { elevationDeg: 30, azimuthDeg: 38 })
    expect(v.topColor.b).toBeGreaterThan(v.topColor.r)
    expect(v.bottomColor.b).toBeGreaterThan(v.bottomColor.r)
  })
})
