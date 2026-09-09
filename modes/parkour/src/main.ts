import { startTpsClient } from '@mp/tps'

import { PARKOUR_MODE } from './editorMode'

/**
 * Parkour, as an application.
 *
 * `@mp/tps` is the third-person game the platform ships and parkour *is* that game, so it calls it (ADR 0065).
 * The descriptor is what the editor and viewer consume; nothing below it is needed, because parkour wants the
 * shipped biped, the shipped walk cycle and no states of its own.
 *
 * What used to be here — the stage, the netcode, the camera, the render loop — was never parkour's. What is no
 * longer here either is the claim that it was the *platform's*: it is `@mp/tps`'s, one game's opinion, and
 * `modes/_template/src/main.ts` is the file that says what to do when a game disagrees with it.
 */
await startTpsClient(PARKOUR_MODE)
