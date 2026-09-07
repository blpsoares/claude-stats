import { expect, test } from 'bun:test'
import { extensionOf, isMediaPath, mediaTypeFor, REFUSED_EXT } from './artifact-media'

test('the table decides, and it is closed', () => {
  expect(mediaTypeFor('/tmp/shot.png')?.mime).toBe('image/png')
  expect(mediaTypeFor('/tmp/report.PDF')?.kind).toBe('pdf')
  // Not in the table: refused rather than served as octet-stream, which would make this route a
  // general download for anything a session ever wrote.
  expect(mediaTypeFor('/tmp/secrets.env')).toBeNull()
  expect(mediaTypeFor('/tmp/build.tar.gz')).toBeNull()
})

test('SVG is refused — it is a document that can carry script', () => {
  expect(mediaTypeFor('/tmp/diagram.svg')).toBeNull()
  // …but it is KNOWN to be refused, so the gallery can say so instead of dropping it silently.
  expect(isMediaPath('/tmp/diagram.svg')).toBe(true)
  expect(REFUSED_EXT.has('svg')).toBe(true)
})

test('a file with no extension is not media', () => {
  expect(mediaTypeFor('/tmp/Makefile')).toBeNull()
  expect(extensionOf('/tmp/Makefile')).toBe('')
})

test('a dotfile is not an extension', () => {
  expect(extensionOf('/home/u/.bashrc')).toBe('')
  expect(mediaTypeFor('/home/u/.bashrc')).toBeNull()
})

test('windows separators are paths too', () => {
  expect(extensionOf('C:\\tmp\\shot.PNG')).toBe('png')
})
