import { describe, expect, it } from 'bun:test'
import {
  fileFormat, formatBytes, galleryFileCount, galleryGroups, galleryImageKey, galleryImages,
  galleryMenuEntries, parseGalleryView, type GalleryTurn, producedGroups, gallerySides, filterGallery, parseGalleryScope, effectiveScope } from './gallery'

const DIR = '/home/u/.agentistics/attachments'
const shot = `${DIR}/724e7aa8-image.png`
const other = `${DIR}/9f0b1c22-layout.png`
const notes = `${DIR}/aa11bb22-notes.txt`

function user(text: string, at?: string): GalleryTurn {
  return at ? { role: 'user', text, at } : { role: 'user', text }
}

describe('galleryGroups', () => {
  it('groups the files of one message together, keeping the words', () => {
    const groups = galleryGroups([
      user(`${shot}\n${other}\nnuma view menor ficou tudo empilhado ainda rs`, '2026-09-04T10:00:00Z'),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.files.map(f => f.name)).toEqual(['724e7aa8-image.png', '9f0b1c22-layout.png'])
    expect(groups[0]!.text).toBe('numa view menor ficou tudo empilhado ainda rs')
    expect(groups[0]!.at).toBe('2026-09-04T10:00:00Z')
  })

  it('keeps a message that carried files and no words', () => {
    const groups = galleryGroups([user(shot)])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.text).toBe('')
    expect(groups[0]!.files).toHaveLength(1)
  })

  it('leaves a message with words and no files OUT of the gallery entirely', () => {
    expect(galleryGroups([user('roda os testes por favor')])).toEqual([])
  })

  it('gives the same file sent in two messages two entries', () => {
    const groups = galleryGroups([user(`${shot}\nolha isso`), user(`${shot}\ne agora?`)])
    expect(groups).toHaveLength(2)
    expect(groups[0]!.files[0]!.path).toBe(shot)
    expect(groups[1]!.files[0]!.path).toBe(shot)
  })

  it('carries the turn INDEX, so the anchor points at the bubble that was rendered', () => {
    const groups = galleryGroups([
      user('sem anexo'),
      { role: 'assistant', text: 'ok' },
      user(`${shot}\ncom anexo`),
    ])
    expect(groups.map(g => g.index)).toEqual([2])
  })

  it('keeps the transcript order', () => {
    const groups = galleryGroups([user(`${other}\nb`), user(`${shot}\na`)])
    expect(groups.map(g => g.files[0]!.name)).toEqual(['9f0b1c22-layout.png', '724e7aa8-image.png'])
  })

  it('never claims a turn nobody typed', () => {
    expect(galleryGroups([{ role: 'user', text: shot, system: 'reminder' }])).toEqual([])
    expect(galleryGroups([{ role: 'user', text: shot, task: { label: 'x', running: false } }])).toEqual([])
    expect(galleryGroups([{ role: 'assistant', text: shot }])).toEqual([])
  })

  it('marks a file that cannot be previewed rather than promising a thumbnail', () => {
    const groups = galleryGroups([user(`${notes}\nleia`)])
    expect(groups[0]!.files[0]).toEqual({
      path: notes, name: 'aa11bb22-notes.txt', image: false, format: 'TXT', origin: 'sent',
    })
  })

  it('omits `at` when the transcript carried none', () => {
    expect(galleryGroups([user(shot)])[0]!.at).toBeUndefined()
  })
})

describe('galleryImages', () => {
  it('flattens only the previewable ones, in reading order, each knowing its message', () => {
    const groups = galleryGroups([user(`${shot}\n${notes}\na`), user(`${other}\nb`)])
    const images = galleryImages(groups)
    expect(images.map(i => i.path)).toEqual([shot, other])
    expect(images[0]!.group.index).toBe(0)
    expect(images[1]!.group.index).toBe(1)
  })

  it('keys each entry by its POSITION, so the same file sent twice is two distinct entries', () => {
    const groups = galleryGroups([user(`${shot}\n${shot}\na`)])
    const images = galleryImages(groups)
    expect(images.map(i => i.key)).toEqual(['0:0', '0:1'])
    expect(galleryImageKey(3, 2)).toBe('3:2')
  })
})

describe('galleryFileCount', () => {
  it('counts files, not messages', () => {
    expect(galleryFileCount(galleryGroups([user(`${shot}\n${notes}\na`), user(`${other}\nb`)]))).toBe(3)
  })
})

describe('fileFormat', () => {
  it('reads the extension', () => {
    expect(fileFormat('a.PNG')).toBe('PNG')
    expect(fileFormat('a.tar.gz')).toBe('GZ')
  })
  it('says nothing when there is no extension to read', () => {
    expect(fileFormat('README')).toBe('')
    expect(fileFormat('.bashrc')).toBe('')
    expect(fileFormat('trailing.')).toBe('')
  })
})

describe('formatBytes', () => {
  it('scales', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(200 * 1024)).toBe('200 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })
  it('shows NOTHING for a size it does not have — never a zero', () => {
    expect(formatBytes(undefined)).toBe('')
    expect(formatBytes(Number.NaN)).toBe('')
    expect(formatBytes(-1)).toBe('')
  })
})

describe('parseGalleryView', () => {
  it('remembers a stored view', () => {
    expect(parseGalleryView('list')).toBe('list')
    expect(parseGalleryView('grid')).toBe('grid')
  })
  it('opens on the grid when there is nothing to remember, or nonsense to remember', () => {
    expect(parseGalleryView(null)).toBe('grid')
    expect(parseGalleryView('')).toBe('grid')
    expect(parseGalleryView('carousel')).toBe('grid')
  })
})

describe('galleryMenuEntries', () => {
  it('offers the recall modal\'s own three options, in its order', () => {
    expect(galleryMenuEntries(false).map(e => e.action)).toEqual(['goto', 'view', 'cancel'])
    expect(galleryMenuEntries(false).map(e => e.label))
      .toEqual(['Go to message', 'View message', 'Cancel'])
    expect(galleryMenuEntries(true).map(e => e.label))
      .toEqual(['Ir para a mensagem', 'Ver mensagem', 'Cancelar'])
  })
})

describe('what the SESSION produced', () => {
  it('lists images and PDFs the session wrote, in one block', () => {
    const out = producedGroups([
      { path: '/w/shot.png', name: 'shot.png' },
      { path: '/w/report.pdf', name: 'report.pdf' },
      { path: '/w/index.ts', name: 'index.ts' },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.files.map(f => f.name)).toEqual(['shot.png', 'report.pdf'])
    expect(out[0]!.files[0]!.image).toBe(true)
    expect(out[0]!.files[1]!.image).toBe(false)   // a PDF has no thumbnail to promise
    expect(out[0]!.files.every(f => f.origin === 'produced')).toBe(true)
  })

  it('has NO message behind it, and says so with index -1', () => {
    const out = producedGroups([{ path: '/w/shot.png', name: 'shot.png' }])
    expect(out[0]!.index).toBe(-1)
    // …which is what removes the two verbs that name a message.
    expect(galleryMenuEntries(false, out[0]!).map(e => e.action)).toEqual(['cancel'])
    expect(galleryMenuEntries(false, { index: 3 }).map(e => e.action)).toEqual(['goto', 'view', 'cancel'])
  })

  it('a session that produced no media produces no block', () => {
    expect(producedGroups([{ path: '/w/index.ts', name: 'index.ts' }])).toEqual([])
    expect(producedGroups([])).toEqual([])
  })
})

describe('the two sides of the gallery', () => {
  const sent = { path: '/a/x.png', name: 'x.png', image: true, format: 'PNG', origin: 'sent' as const }
  const made = { path: '/b/y.png', name: 'y.png', image: true, format: 'PNG', origin: 'produced' as const }
  const groups = [
    { index: 0, text: 'veja', files: [sent] },
    { index: -1, text: '', files: [made] },
  ]

  it('counts each side', () => {
    expect(gallerySides(groups)).toEqual({ user: 1, llm: 1 })
  })

  it('a file with no origin is the person’s — every group written before this existed', () => {
    expect(gallerySides([{ index: 0, text: '', files: [{ ...sent, origin: undefined }] }]))
      .toEqual({ user: 1, llm: 0 })
  })

  it('filters per FILE, and drops a group left with nothing', () => {
    expect(filterGallery(groups, 'llm').map(g => g.index)).toEqual([-1])
    expect(filterGallery(groups, 'user').map(g => g.index)).toEqual([0])
    expect(filterGallery(groups, 'all')).toHaveLength(2)
  })

  it('a stored scope this code did not write reads as all', () => {
    expect(parseGalleryScope('llm')).toBe('llm')
    expect(parseGalleryScope('nonsense')).toBe('all')
    expect(parseGalleryScope(null)).toBe('all')
  })
})

describe('a filter whose control is not on screen', () => {
  it('falls back to everything when its side is empty', () => {
    // The reported state: `llm` chosen while the session had produced files, the files removed,
    // the switch no longer drawn (it needs BOTH sides), and the gallery showing 11 on its tab with
    // nothing in its body and no way back.
    expect(effectiveScope('llm', { user: 11, llm: 0 })).toBe('all')
    expect(effectiveScope('user', { user: 0, llm: 4 })).toBe('all')
  })

  it('leaves a scope alone while its side still holds something', () => {
    expect(effectiveScope('llm', { user: 11, llm: 2 })).toBe('llm')
    expect(effectiveScope('user', { user: 11, llm: 2 })).toBe('user')
    expect(effectiveScope('all', { user: 0, llm: 0 })).toBe('all')
  })
})
