/**
 * The sequence editor's icons (ADR 0147): one per step kind, and the few its controls need. Drawn here as SVG
 * paths on a 24-unit grid, stroked in the text colour, so they tint with CSS and cost no dependency.
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
