import { describe, expect, it } from 'bun:test'
import { taskProgress } from './taskProgress'

describe('taskProgress', () => {
  it('is NULL with no subtasks — "nobody broke this up" is not "nothing is done"', () => {
    expect(taskProgress(0, 0)).toEqual({ done: 0, total: 0, percent: null, complete: false })
  })

  it('rounds DOWN, so 99 of 100 never reads 100%', () => {
    expect(taskProgress(99, 100).percent).toBe(99)
    expect(taskProgress(2, 3).percent).toBe(66)
    expect(taskProgress(1, 1000).percent).toBe(0)
  })

  it('is complete only when every one is closed', () => {
    expect(taskProgress(3, 3)).toMatchObject({ percent: 100, complete: true })
    expect(taskProgress(2, 3).complete).toBe(false)
  })

  it('clamps a count that cannot be right rather than reporting over 100%', () => {
    // A store read mid-write can hand over more done than total; a 140% bar draws outside its cell.
    expect(taskProgress(7, 5)).toMatchObject({ done: 5, percent: 100, complete: true })
    expect(taskProgress(-2, 5)).toMatchObject({ done: 0, percent: 0 })
  })
})
