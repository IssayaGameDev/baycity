import * as THREE from 'three'
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js'

/**
 * An outline around selected objects' real silhouettes, Unity's selection cue — one pass for every colour at
 * once, so several people selecting cost about what one does.
 *
 * Three's `OutlinePass` was the obvious part and the wrong one: it re-renders the **whole scene** for depth
 * and again for a mask, per pass, and it takes one colour, so five collaborators would be ten extra scene
 * renders a frame. The outline here is drawn **whether or not something is in front** (Kodjo's call), so
 * depth is never needed, and that is what makes it cheap:
 *
 * 1. **Mask.** Only the selected objects are drawn, into a target the size of the screen, each group in its
 *    own id with depth ignored. Nothing else in the level is touched.
 * 2. **Across.** Each pixel takes the largest id within `radius` pixels left and right.
 * 3. **Down, and composite.** The same up and down over that, which makes a square of `radius`; a pixel
 *    outside every silhouette with an id in its square is an outline pixel, in that id's colour. Everything
 *    else is the image as it was.
 *
 * Sits after tone mapping and before antialiasing, so its colours are the ones written and SMAA smooths it.
 */

/** One colour's worth of selection: the objects, whose whole subtrees are outlined, and the colour. */
export interface OutlineGroup {
  readonly roots: readonly THREE.Object3D[]
  /** `0xRRGGBB`, as displayed: no tone mapping or colour management touches it. */
  readonly color: number
}

/** Ids are one byte, `0` for nothing; one colour per id. */
const MAX_GROUPS = 32
/** Thickness in CSS pixels, scaled by the pixel ratio so it looks the same on any screen. */
const THICKNESS = 2

const QUAD_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`

/** The largest id within `radius` pixels along `texStep`. */
const DILATE_FRAGMENT = /* glsl */ `
uniform sampler2D tMask;
uniform vec2 texStep;
uniform float radius;
varying vec2 vUv;
void main() {
  float id = texture2D(tMask, vUv).r;
  for (float i = 1.0; i <= 8.0; i += 1.0) {
    if (i > radius) break;
    id = max(id, texture2D(tMask, vUv + texStep * i).r);
    id = max(id, texture2D(tMask, vUv - texStep * i).r);
  }
  gl_FragColor = vec4(id, 0.0, 0.0, 1.0);
}`

const COMPOSITE_FRAGMENT = /* glsl */ `
uniform sampler2D tDiffuse;
uniform sampler2D tMask;
uniform sampler2D tAcross;
uniform vec2 texStep;
uniform float radius;
uniform vec3 colors[${MAX_GROUPS}];
varying vec2 vUv;
void main() {
  vec4 image = texture2D(tDiffuse, vUv);
  if (texture2D(tMask, vUv).r > 0.0) {
    gl_FragColor = image;
    return;
  }
  float id = texture2D(tAcross, vUv).r;
  for (float i = 1.0; i <= 8.0; i += 1.0) {
    if (i > radius) break;
    id = max(id, texture2D(tAcross, vUv + texStep * i).r);
    id = max(id, texture2D(tAcross, vUv - texStep * i).r);
  }
  int n = int(id * 255.0 + 0.5);
  if (n == 0) {
    gl_FragColor = image;
    return;
  }
  // Looked up with a constant index, which every GLSL version allows; a computed one is not guaranteed.
  vec3 color = vec3(1.0);
  for (int k = 0; k < ${MAX_GROUPS}; k++) {
    if (k == n - 1) color = colors[k];
  }
  gl_FragColor = vec4(color, 1.0);
}`

/** Is it drawn at all: itself and every ancestor visible. */
const shown = (o: THREE.Object3D): boolean => {
  for (let at: THREE.Object3D | null = o; at !== null; at = at.parent) if (!at.visible) return false
  return true
}

export class SelectionOutlinePass extends Pass {
  camera: THREE.Camera
  private groups: readonly OutlineGroup[] = []
  private readonly mask = new THREE.WebGLRenderTarget(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter })
  private readonly across = new THREE.WebGLRenderTarget(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter })
  /** One flat material per id, made as ids are first needed. */
  private readonly idMaterials: THREE.MeshBasicMaterial[] = []
  private readonly dilate: THREE.ShaderMaterial
  private readonly composite: THREE.ShaderMaterial
  private readonly quad = new FullScreenQuad()
  private readonly clearColor = new THREE.Color()

  constructor(camera: THREE.Camera) {
    super()
    this.camera = camera
    this.dilate = new THREE.ShaderMaterial({
      uniforms: { tMask: { value: null }, texStep: { value: new THREE.Vector2() }, radius: { value: THICKNESS } },
      vertexShader: QUAD_VERTEX,
      fragmentShader: DILATE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    })
    this.composite = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tMask: { value: null },
        tAcross: { value: null },
        texStep: { value: new THREE.Vector2() },
        radius: { value: THICKNESS },
        colors: { value: Array.from({ length: MAX_GROUPS }, () => new THREE.Vector3()) },
      },
      vertexShader: QUAD_VERTEX,
      fragmentShader: COMPOSITE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    })
  }

  /** What to outline this frame. Nothing to outline disables the pass, so an empty selection costs nothing. */
  setGroups(groups: readonly OutlineGroup[]): void {
    this.groups = groups.filter((g) => g.roots.length > 0).slice(0, MAX_GROUPS)
    this.enabled = this.groups.length > 0
  }

  override setSize(width: number, height: number): void {
    this.mask.setSize(width, height)
    this.across.setSize(width, height)
  }

  private idMaterial(id: number): THREE.MeshBasicMaterial {
    let m = this.idMaterials[id]
    if (m === undefined) {
      // The id rides in red, exactly: a linear colour into a target with no colour space is stored as given.
      m = new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(id / 255, 0, 0, THREE.LinearSRGBColorSpace), depthTest: false, depthWrite: false, toneMapped: false, fog: false, side: THREE.DoubleSide })
      this.idMaterials[id] = m
    }
    return m
  }

  /**
   * Draw every group's meshes in its id. Each mesh wears the id material for the one render and gets its own
   * back; anything else that draws (a line, a sprite) is hidden for it, since it would write its own colour.
   * Shadows are off for it too: a light inside a selection would otherwise re-render its shadow map for it.
   */
  private renderMask(renderer: THREE.WebGLRenderer): void {
    const materials = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>()
    const hidden: THREE.Object3D[] = []
    const autoClear = renderer.autoClear
    const shadows = renderer.shadowMap.enabled
    renderer.getClearColor(this.clearColor)
    const clearAlpha = renderer.getClearAlpha()
    renderer.setRenderTarget(this.mask)
    renderer.setClearColor(0x000000, 0)
    renderer.clear()
    renderer.autoClear = false
    renderer.shadowMap.enabled = false
    try {
      this.groups.forEach((group, n) => {
        const material = this.idMaterial(n + 1)
        for (const root of group.roots) {
          if (!shown(root)) continue
          root.traverseVisible((o) => {
            if (o instanceof THREE.Mesh) {
              if (!materials.has(o)) materials.set(o, o.material)
              o.material = material
            } else if (o instanceof THREE.Line || o instanceof THREE.Points || o instanceof THREE.Sprite) {
              o.visible = false
              hidden.push(o)
            }
          })
          renderer.render(root, this.camera)
        }
      })
    } finally {
      for (const [mesh, material] of materials) mesh.material = material
      for (const o of hidden) o.visible = true
      renderer.autoClear = autoClear
      renderer.shadowMap.enabled = shadows
      renderer.setClearColor(this.clearColor, clearAlpha)
    }
  }

  override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    this.renderMask(renderer)
    const radius = Math.max(1, Math.round(THICKNESS * renderer.getPixelRatio()))
    const w = this.mask.width
    const h = this.mask.height

    this.dilate.uniforms.tMask!.value = this.mask.texture
    ;(this.dilate.uniforms.texStep!.value as THREE.Vector2).set(1 / w, 0)
    this.dilate.uniforms.radius!.value = radius
    this.quad.material = this.dilate
    renderer.setRenderTarget(this.across)
    this.quad.render(renderer)

    const colors = this.composite.uniforms.colors!.value as THREE.Vector3[]
    this.groups.forEach((g, n) => colors[n]!.set(((g.color >> 16) & 255) / 255, ((g.color >> 8) & 255) / 255, (g.color & 255) / 255))
    this.composite.uniforms.tDiffuse!.value = readBuffer.texture
    this.composite.uniforms.tMask!.value = this.mask.texture
    this.composite.uniforms.tAcross!.value = this.across.texture
    ;(this.composite.uniforms.texStep!.value as THREE.Vector2).set(0, 1 / h)
    this.composite.uniforms.radius!.value = radius
    this.quad.material = this.composite
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer)
    this.quad.render(renderer)
  }

  override dispose(): void {
    this.mask.dispose()
    this.across.dispose()
    for (const m of this.idMaterials) m.dispose()
    this.dilate.dispose()
    this.composite.dispose()
    this.quad.dispose()
  }
}
