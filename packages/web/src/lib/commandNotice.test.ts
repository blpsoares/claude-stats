import { describe, expect, it } from 'bun:test'
import { commandNotFoundNotice } from './commandNotice'

describe('commandNotFoundNotice', () => {
  it('names the command and says the send is not blocked, in English', () => {
    const msg = commandNotFoundNotice('/serana', false)
    expect(msg).toContain('/serana')
    expect(msg.toLowerCase()).toContain('can still be sent')
  })

  it('names the command and says the send is not blocked, in Portuguese', () => {
    const msg = commandNotFoundNotice('/serana', true)
    expect(msg).toContain('/serana')
    expect(msg.toLowerCase()).toContain('ainda pode ser enviada')
  })
})
