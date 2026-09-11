import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { formatReport, simulate, type PadPlan, type StagePlan } from './balance'
import { CURVE_SETTINGS, curveFrom } from './progression'

/**
 * `pnpm --filter @mode/keyboard run balance [-- options]` — the balance table for the current numbers (ADR 0087).
 *
 *   --minutes 60          horizon (default 60)
 *   --stage 120:1         a stage: path length in studs : Wins it pays; repeatable, cycled (default: from the level)
 *   --hold 0.85           fraction of time a direction is held (default 1)
 *   --start 1000:5        starting experience:wins (default fresh)
 *   --level keyboard      which content/levels/<name>.json to read pads and a default stage from
 *   --content <dir>       content root (default the repo's content/; use .content-live for the mirror)
 *
 * Reads the curve from content/games/keyboard.json `settings` (what the editor edits), the `StepPad`s from the
 * level, and — with no `--stage` — one stage whose length is the straight line from spawn to the first
 * `WinsPad`, which is a floor on the real path. Give `--stage` the lengths you actually build.
 */
const args = process.argv.slice(2)
const opt = (name: string): string[] => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] !== undefined ? [args[i + 1]!] : []))
const one = (name: string, fallback: string): string => opt(name)[0] ?? fallback

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const content = one('content', `${ROOT}content`)
const levelName = one('level', 'keyboard')

const game = JSON.parse(readFileSync(`${content}/games/keyboard.json`, 'utf8')) as { settings?: unknown }
const curve = curveFrom(game.settings)

interface Node {
  transform: { position: { x: number; y: number; z: number } }
  components: { type: string; params?: Record<string, unknown> }[]
  children?: Node[]
}
const level = JSON.parse(readFileSync(`${content}/levels/${levelName}.json`, 'utf8')) as { nodes: Node[] }
const pads: PadPlan[] = []
let spawn: Node['transform']['position'] | null = null
let winsPad: { at: Node['transform']['position']; wins: number } | null = null
const walk = (n: Node): void => {
  for (const c of n.components) {
    if (c.type === 'StepPad') pads.push({ perStep: Number(c.params?.perStep ?? 1), requiresWins: Number(c.params?.requiresWins ?? 0) })
    if (c.type === 'Spawn' && spawn === null) spawn = n.transform.position
    if (c.type === 'WinsPad' && winsPad === null) winsPad = { at: n.transform.position, wins: Number(c.params?.wins ?? 1) }
  }
  for (const ch of n.children ?? []) walk(ch)
}
for (const n of level.nodes) walk(n)
pads.sort((a, b) => a.requiresWins - b.requiresWins)

const stagesArg = opt('stage').map((s): StagePlan => {
  const [len, wins] = s.split(':')
  return { lengthStuds: Number(len), wins: Number(wins ?? '1') }
})
let stages: StagePlan[] = stagesArg
if (stages.length === 0) {
  if (spawn === null || winsPad === null) {
    console.error(`no --stage given and ${levelName} has no Spawn + WinsPad to measure; pass --stage <studs>:<wins>`)
    process.exit(2)
  }
  const s = spawn as Node['transform']['position']
  const w = winsPad as { at: Node['transform']['position']; wins: number }
  const metres = Math.hypot(w.at.x - s.x, w.at.y - s.y, w.at.z - s.z)
  stages = [{ lengthStuds: Math.round(metres / curve.metresPerStud), wins: w.wins }]
  console.log(`(stage length ${stages[0]!.lengthStuds} studs = straight line spawn → first WinsPad in ${levelName}; a floor, pass --stage for the real path)\n`)
}

const [xp, wins] = one('start', '0:0').split(':').map(Number)
const input = {
  curve,
  stages,
  pads,
  horizonS: Number(one('minutes', '60')) * 60,
  hold: Number(one('hold', '1')),
  start: { experience: xp ?? 0, wins: wins ?? 0 },
}
console.log(formatReport(input, simulate(input)))
console.log(`\nsettings: ${Object.keys(CURVE_SETTINGS).join(', ')} — edit them in the editor's Game section`)
