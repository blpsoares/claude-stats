import { describe, expect, it } from 'bun:test'
import type { ProfileMetric } from '@agentistics/core'
import { PROFILE_METRIC_EN, PROFILE_METRIC_PT } from '@agentistics/tui/control/i18n'
import { LABEL_EN, LABEL_PT } from './ProfilePanel'

/**
 * The cross-check `PROFILE_METRIC_EN`/`PROFILE_METRIC_PT`'s own comment promises: the cockpit's
 * label maps and this panel's are two separately-typed literals in two packages, so TypeScript
 * checks each one against `ProfileMetric` alone and never against its twin — a translator who
 * updates one map and forgets the other compiles clean in both places. Same spirit as
 * `web/src/lib/tagMatch.test.ts`'s cross-check of the web mirror against the server's own rule.
 */
function keysOf(labels: Record<ProfileMetric, string>): string[] {
  return Object.keys(labels).sort()
}

describe('ProfilePanel label maps stay in sync with the cockpit', () => {
  it('the EN maps cover exactly the same ProfileMetric keys', () => {
    expect(keysOf(LABEL_EN)).toEqual(keysOf(PROFILE_METRIC_EN))
  })

  it('the PT maps cover exactly the same ProfileMetric keys', () => {
    expect(keysOf(LABEL_PT)).toEqual(keysOf(PROFILE_METRIC_PT))
  })
})
