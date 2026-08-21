import { startGameClient } from '@mp/game-client'

import { SWING_MODE } from './editorMode'

/**
 * Swing, as an application. Three lines, and the third is the only one that varies — which is the whole claim
 * of ADR 0056, tested by this file existing.
 */
await startGameClient(SWING_MODE)
