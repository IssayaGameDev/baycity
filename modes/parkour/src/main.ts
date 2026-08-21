import { startGameClient } from '@mp/game-client'

import { PARKOUR_MODE } from './editorMode'

/**
 * Parkour, as an application.
 *
 * The client is `@mp/game-client` (ADR 0056); this file is the composition, and the descriptor is the whole
 * of what parkour contributes. What used to be here — the stage, the netcode, the camera, the render loop —
 * was never parkour's, and a second game proved it by needing all of it verbatim.
 */
await startGameClient(PARKOUR_MODE)
