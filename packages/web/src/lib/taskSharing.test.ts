import { describe, expect, it } from 'bun:test'
import { sharingCopy } from './taskSharing'

describe('sharingCopy', () => {
  it('says nothing travels when the delivery is not shared', () => {
    const c = sharingCopy({ shared: false, mode: 'member', connections: 2, lang: 'en' })
    expect(c.body).toContain('stays on this machine')
    expect(c.sessions).toBeUndefined()
  })

  it('says nothing travels when there is no central, even when marked shared', () => {
    // The switch must not read as a share that already happened.
    const c = sharingCopy({ shared: true, mode: 'solo', connections: 0, lang: 'en' })
    expect(c.body).toContain('no central')
    expect(c.body).toContain('nothing travels')
  })

  it('names what travels, and says the files themselves do not', () => {
    const c = sharingCopy({ shared: true, mode: 'member', connections: 1, lang: 'en' })
    expect(c.body).toContain('NAMES of the files')
    expect(c.body).toContain('do not travel')
  })

  it('always states that the repository rules still bind the sessions', () => {
    for (const lang of ['en', 'pt'] as const) {
      const c = sharingCopy({ shared: true, mode: 'member', connections: 3, lang })
      expect(c.sessions).toBeTruthy()
      expect(c.sessions!.length).toBeGreaterThan(20)
    }
  })

  it('counts the centrals it is talking about', () => {
    expect(sharingCopy({ shared: true, mode: 'member', connections: 3, lang: 'en' }).body)
      .toContain('3 connected centrals')
    expect(sharingCopy({ shared: true, mode: 'member', connections: 1, lang: 'en' }).body)
      .toContain('the connected central')
  })
})
