import { startGameClient } from '@mp/game-client'

import { TEMPLATE_MODE } from './editorMode'

/**
 * A game, as an application. Three lines, and the third is the only one that varies.
 *
 * This file is the acceptance test for `@mp/game-client` (ADR 0056): if it ever has to grow, something that
 * belongs in a package has leaked back into a game.
 *
 * **To start a game from this directory** — six steps, and only the last is a judgement call:
 *
 * 1. `cp -r modes/_template modes/<yours>` (skip `node_modules`)
 * 2. rename `TEMPLATE_MODE`, `TEMPLATE_REGISTRY` and `templateSession`, and set `name`/`label` in
 *    `editorMode.ts`
 * 3. `package.json`: set `@mode/<yours>`
 * 4. `vite.config.ts`: pick a free port
 * 5. root `package.json`: add `dev:<yours>`, then `pnpm install`
 * 6. give it a level — author one in the editor with your game selected, or copy an existing
 *    `content/levels/*.json` and set its `id` and `config.mode.name`. Then decide what
 *    `TEMPLATE_REGISTRY` installs.
 *
 * Until step 6 it will not boot: `content/levels/` is filtered by `config.mode.name` and nothing there is
 * authored for `template`, so this throws with the list of what it does have. `modes/swing` is the worked
 * example.
 */
await startGameClient(TEMPLATE_MODE)
