import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { gameFile, levelRefForFile, LEVELS_DIR, type Level } from '@mp/content'

import { formatReport, simulate, type SimWorld } from './balance'
import { defaultSimWorld, distinctWorlds, worldReadOf } from './balanceWorlds'
import { padTiersFrom } from './padTable'
import { curveFrom } from './progression'

/**
 * `pnpm --filter @mode/keyboard run balance [-- options]` — the balance report for the game as it is set (ADR 0223).
 *
 *   --hours 4             horizon (default 2)
 *   --hold 0.85           fraction of time a direction is held (default 1)
 *   --fail-cost 0.5       what a failed run costs, as a fraction of a run (default 0.5)
 *   --overhead 3          seconds from a cash-out or a fall back to running a stage (default 3)
 *   --level Roblox_World_1  a level to read a World from; repeat for several (default: every level that has one)
 *   --content <dir>       content root (default the repo's content/; .content-live for the mirror)
 *   --every 300           seconds between timeline rows (default 300)
 *
 * The curves and the pad table come from `content/keyboard/game.json` `settings` — what the games window's Settings
 * edits; each world from its level's `World` component. With none anywhere, a World's defaults: the design stages.
 */
const args = process.argv.slice(2)
const all = (name: string): string[] => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] !== undefined ? [args[i + 1]!] : []))
const one = (name: string, fallback: string): string => all(name)[0] ?? fallback

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const content = one('content', `${ROOT}content`)
const game = JSON.parse(readFileSync(`${content}/${gameFile('keyboard')}`, 'utf8')) as { settings?: unknown }
const curve = curveFrom(game.settings)
const pads = padTiersFrom(game.settings)

const dir = `${content}/keyboard/${LEVELS_DIR}`
const wanted = all('level')
const names = existsSync(dir)
  ? readdirSync(dir)
      .flatMap((f) => {
        const ref = levelRefForFile(`keyboard/${LEVELS_DIR}/${f}`)
        return ref === null ? [] : [{ name: ref.name, file: `${dir}/${f}` }]
      })
      .filter((l) => wanted.length === 0 || wanted.includes(l.name))
      .sort((a, b) => a.name.localeCompare(b.name))
  : []
const found = names.flatMap((l) => {
  const w = worldReadOf(l.name, JSON.parse(readFileSync(l.file, 'utf8')) as Level, pads.length)
  return w === null ? [] : [w]
})
// One world a Level to enter: two levels opening at the same Level are two copies of one world, and the first is read.
const { kept, skipped } = distinctWorlds(found)
for (const why of skipped) console.log(`(${why}: skipped — pick with --level)`)
const worlds: SimWorld[] = kept.map((r) => r.world)
if (worlds.length === 0) console.log('(no level has a World component: the World defaults, the design stages)')

const input = {
  curve,
  pads,
  worlds: worlds.length > 0 ? worlds : [defaultSimWorld(pads.length)],
  horizonS: Number(one('hours', '2')) * 3600,
  hold: Number(one('hold', '1')),
  failCost: Number(one('fail-cost', '0.5')),
  overheadSeconds: Number(one('overhead', '3')),
}
console.log(formatReport(input, simulate(input, Number(one('every', '300')))))
