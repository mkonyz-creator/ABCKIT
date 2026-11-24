/**
 * Picks the backend: production Firebase, or the browser-only Demo Mode (see mode.ts).
 * The two never mix — demo mode does not initialise Firebase at all.
 */
import { createDemoDb } from './demo'
import { createFirebaseDb, isFirebaseConfigured } from './firebase'
import { IS_DEMO } from './mode'

export { IS_DEMO, DEMO_ACCOUNTS, DEMO_PASSWORD, enterDemo, exitDemo } from './mode'
export type { Session, SessionUser } from './authTypes'

/** true when the app has a backend to talk to (Firebase configured, or demo mode on) */
export const isBackendConfigured = IS_DEMO || isFirebaseConfigured

export const db = IS_DEMO || !isFirebaseConfigured ? createDemoDb() : createFirebaseDb()
