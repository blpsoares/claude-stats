import { describe, expect, it } from 'bun:test'
import { legacyTaskId, migrateLegacyTasks, newAttemptId, newTaskId } from './task-model'

describe('legacyTaskId', () => {
  it('is stable for the same name, so migrating twice yields one task', () => {
    expect(legacyTaskId('ship the parser')).toBe(legacyTaskId('ship the parser'))
  })

  it('separates names that differ only by case or padding, because the user typed them apart', () => {
    // A task name is a label a person chose. Folding case here would silently merge two boards.
    expect(legacyTaskId('Parser')).not.toBe(legacyTaskId('parser'))
    expect(legacyTaskId(' parser')).not.toBe(legacyTaskId('parser'))
  })

  it('is safe as a file key and as a CLI argument', () => {
    expect(legacyTaskId('a/b:c d')).toMatch(/^legacy-[0-9a-f]{10}$/)
  })
})

describe('migrateLegacyTasks', () => {
  const now = '2026-09-05T12:00:00.000Z'

  it('turns every named string into a task, and marks the finished ones delivered', () => {
    const tasks = migrateLegacyTasks({ names: ['ship the parser', 'AIPE'], finished: ['AIPE'], now })
    expect(tasks.map(t => t.title)).toEqual(['ship the parser', 'AIPE'])
    expect(tasks.map(t => t.status)).toEqual(['open', 'delivered'])
    expect(tasks[1]!.deliveredAt).toBe(now)
  })

  it('is idempotent: the same input twice yields identical records', () => {
    const a = migrateLegacyTasks({ names: ['x'], finished: [], now })
    const b = migrateLegacyTasks({ names: ['x'], finished: [], now })
    expect(a).toEqual(b)
  })

  it('carries a finished name that no session still references', () => {
    // `finishedTasks` outlives the sessions it was about. A delivery that happened is not erased by
    // its rows being cleaned up.
    const tasks = migrateLegacyTasks({ names: [], finished: ['gone'], now })
    expect(tasks.map(t => [t.title, t.status])).toEqual([['gone', 'delivered']])
  })

  it('dedupes a name that appears on many sessions', () => {
    const tasks = migrateLegacyTasks({ names: ['x', 'x', 'x'], finished: [], now })
    expect(tasks).toHaveLength(1)
  })
})

describe('id minting', () => {
  it('mints distinct ids that are safe as CLI arguments', () => {
    expect(newTaskId()).not.toBe(newTaskId())
    expect(newTaskId()).toMatch(/^t-[0-9a-f]{10}$/)
    expect(newAttemptId()).toMatch(/^a-[0-9a-f]{10}$/)
  })
})
