import { GAME_FILE, LEVELS_DIR } from '../../../packages/content/src/layout'
import { applyLayout, planLayout, tidyOldFolders } from './layoutMoves'

/**
 * Move content into the per-game folder layout (ADR 0108). Dry by default; `--write` moves.
 *
 *   tsx src/migrateLayout.ts <contentDir> [--write]
 *
 * ```
 * content/levels/keyboard2.json   ->  content/keyboard/levels/keyboard2.level.json
 * content/games/keyboard.json     ->  content/keyboard/game.json
 * content/assets/**               ->  unchanged (the shared library stays, ADR 0108)
 * ```
 *
 * **Nothing inside any file changes.** Every level already declares its game in `config.mode.name`, which is
 * the folder it moves into, so this is a pure rename and the safety gate is exact rather than a sampled
 * fingerprint: the bytes are identical before and after, and `applyLayout` asserts it per file. Asset ids are
 * untouched because a reference is an id, never a path (ADR 0026), so no level or prefab is rewritten.
 *
 * A level declaring no game, or one whose game has no data file, is refused and named; a refusal exits
 * non-zero and moves nothing, so `--write` reports a failure rather than a partial success.
 *
 * Idempotent: with `content/levels/` and `content/games/` already gone there is nothing to do and it exits 0.
 *
 * Run with the editor server **stopped** (`deploy/editor/migrate-layout.sh`): an open live level holds its own
 * copy and would write it back to the old path.
 */
const [dir, flag] = process.argv.slice(2)
if (dir === undefined) {
  console.error('usage: migrateLayout <contentDir> [--write]')
  process.exit(2)
}
const write = flag === '--write'

const { moves, refusals } = planLayout(dir)

for (const r of refusals) console.error(`refused  ${r}`)
for (const { from, to } of moves) console.log(`${write ? 'move   ' : 'would  '} ${from}  ->  ${to}`)

if (refusals.length > 0) {
  console.error(`\n${refusals.length} refused; nothing moved. Fix those and rerun.`)
  process.exit(1)
}
if (moves.length === 0) {
  console.log(`nothing to move: ${dir} is already the per-game layout (ADR 0108)`)
  process.exit(0)
}
if (!write) {
  console.log(`\n${moves.length} files would move. Rerun with --write.`)
  process.exit(0)
}

applyLayout(dir, moves)
const gone = tidyOldFolders(dir)
console.log(`\nmoved ${moves.length} files${gone.length > 0 ? `; removed the empty ${gone.join(' and ')} folder${gone.length > 1 ? 's' : ''}` : ''}`)
console.log(`every game now holds its own ${GAME_FILE} and ${LEVELS_DIR}/`)
