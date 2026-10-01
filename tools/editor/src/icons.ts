import type { AssetKind } from '@mp/content'

/**
 * The editor's icons: the sequence editor's (ADR 0147) — one per step kind, and the few its controls need —
 * the viewport's tools and toggles (ADR 0149), the Hierarchy's rows (ADR 0150), one per component in the
 * Inspector (ADR 0152), and the notices, the top bar's history and a collaborator's card (ADR 0155). Drawn here as SVG paths on a
 * 24-unit grid, stroked in the text colour, so they tint with CSS and cost no dependency.
 *
 * Static markup only — nothing a person typed ever reaches `innerHTML` here.
 */

export type IconName =
  | 'move'
  | 'turn'
  | 'scale'
  | 'fade'
  | 'colliderOn'
  | 'colliderOff'
  | 'enable'
  | 'disable'
  | 'wait'
  | 'plus'
  | 'close'
  | 'grip'
  | 'settings'
  | 'shared'
  | 'local'
  | 'restart'
  | 'yoyo'
  | 'object'
  | 'level'
  | 'warn'
  | 'chevron'
  | 'toolMove'
  | 'toolRotate'
  | 'toolScale'
  | 'toolFace'
  | 'magnet'
  | 'grid'
  | 'flag'
  | 'keycap'
  | 'motion'
  | 'play'
  | 'stop'
  | 'prefab'
  | 'gamepad'
  | 'sun'
  | 'more'
  | 'mesh'
  | 'material'
  | 'light'
  | 'spawn'
  | 'hazard'
  | 'bumper'
  | 'death'
  | 'boss'
  | 'component'
  | 'check'
  | 'bell'
  | 'undo'
  | 'redo'
  | 'focus'
  | 'folder'
  | 'image'
  | 'sound'
  | 'font'
  | 'search'
  | 'data'

/** An asset kind's picture where it has none of its own: a tile before its preview, a row in *Used by*. */
export const ASSET_ICON: Record<AssetKind, IconName> = {
  prefab: 'prefab',
  model: 'mesh',
  material: 'material',
  shader: 'material',
  texture: 'image',
  sound: 'sound',
  font: 'font',
  data: 'data',
}

const DOT = (x: number, y: number): string => `<circle cx="${x}" cy="${y}" r="1.6" fill="currentColor" stroke="none"/>`

const PATHS: Record<IconName, string> = {
  move: '<path d="M7 17 17 7"/><path d="M9 7h8v8"/>',
  turn: '<path d="M20.5 12a8.5 8.5 0 1 1-2.5-6"/><path d="M20 3v5h-5"/>',
  scale: '<path d="M14 4h6v6"/><path d="M10 20H4v-6"/><path d="M20 4l-6.5 6.5"/><path d="M4 20l6.5-6.5"/>',
  fade: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none"/>',
  colliderOn: '<rect x="4" y="4" width="16" height="16" rx="3"/><rect x="8.5" y="8.5" width="7" height="7" rx="1.5" fill="currentColor" stroke="none"/>',
  colliderOff: '<rect x="4" y="4" width="16" height="16" rx="3" stroke-dasharray="3.2 2.8"/>',
  enable: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  disable: '<path d="M2.5 12S6 5.5 12 5.5c1.9 0 3.6.6 5 1.5M21.5 12s-3.5 6.5-9.5 6.5c-1.9 0-3.6-.6-5-1.5"/><path d="M4 4l16 16"/>',
  wait: '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 10v3.5l2.5 2"/><path d="M9.5 2.5h5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M7 7l10 10M17 7 7 17"/>',
  grip: DOT(9, 6) + DOT(15, 6) + DOT(9, 12) + DOT(15, 12) + DOT(9, 18) + DOT(15, 18),
  settings: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  shared: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.4 2.3 3.5 5.2 3.5 8.5s-1.1 6.2-3.5 8.5c-2.4-2.3-3.5-5.2-3.5-8.5S9.6 5.8 12 3.5z"/>',
  local: '<rect x="3.5" y="4.5" width="17" height="11.5" rx="2"/><path d="M8.5 20h7M12 16v4"/>',
  restart: '<path d="M17 3l3 3-3 3"/><path d="M4 11v-1a4 4 0 0 1 4-4h12"/><path d="M7 21l-3-3 3-3"/><path d="M20 13v1a4 4 0 0 1-4 4H4"/>',
  yoyo: '<path d="M8 7l-5 5 5 5"/><path d="M16 7l5 5-5 5"/><path d="M3 12h18"/>',
  object: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
  level: '<path d="M3 16.5l9 4 9-4-9-4z"/><path d="M12 12.5V3.5M9 6.5l3-3 3 3"/>',
  warn: '<path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4M12 17h.01"/>',
  chevron: '<path d="M7 10l5 5 5-5"/>',
  toolMove: '<path d="M12 3v18M3 12h18"/><path d="M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
  toolRotate: '<path d="M4.5 9.5A8 8 0 0 1 19 7.5"/><path d="M19.5 14.5A8 8 0 0 1 5 16.5"/><path d="M19 3.5v4h-4"/><path d="M5 20.5v-4h4"/>',
  toolScale: '<rect x="3.5" y="10.5" width="10" height="10" rx="1.5"/><path d="M11 13l9-9"/><path d="M14 4h6v6"/>',
  toolFace:
    '<rect x="3.5" y="8.5" width="11" height="11" rx="1" fill="currentColor" fill-opacity="0.35"/><path d="M3.5 8.5l4-4h12v11l-5 4"/><path d="M14.5 8.5l5-4"/>',
  magnet: '<path d="M5 3.5h4.5V11a2.5 2.5 0 0 0 5 0V3.5H19V11a7 7 0 0 1-14 0z"/><path d="M5 7.5h4.5M14.5 7.5H19"/>',
  grid: '<rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="M9.2 3.5v17M14.8 3.5v17M3.5 9.2h17M3.5 14.8h17"/>',
  flag: '<path d="M5.5 21V3.5"/><path d="M5.5 4h12l-2.5 4.5 2.5 4.5h-12"/>',
  keycap: '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M7 9.5h.01M10.3 9.5h.01M13.7 9.5h.01M17 9.5h.01M8 14.5h8"/>',
  motion: '<rect x="10.5" y="6.5" width="10" height="11" rx="2"/><path d="M3 9h4.5M2 12h5.5M3 15h4.5"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="currentColor"/>',
  // `object`'s cube, filled: a prefab, as Unity draws one.
  prefab: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" fill="currentColor" fill-opacity="0.3"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
  gamepad: '<rect x="2.5" y="7" width="19" height="11" rx="5.5"/><path d="M7.5 10.5v4M5.5 12.5h4"/><path d="M15.5 11.5h.01M18 13.5h.01"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  more: DOT(6, 12) + DOT(12, 12) + DOT(18, 12),
  mesh: '<path d="M12 3.5l8.5 15h-17z"/><path d="M7.75 11h8.5M12 18.5 7.75 11M12 18.5l4.25-7.5"/>',
  material: '<circle cx="12" cy="12" r="8.5"/><path d="M7.5 10a5 5 0 0 1 4-3.5"/><path d="M3.5 12.5c3 2 14 2 17 0"/>',
  light: '<path d="M9.5 17.5h5M10.5 21h3"/><path d="M8.3 14.3a6 6 0 1 1 7.4 0c-.7.6-1.2 1.6-1.2 3.2h-5c0-1.6-.5-2.6-1.2-3.2z"/>',
  spawn: '<circle cx="12" cy="7" r="3.2"/><path d="M5.5 20.5v-1.5a6.5 6.5 0 0 1 13 0v1.5"/>',
  hazard: '<path d="M12 21a6.5 6.5 0 0 0 6.5-6.5c0-4.5-3.5-6-4.5-11-2.2 1.6-3.5 4-3.5 6.5-1.1-.9-1.7-2.1-1.8-3.3-1.4 1.6-3.2 4.3-3.2 7.8A6.5 6.5 0 0 0 12 21z"/>',
  bumper: '<path d="M4 20.5h16"/><path d="M6.5 17.5h11"/><path d="M12 14V3.5M8 7.5l4-4 4 4"/>',
  death: '<path d="M12 3.5a7.5 7.5 0 0 0-4.5 13.5v3.5h9V17A7.5 7.5 0 0 0 12 3.5z"/><circle cx="9.3" cy="11.5" r="1.5"/><circle cx="14.7" cy="11.5" r="1.5"/><path d="M11 20.5v-2M13 20.5v-2"/>',
  boss: '<path d="M3.5 18.5h17l-1.3-11-4.7 4.5L12 5.5 9.5 12 4.8 7.5z"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  undo: '<path d="M9 7.5 4.5 12 9 16.5"/><path d="M4.5 12H15a4.5 4.5 0 0 1 0 9h-2"/>',
  redo: '<path d="M15 7.5 19.5 12 15 16.5"/><path d="M19.5 12H9a4.5 4.5 0 0 0 0 9h2"/>',
  folder: '<path d="M3.5 7a1.5 1.5 0 0 1 1.5-1.5h4.3l2 2.5H19a1.5 1.5 0 0 1 1.5 1.5V17a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 17z"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M4 17.5l5-4.5 4 3.5 3-2.5 4.5 4"/>',
  sound: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  font: '<path d="M5 19.5 11 4.5h2l6 15"/><path d="M7.8 13.5h8.4"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>',
  // Four corners closing on a point: frame what is there.
  focus: '<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/><circle cx="12" cy="12" r="2.5"/>',
  component: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  // A sheet of fields: a data asset (ADR 0181).
  data: '<path d="M6 3.5h8.5L18.5 7.5v13H6z"/><path d="M14.5 3.5v4h4"/><path d="M9 11.5h6.5M9 14.5h6.5M9 17.5h4"/>',
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/** An icon, sized and coloured by its class in CSS (`.ic`). */
export const icon = (name: IconName, className = 'ic'): SVGSVGElement => {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('class', className)
  svg.setAttribute('aria-hidden', 'true')
  svg.innerHTML = PATHS[name]
  return svg
}
