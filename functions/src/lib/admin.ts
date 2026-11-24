/** Firebase Admin SDK singletons (lazy so unit tests can import modules without credentials). */
import { getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore, type Firestore } from 'firebase-admin/firestore'

let firestore: Firestore | null = null

export function ensureApp() {
  if (!getApps().length) initializeApp()
}

export function adminDb(): Firestore {
  if (!firestore) {
    ensureApp()
    firestore = getFirestore()
  }
  return firestore
}

export type Db = Firestore
export type Row = Record<string, any>
