/**
 * manifest.ts — PURE. The document an archive carries about itself.
 *
 * It answers three questions a restore cannot answer any other way: WHICH layers are in here (so
 * "the archive layer is absent" is distinguishable from "there were no transcripts"), WHAT the old
 * $HOME was (so a different username on the new machine is a deterministic substitution rather
 * than a guess), and WHETHER the bytes arrived intact (`groups[].sha256`, checked before anything
 * is written).
 *
 * `decodeManifest` never throws and never half-reads. A manifest from a NEWER agentop is REFUSED
 * naming the version: it may describe layers or repo fields this build cannot honour, and
 * restoring the parts we recognise while dropping the rest produces a machine that looks restored
 * and is not. An OLDER one reads, with absent optional arrays becoming empty — the same tolerance
 * `fromBsonDate` applies to a mixed-version fleet.
 */
import type { HarnessId } from '@agentistics/core'
import type { BackupLayer } from './backup-plan'
import type { BackupSizes } from './backup-size'
import type { RepoEntry } from './repo-manifest'

export const MANIFEST_VERSION = 1

/** The manifest's path inside the archive. Outside the $HOME-relative tree so it can never collide
 *  with a real dotfile. */
export const MANIFEST_NAME = 'agentistics-backup.json'

export interface FileGroup {
  name: string
  /**
   * Every archived file's $HOME-relative path and size, as walked.
   *
   * This is what lets `verifyStaged` check the SET after extraction (every path present, nothing
   * extra) and report a size that merely DRIFTED instead of refusing on it — a backup is taken on a
   * live machine, and a few bytes moving between the walk and tar's read is expected, not
   * corruption. Before this the group carried only a count, which could tell "how many" but not
   * "which ones changed".
   */
  files: { rel: string; bytes: number }[]
  bytes: number
  /** sha256 over the group's concatenated file list and contents, as written. */
  sha256: string
}

export interface OmittedSecret {
  path: string
  restoreWith: string
}

export interface BackupManifest {
  version: number
  createdAt: string
  agentopVersion: string
  hostname: string
  /** The $HOME this backup was taken from. Restore rewrites this prefix only when it differs. */
  homeDir: string
  platform: string
  layers: BackupLayer[]
  harnesses: HarnessId[]
  sizes: BackupSizes
  groups: FileGroup[]
  repos: RepoEntry[]
  omittedSecrets: OmittedSecret[]
}

export type DecodedManifest =
  | { ok: true; manifest: BackupManifest }
  | { ok: false; reason: 'unreadable' | 'too-new' | 'incomplete'; found?: number }

export function encodeManifest(m: BackupManifest): string {
  return JSON.stringify(m, null, 2)
}

const REQUIRED = ['version', 'createdAt', 'homeDir', 'layers', 'harnesses', 'sizes', 'groups'] as const

/**
 * Present AND well-shaped.
 *
 * A presence check alone is exactly the half-read this function promises never to perform: a
 * `layers` that is a string passes it, gets cast, and comes back inside an `ok` manifest — where
 * the caller iterates its CHARACTERS as layer names. A `sizes` of `null` comes back as `null` under
 * a type that says it cannot be. The archive came off physical media somebody carried, so
 * structural corruption is a case rather than a hypothesis, and `ok` has to mean the shape is
 * usable, not merely that the keys were there.
 *
 * This validates STRUCTURE, not contents: an unknown layer name or a harness id this build does not
 * know still decodes, because the version gate above is what guards meaning. Rejecting on contents
 * would refuse manifests an older build should still be able to read.
 */
function shapeOk(raw: Record<string, unknown>): boolean {
  if (typeof raw.createdAt !== 'string' || typeof raw.homeDir !== 'string') return false
  if (!Array.isArray(raw.layers) || !Array.isArray(raw.harnesses) || !Array.isArray(raw.groups)) return false
  // The optional arrays may be ABSENT (an older manifest) but never present and not an array.
  if (raw.repos !== undefined && !Array.isArray(raw.repos)) return false
  if (raw.omittedSecrets !== undefined && !Array.isArray(raw.omittedSecrets)) return false
  const sizes = raw.sizes
  return typeof sizes === 'object' && sizes !== null && !Array.isArray(sizes)
}

export function decodeManifest(text: string): DecodedManifest {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text) as Record<string, unknown>
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'unreadable' }

  const version = raw.version
  if (typeof version !== 'number') return { ok: false, reason: 'incomplete' }
  if (version > MANIFEST_VERSION) return { ok: false, reason: 'too-new', found: version }

  for (const key of REQUIRED) {
    if (raw[key] === undefined || raw[key] === null) return { ok: false, reason: 'incomplete' }
  }
  if (!shapeOk(raw)) return { ok: false, reason: 'incomplete' }

  const manifest: BackupManifest = {
    version,
    createdAt: raw.createdAt as string,
    agentopVersion: typeof raw.agentopVersion === 'string' ? raw.agentopVersion : '',
    hostname: typeof raw.hostname === 'string' ? raw.hostname : '',
    homeDir: raw.homeDir as string,
    platform: String(raw.platform ?? ''),
    layers: raw.layers as BackupLayer[],
    harnesses: raw.harnesses as HarnessId[],
    sizes: raw.sizes as BackupSizes,
    groups: raw.groups as FileGroup[],
    repos: (raw.repos as RepoEntry[] | undefined) ?? [],
    omittedSecrets: (raw.omittedSecrets as OmittedSecret[] | undefined) ?? [],
  }
  return { ok: true, manifest }
}
