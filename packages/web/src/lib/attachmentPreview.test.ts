import { expect, test } from 'bun:test'
import { splitImageMarkers } from './attachmentPreview'

test('a marker jammed against the first word is taken off it', () => {
  expect(splitImageMarkers('[Image #22]os itens nao estao indo'))
    .toEqual({ markers: [22], text: 'os itens nao estao indo' })
})

test('a merged turn carries the whole run of markers at the front', () => {
  expect(splitImageMarkers('[Image #4] [Image #5] [Image #6]1. a visao geral'))
    .toEqual({ markers: [4, 5, 6], text: '1. a visao geral' })
})

test('a marker further down is left where it is — somebody wrote it', () => {
  const msg = 'the harness writes [Image #4] where the image was'
  expect(splitImageMarkers(msg)).toEqual({ markers: [], text: msg })
})

test('text with no marker is returned untouched, whitespace included', () => {
  expect(splitImageMarkers('  olha esse print\n')).toEqual({ markers: [], text: '  olha esse print\n' })
})

test('a turn that is nothing but markers keeps no text', () => {
  expect(splitImageMarkers('[Image #1] [Image #2]')).toEqual({ markers: [1, 2], text: '' })
})
