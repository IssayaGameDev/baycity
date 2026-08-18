/**
 * The Prefabs panel: one clickable tile per placeable prefab.
 *
 * Replaces a dropdown plus a separate "Place" button — two interactions and no way to see what you
 * had, because Tweakpane's only list-shaped control is a `<select>`. Arming a tile is now one click
 * and stays visible while you aim.
 */
export interface PaletteHost {
  names: () => readonly string[]
  /** The armed entry, waiting for a viewport click. */
  armed: () => string | null
  onPick: (name: string) => void
}

export interface Palette {
  render: () => void
}

export const createPalette = (container: HTMLElement, host: PaletteHost): Palette => {
  const render = (): void => {
    const names = host.names()
    const armed = host.armed()
    container.replaceChildren()
    if (names.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'empty'
      empty.textContent = 'nothing to place'
      container.append(empty)
      return
    }
    for (const name of names) {
      const tile = document.createElement('button')
      tile.className = `ctl tile${name === armed ? ' armed' : ''}`
      tile.textContent = name
      tile.addEventListener('click', () => host.onPick(name))
      container.append(tile)
    }
  }

  render()
  return { render }
}
