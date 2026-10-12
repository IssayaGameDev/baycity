// @vitest-environment happy-dom
import { THREE } from '@mp/render-three'
import { describe, expect, it } from 'vitest'

import { farToSee } from './cameraView'

/** How far the editor's view reaches (ADR 0201): the whole level from where the camera is, never less than the game's. */
describe('farToSee', () => {
  const eye = new THREE.Vector3(0, 0, 0)

  it('reaches past the level’s far side, in whole hundreds', () => {
    // 1500 m to the centre and 500 more to the far side, with 5% over: 2100.
    expect(farToSee(eye, new THREE.Sphere(new THREE.Vector3(0, 0, -1500), 500), 1000)).toBe(2100)
    expect(farToSee(eye, new THREE.Sphere(new THREE.Vector3(1200, 0, 0), 10), 1000)).toBe(1300)
  })

  it('is never nearer than the camera’s own', () => {
    expect(farToSee(eye, new THREE.Sphere(new THREE.Vector3(0, 0, -20), 30), 1000)).toBe(1000)
    expect(farToSee(eye, new THREE.Sphere(), 1000), 'no level: the floor').toBe(1000)
  })
})
