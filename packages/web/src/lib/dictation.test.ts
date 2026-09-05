import { describe, it, expect } from 'bun:test'
import { dictationSupport, dictationLocale, dictationError, insecureAlternative, dictatedText, appendDictation } from './dictation'

describe('dictationSupport', () => {
  it('is ready when the API exists in a secure context', () => {
    expect(dictationSupport({ SpeechRecognition: class {}, isSecureContext: true }, 'en'))
      .toEqual({ state: 'ready', reason: null })
    expect(dictationSupport({ webkitSpeechRecognition: class {}, isSecureContext: true }, 'en').state)
      .toBe('ready')
  })

  it('says so IN WORDS when the browser has no such API', () => {
    // A mic button that fails on click is indistinguishable from a broken one.
    const s = dictationSupport({ isSecureContext: true }, 'en')
    expect(s.state).toBe('no-api')
    expect(s.reason).toMatch(/does not do dictation/)
  })

  it('names HTTPS only when the API is actually there', () => {
    // A browser without the API will not gain it over HTTPS; naming the protocol there sends
    // someone to fix the wrong thing.
    expect(dictationSupport({ isSecureContext: false }, 'en').state).toBe('no-api')
    expect(dictationSupport({ SpeechRecognition: class {}, isSecureContext: false }, 'en').state).toBe('insecure')
  })

  it('treats an ABSENT isSecureContext as secure — only an explicit false blocks', () => {
    // An older browser that does not expose the flag but does expose the API still works; refusing
    // there would withhold a feature that functions.
    expect(dictationSupport({ SpeechRecognition: class {} }, 'en').state).toBe('ready')
  })

  it('survives having no window at all', () => {
    expect(dictationSupport(undefined, 'en').state).toBe('no-api')
  })

  it('every refusal has real text in both languages', () => {
    for (const lang of ['en', 'pt'] as const) {
      for (const win of [undefined, { SpeechRecognition: class {}, isSecureContext: false }]) {
        const s = dictationSupport(win, lang)
        expect(s.reason!.length).toBeGreaterThan(10)
      }
    }
    expect(dictationSupport(undefined, 'pt').reason).not.toBe(dictationSupport(undefined, 'en').reason)
  })
})

describe('dictationLocale', () => {
  it('listens in the UI language, not a guess at the machine locale', () => {
    // A Brazilian laptop is often set to English; what matters is the language being typed.
    expect(dictationLocale('pt')).toBe('pt-BR')
    expect(dictationLocale('en')).toBe('en-US')
  })
})

describe('dictationError', () => {
  it('names a refused permission', () => {
    expect(dictationError('not-allowed', 'en')).toContain('permission')
    expect(dictationError('not-allowed', 'pt')).toContain('permissão')
  })
  it('names the recognition service failing, which is not the same as a refusal', () => {
    expect(dictationError('network', 'en')).not.toBe(dictationError('not-allowed', 'en'))
  })
  it('names silence', () => {
    expect(dictationError('no-speech', 'en')).toContain('hear')
  })
  it('names a missing microphone', () => {
    expect(dictationError('audio-capture', 'en')).toContain('microphone')
  })
  it('never returns an empty string for a code it has not seen', () => {
    expect(dictationError('something-new', 'en').length).toBeGreaterThan(0)
    expect(dictationError('something-new', 'en')).toContain('something-new')
  })
})

describe('insecureAlternative', () => {
  it('offers the localhost equivalent of a LAN address', () => {
    expect(insecureAlternative('http://192.168.0.7:47292/sessions'))
      .toBe('http://localhost:47292/sessions')
  })
  it('offers nothing when the page is already on localhost', () => {
    expect(insecureAlternative('http://localhost:47292/sessions')).toBeNull()
    expect(insecureAlternative('http://127.0.0.1:47292/')).toBeNull()
  })
  it('offers nothing for a name it cannot rewrite safely', () => {
    expect(insecureAlternative('https://dash.example.com/sessions')).toBeNull()
  })
})

/**
 * What the localhost failure IS has NOT been established — that needs a browser, and none was
 * reachable when this was written. What IS established is the arithmetic below, from the code and
 * the Web Speech API's own contract: `results` is cumulative in `continuous` mode and `resultIndex`
 * names the first result an event changed.
 */
describe('dictatedText', () => {
  const ev = (resultIndex: number, ...phrases: string[]) =>
    ({ resultIndex, results: phrases.map(p => [{ transcript: p }]) })

  it('takes only what THIS event contributed, not the whole session so far', () => {
    expect(dictatedText(ev(0, 'one'))).toBe('one')
    expect(dictatedText(ev(1, 'one', ' two'))).toBe(' two')
    expect(dictatedText(ev(2, 'one', ' two', ' three'))).toBe(' three')
  })

  it('reads from the start when the implementation gives no resultIndex', () => {
    expect(dictatedText({ results: [[{ transcript: 'a' }], [{ transcript: 'b' }]] })).toBe('ab')
  })

  it('never throws on a hole in the list', () => {
    expect(dictatedText({ resultIndex: 0, results: [undefined, [{ transcript: 'x' }]] })).toBe('x')
  })

  it('a whole continuous session accumulates each phrase exactly once', () => {
    let draft = ''
    for (const [i, p] of ['one', 'two', 'three'].entries()) {
      draft = appendDictation(draft, dictatedText(ev(i, ...['one', 'two', 'three'].slice(0, i + 1))))
    }
    expect(draft).toBe('one two three')
  })
})

describe('appendDictation', () => {
  it('appends to what was already typed, with one separating space', () => {
    expect(appendDictation('half a ', 'sentence')).toBe('half a sentence')
    expect(appendDictation('', ' hello ')).toBe('hello')
  })
  it('leaves the draft untouched when nothing was heard', () => {
    expect(appendDictation('half a ', '   ')).toBe('half a ')
    expect(appendDictation('', '')).toBe('')
  })
})
