import { createAnimator, DEFAULT_GAIT } from '@mp/humanoid'
import { startTpsClient } from '@mp/tps'

import { TEMPLATE_MODE } from './editorMode'

/**
 * A game, as an application — and the file to read first when starting one.
 *
 * `@mp/tps` is **the third-person game the platform ships**: a blocky humanoid seen over its own shoulder, with
 * a boom camera, a procedural walk cycle and a ragdoll death. It is not the platform, it is one game, and every
 * game in this repo happens to be it. So it is called, not inherited (ADR 0065).
 *
 * The descriptor is spread in because `ModeDescriptor` is what the **editor and viewer** consume — a game's
 * name, its component registry, its rules, its spawn, its gizmo colours. Everything below the spread is read
 * by the client and nothing else, which is exactly why it sits here as an argument rather than as a field on a
 * contract shared with two tools that do not care.
 *
 * **When this game outgrows `startTpsClient`**, do not add an option to it. Stop calling it and compose
 * `@mp/game-client`'s services here instead — `createScene`, `createNetHost`, `loadLevelInto`, `createShell`,
 * `worldFromBase` — plus whichever of `@mp/tps`'s pieces you still want (`createAvatars`, `createInputs`,
 * `installDebugPane`). `packages/tps/src/client.ts` is the worked example, and it is roughly 700 lines: that is
 * the real price of a game the shipped one cannot express, and it buys direct access to Three and Rapier with
 * nothing in the way.
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
await startTpsClient({
  ...TEMPLATE_MODE,

  /**
   * How this game's characters look and move (ADR 0063). Both optional; absent is the shipped biped.
   *
   * `gait` retunes the shared cycle — stride, bob, lean, arm swing. Spread rather than passed, so the debug
   * pane's live edits cannot leak into the shared default.
   */
  gait: { ...DEFAULT_GAIT },

  /**
   * `animator` **replaces** the cycle. To add a state the platform has never heard of, wrap the shared one:
   *
   * ```ts
   * // beside your own dash component, whose state you close over
   * let dashing = false
   * animator: (gait, seed) => {
   *   const shared = createAnimator(gait, seed)
   *   return { step: (input, dt) => (dashing ? dashPose() : shared.step(input, dt)) }
   * }
   * ```
   *
   * Nothing was added to `AnimationInput` for that on purpose: this factory is *your* code, so it reads your
   * own state directly.
   *
   * For **other players** a closure cannot answer — their components do not exist on this machine — so declare
   * the state and it rides the spare bits of a flags byte already being sent (ADR 0064). Five are free:
   *
   * ```ts
   * states: ['dash'],
   * playerStates: () => (dashing ? new Set(['dash']) : new Set()),
   * animator: (gait, seed, states) => {
   *   const shared = createAnimator(gait, seed)
   *   // `states` answers for whichever character this animator belongs to — us or a peer.
   *   return { step: (input, dt) => (states().has('dash') ? dashPose() : shared.step(input, dt)) }
   * },
   * ```
   *
   * Order is bit order: appending a state is safe, reordering reinterprets every peer's bits, and a sixth
   * throws rather than working locally and never for anybody else.
   */
  animator: createAnimator,
})
