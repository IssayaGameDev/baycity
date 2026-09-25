import type { Vec3 } from '@mp/core'
import { THREE } from '@mp/render-three'

/**
 * Dragging a prefab or a model from the Project window into the viewport places it (Track B, ADR 0164).
 *
 * While it is held over the viewport a **see-through copy** sits under the pointer, on the surface and snapped as
 * the placement will be, so you see where it lands before you let go; letting go places it there. Only this tab
 * sees the copy: the placement is an ordinary edit once it lands. Escape (the browser's own, which cancels a drag)
 * or leaving the viewport takes the copy away. An asset that cannot go here says why beside the pointer instead.
 *
 * The drag itself is the browser's: the Project window says which asset it carries (`dragging`), since what a drag
 * carries cannot be read until it is dropped.
 */
export interface DragPlaceHost {
  scene: THREE.Scene
  /** What the copy is made of, built fresh: the prefab's nodes or the model. `null` while that cannot be built yet. */
  subject: (assetId: string) => THREE.Object3D | null
  /** Load what the copy needs; it is built again when this resolves, if the drag is still on. */
  load: (assetId: string) => Promise<void>
  /** Why this asset cannot be placed now, or `null`. */
  refusal: (assetId: string) => string | null
  /** The snapped surface point under a client position, or `null` off the world. */
  surfaceUnder: (clientX: number, clientY: number) => Vec3 | null
  place: (assetId: string, at: Vec3) => void
  /** A line beside the pointer, or `null` to take it away. */
  readout: (text: string | null, at?: { x: number; y: number }) => void
}

export interface DragPlace {
  /** A tile began to be dragged, carrying this asset — or `null`: the drag ended, dropped or not, anywhere. */
  dragging: (assetId: string | null) => void
}

/** How much of the copy shows. */
const SEE_THROUGH = 0.45

export const createDragPlace = (target: HTMLElement, host: DragPlaceHost): DragPlace => {
  let carried: string | null = null
  let copy: { object: THREE.Object3D; dispose: () => void } | null = null

  /** The subject with every material swapped for a see-through clone of it: the originals are shared, not ours. */
  const seeThrough = (subject: THREE.Object3D): { object: THREE.Object3D; dispose: () => void } => {
    const made: THREE.Material[] = []
    const faint = (m: THREE.Material): THREE.Material => {
      const c = m.clone()
      c.transparent = true
      c.opacity = SEE_THROUGH
      c.depthWrite = false
      made.push(c)
      return c
    }
    subject.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return
      o.material = Array.isArray(o.material) ? o.material.map(faint) : faint(o.material)
      o.castShadow = false
      o.receiveShadow = false
    })
    return {
      object: subject,
      dispose: () => {
        for (const m of made) m.dispose()
        ;(subject.userData.dispose as (() => void) | undefined)?.()
      },
    }
  }

  const build = (): void => {
    if (carried === null || copy !== null) return
    const subject = host.subject(carried)
    if (subject === null) return
    copy = seeThrough(subject)
    copy.object.visible = false
    host.scene.add(copy.object)
  }

  const takeAway = (): void => {
    if (copy !== null) {
      host.scene.remove(copy.object)
      copy.dispose()
      copy = null
    }
    host.readout(null)
  }

  const hide = (): void => {
    if (copy !== null) copy.object.visible = false
  }

  const dragging = (assetId: string | null): void => {
    takeAway()
    carried = assetId
    if (assetId === null) return
    build()
    if (copy === null) {
      void host.load(assetId).then(() => {
        if (carried === assetId) build()
      })
    }
  }

  target.addEventListener('dragover', (e) => {
    if (carried === null) return
    const why = host.refusal(carried)
    if (why !== null) {
      // Not taken: the browser shows the drop is refused, and the line says why.
      hide()
      host.readout(why, { x: e.clientX, y: e.clientY })
      return
    }
    const at = host.surfaceUnder(e.clientX, e.clientY)
    host.readout(null)
    if (at === null) {
      hide()
      return
    }
    e.preventDefault()
    const dt = e.dataTransfer
    if (dt) dt.dropEffect = 'copy'
    if (copy !== null) {
      copy.object.position.set(at.x, at.y, at.z)
      copy.object.visible = true
    }
  })
  target.addEventListener('dragleave', () => {
    hide()
    host.readout(null)
  })
  target.addEventListener('drop', (e) => {
    const id = carried
    if (id === null) return
    e.preventDefault()
    const at = host.refusal(id) === null ? host.surfaceUnder(e.clientX, e.clientY) : null
    dragging(null)
    if (at !== null) host.place(id, at)
  })

  return { dragging }
}
