/**
 * user-prefs-store.ts — the central's per-ACCOUNT UI preferences (`userPrefs` collection).
 *
 * A collection of its own rather than a field on AccountDoc: accounts are listed by the governance
 * panels and mapped to `PublicAccount`, and UI preferences have no business travelling with an
 * identity record.
 */
import type { Collection } from 'mongodb'
import type { AccessibilityPrefs } from '@agentistics/core'
import { getMongoDb } from './mongo'

export interface UserPrefsDoc {
  /** The accountId. */
  _id: string
  accessibility?: AccessibilityPrefs
  /** BSON Date — see mongo-dates.ts. */
  updatedAt: Date
}

async function collection(): Promise<Collection<UserPrefsDoc>> {
  const db = await getMongoDb()
  return db.collection<UserPrefsDoc>('userPrefs')
}

export async function readUserAccessibility(accountId: string): Promise<AccessibilityPrefs | null> {
  const doc = await (await collection()).findOne({ _id: accountId })
  return doc?.accessibility ?? null
}

export async function writeUserAccessibility(accountId: string, prefs: AccessibilityPrefs): Promise<void> {
  await (await collection()).updateOne(
    { _id: accountId },
    { $set: { accessibility: prefs, updatedAt: new Date() } },
    { upsert: true },
  )
}

/** Called when an account is deleted — its preferences have no owner left. */
export async function deleteUserPrefs(accountId: string): Promise<void> {
  await (await collection()).deleteOne({ _id: accountId })
}
