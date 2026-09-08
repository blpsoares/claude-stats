import { describe, expect, it } from 'bun:test'
import { webHarnesses } from './spawn-web'

const host = {
  async startableHarnesses() {
    return [{
      id: 'claude', label: 'Claude Code',
      modelSuggestions: ['fable', 'opus', 'sonnet', 'haiku'],
      supportsModel: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    }]
  },
} as never

describe('webHarnesses', () => {
  it('carries the labelled models beside the ids, so the picker can print a name', async () => {
    const [claude] = await webHarnesses(host)
    expect(claude!.models.map(m => m.id)).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
    expect(claude!.models.find(m => m.id === 'opus')!.label).toBe('Opus 5')
  })

  it('keeps modelSuggestions, so an older client is unaffected', async () => {
    const [claude] = await webHarnesses(host)
    expect(claude!.modelSuggestions).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
  })
})
