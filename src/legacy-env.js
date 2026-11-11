// Imported first by the entry point, before anything reads the environment: AGENTLINK_* settings,
// from before the rename, still count.
import { legacyEnv } from './legacy.js'
legacyEnv()
