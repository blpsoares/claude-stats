/**
 * dictation.ts — PURE: can this browser take dictation, and what does the button say when it cannot?
 *
 * The Web Speech API is the only way to do this without shipping a model or sending audio to a
 * server, and it is NOT universally available: Firefox does not implement it, and every browser
 * that does requires a secure context — so `http://` over a LAN, which is exactly how a member
 * machine's dashboard is usually reached, has no microphone at all.
 *
 * That makes this a capability question, and the rule is the one `HARNESS_CAPABILITIES` states: an
 * absent feature is said in WORDS, never rendered as a control that silently does nothing. A mic
 * button that fails on click is indistinguishable from a broken one.
 *
 * Note what this deliberately does NOT do: no audio is uploaded anywhere by this product. The
 * recognition runs in the browser, and what reaches the session is the TEXT the user then chooses
 * to send — the same text they could have typed.
 */

export type DictationState = 'ready' | 'no-api' | 'insecure'

export interface DictationSupport {
  state: DictationState
  /** Already-worded reason, or null when dictation is available. */
  reason: string | null
}

/**
 * `win` is threaded in rather than read from the global so the decision is testable — there is no
 * `window` in the test runner, and a rule that can only be exercised by opening a browser is a rule
 * nothing checks.
 */
export function dictationSupport(
  win: { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown; isSecureContext?: boolean } | undefined,
  lang: 'en' | 'pt',
): DictationSupport {
  const pt = lang === 'pt'
  const hasApi = !!win && (typeof win.SpeechRecognition !== 'undefined' || typeof win.webkitSpeechRecognition !== 'undefined')
  if (!hasApi) {
    return {
      state: 'no-api',
      reason: pt
        ? 'Este navegador não faz ditado. Chrome e Edge fazem.'
        : 'This browser does not do dictation. Chrome and Edge do.',
    }
  }
  // Checked SECOND, and only when the API exists: a browser without the API is not going to gain
  // it over HTTPS, so naming the protocol there would send someone to fix the wrong thing.
  if (win?.isSecureContext === false) {
    return {
      state: 'insecure',
      reason: pt
        ? 'O microfone exige HTTPS ou localhost. Esta página está em HTTP.'
        : 'The microphone needs HTTPS or localhost. This page is on plain HTTP.',
    }
  }
  return { state: 'ready', reason: null }
}

/** The BCP-47 tag the recogniser listens in — the UI language, because that is what the user types
 *  in. Not a guess at the machine's locale, which is often English on a Brazilian laptop. */
export function dictationLocale(lang: 'en' | 'pt'): string {
  return lang === 'pt' ? 'pt-BR' : 'en-US'
}

/**
 * Why the recogniser stopped, in words.
 *
 * `rec.onerror` used to be `() => { … }` — the event, and with it the reason, was DISCARDED. So a
 * refused permission, a recognition service that could not be reached, a missing microphone and a
 * moment of silence all looked identical from outside: the button lit up and went out. A control
 * that fails silently is indistinguishable from a broken one, which is the rule this whole module
 * was written against.
 *
 * `network` matters most: it is the common failure and it is NOT a refusal — the browser's speech
 * recognition reaches a remote service, and a machine that cannot get there has a working
 * microphone and no transcription. Telling someone to check their permissions there sends them to
 * fix the wrong thing.
 *
 * An unknown code is REPORTED, carrying the code itself. A new one must be visible, not swallowed.
 */
export function dictationError(code: string, lang: 'en' | 'pt'): string {
  const pt = lang === 'pt'
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return pt
        ? 'O navegador negou a permissão do microfone para esta página.'
        : 'The browser denied this page permission to use the microphone.'
    case 'network':
      return pt
        ? 'O serviço de reconhecimento do navegador não respondeu. O microfone está bem; a transcrição é que não chegou.'
        : 'The browser’s recognition service did not answer. The microphone is fine; the transcription is what did not arrive.'
    case 'no-speech':
      return pt
        ? 'Não ouvi nada. Tente falar mais perto do microfone.'
        : 'I did not hear anything. Try speaking closer to the microphone.'
    case 'audio-capture':
      return pt
        ? 'Nenhum microfone disponível para o navegador.'
        : 'No microphone is available to the browser.'
    case 'aborted':
      return pt ? 'O ditado foi interrompido.' : 'Dictation was interrupted.'
    default:
      return pt
        ? `O ditado parou: ${code}.`
        : `Dictation stopped: ${code}.`
  }
}

/**
 * The `localhost` address that would work, when the page is on a plain-HTTP LAN address.
 *
 * No browser grants a microphone on an insecure origin — `getUserMedia` and the Web Speech API are
 * both blocked — and `localhost` IS a secure context. A member machine's dashboard reached at
 * `http://192.168.x.y:47292` therefore has an exact equivalent one click away, and naming it is
 * more useful than naming the rule.
 *
 * Only a literal IPv4 host is rewritten. A hostname could be anything, and sending someone from
 * `dash.example.com` to `localhost` would be a guess about which machine they are sitting at.
 */
export function insecureAlternative(href: string): string | null {
  let url: URL
  try { url = new URL(href) } catch { return null }
  if (url.protocol !== 'http:') return null
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1') return null
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname)) return null
  url.hostname = 'localhost'
  return url.toString()
}

/**
 * PURE: the text ONE `onresult` event contributes.
 *
 * `SpeechRecognitionEvent.results` is CUMULATIVE — in `continuous` mode it holds every result of
 * the session so far — and `resultIndex` is the index of the first result this event changed. The
 * handler read it from index 0 on every event, so it re-emitted the whole transcript each time:
 * event 1 contributes "A", event 2's list is [A, B] and contributed "AB", event 3's contributed
 * "ABC", and the draft grew "A AB ABC". That is a defect readable from the code and the API's own
 * contract, not an observation — see the header of the test for what has and has not been measured.
 *
 * Extracted from the handler precisely so it CAN be exercised: the recogniser itself needs a
 * browser, and a rule nothing checks is a rule that comes back.
 */
export function dictatedText(e: {
  resultIndex?: number
  results: ArrayLike<ArrayLike<{ transcript: string }> | undefined>
}): string {
  // An absent `resultIndex` reads as 0 — an implementation that does not provide it has no growing
  // list to skip either, so reading from the start is the correct behaviour there.
  const from = typeof e.resultIndex === 'number' ? e.resultIndex : 0
  let text = ''
  for (let i = from; i < e.results.length; i++) text += e.results[i]?.[0]?.transcript ?? ''
  return text
}

/**
 * PURE: where the dictated text lands in what is already typed.
 *
 * Appended with a separating space rather than replacing: somebody may have typed half a sentence
 * before reaching for the microphone. Empty input leaves the draft exactly as it was — a recogniser
 * that heard nothing must not add whitespace to a field somebody is in the middle of.
 */
export function appendDictation(draft: string, text: string): string {
  const add = text.trim()
  if (add === '') return draft
  return draft.trim() === '' ? add : `${draft.replace(/\s+$/, '')} ${add}`
}
