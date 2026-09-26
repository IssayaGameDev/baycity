import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { gameFile } from '@mp/content'

import { formatReport, simulate, type Scenario } from './balance'
import { curveFrom } from './progression'

/**
 * `pnpm --filter @mode/keyboard run balance [-- options]` — the balance report for the current curves (ADR 0088).
 *
 *   --hours 4             horizon (default 2)
 *   --hold 0.85           fraction of time a direction is held (default 1)
 *   --scenario <file>     the world/pad/rebirth/shop scenario (default modes/keyboard/balance.world1.json)
 *   --content <dir>       content root the curves are read from (default the repo's content/; .content-live for the mirror)
 *   --every 300           seconds between timeline rows (default 300)
 *
 * The curves come from `content/keyboard/game.json` `settings` — what the games window's Settings edits.
 */
const args = process.argv.slice(2)
const one = (name: string, fallback: string): string => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] !== undefined ? [args[i + 1]!] : []))[0] ?? fallback

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const content = one('content', `${ROOT}content`)
const game = JSON.parse(readFileSync(`${content}/${gameFile('keyboard')}`, 'utf8')) as { settings?: unknown }
const curve = curveFrom(game.settings)
const scenario = JSON.parse(readFileSync(one('scenario', fileURLToPath(new URL('../balance.world1.json', import.meta.url))), 'utf8')) as Scenario

const input = { curve, scenario, horizonS: Number(one('hours', '2')) * 3600, hold: Number(one('hold', '1')) }
console.log(formatReport(input, simulate(input, Number(one('every', '300')))))
