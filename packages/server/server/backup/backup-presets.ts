/**
 * backup-presets.ts — PURE: the named shapes a backup can take.
 *
 * The layer checkboxes are four independent switches, and asking somebody to pick among them is
 * asking them to already know what a restore needs. The layers are not a preference: they decide
 * whether a restore brings a MACHINE back or half of one. So there is a recommended shape, said in
 * words, and the other two exist because both are legitimate.
 *
 * A default nobody endorses is a default everybody second-guesses.
 */
import { BACKUP_LAYERS, type BackupLayer } from './backup-plan'

export interface BackupPreset {
  id: 'minimal' | 'recommended' | 'everything'
  layers: BackupLayer[]
  /** Exactly one preset carries this. */
  recommended?: true
}

export const RECOMMENDED_PRESET = 'recommended'

/**
 * The three shapes.
 *
 * `metrics` is in all of them and is not optional anywhere: a backup without it restores nothing.
 *
 * - **minimal** — the dashboard and the history come back; the map of WHERE every repository was
 *   does not. Right for a machine that is not being replaced.
 * - **recommended** — adds that map, plus a bundle of the commits that exist on no remote and a
 *   patch of the uncommitted work. Measured on a real machine: 112 MB against 2.4 MB, and it is
 *   the difference between "my dashboard is back" and "my machine is back".
 * - **everything** — adds the transcripts, which are 2.4 GB here. Complete, and a size that has to
 *   be chosen deliberately rather than arrived at.
 */
export const BACKUP_PRESETS: BackupPreset[] = [
  { id: 'minimal', layers: ['metrics'] },
  { id: 'recommended', layers: ['metrics', 'repos'], recommended: true },
  { id: 'everything', layers: [...BACKUP_LAYERS] },
]

/**
 * The preset a layer SET is, or the preset with a given id — or null.
 *
 * Matching is by SET and not by order: someone who ticked `repos` and then `metrics` chose the
 * recommended shape and should see it named rather than told they are on something custom. Null
 * when nothing matches, never a nearest guess: telling somebody they are on the recommended shape
 * when they are not is worse than saying they are on their own.
 */
export function presetFor(input: BackupLayer[] | string): BackupPreset | null {
  if (typeof input === 'string') return BACKUP_PRESETS.find(p => p.id === input) ?? null
  const want = [...new Set(input)].sort().join(',')
  return BACKUP_PRESETS.find(p => [...p.layers].sort().join(',') === want) ?? null
}
