/**
 * codeHighlight.ts — PURE: a file's text, split into lines of coloured spans.
 *
 * The artifacts panel showed code as one grey block. Asked for a reading view "igual o vscode" with
 * line numbers, in this application's own palette.
 *
 * WHY THIS IS HAND-WRITTEN rather than a highlighter dependency: the panel needs a handful of token
 * classes to make code readable — comments back, strings and numbers apart, keywords forward — and
 * a real highlighter brings a grammar engine and a stylesheet whose colours are then fought with to
 * match this app. The same argument `antigravity-protobuf.ts` records for its own wire reader.
 *
 * IT REFUSES RATHER THAN GUESSES. A language it does not know is returned as PLAIN lines — still
 * numbered, just uncoloured. Mis-colouring is worse than not colouring: a string that is drawn as
 * code, or a comment that is not, tells the reader something false about what they are looking at,
 * and this viewer exists to be read from.
 *
 * It is a LEXER, not a parser. It does not know scope, types or JSX; it knows what a comment, a
 * string, a number, a keyword and a name look like, which is what separates the lines of a file at
 * a glance. Ambiguities that would need a parser — a regex literal against a division, a `<` in JSX
 * against a comparison — are deliberately left as plain text rather than resolved by guessing.
 */

export type TokenKind = 'plain' | 'comment' | 'string' | 'number' | 'keyword' | 'punct'

export interface Token { kind: TokenKind; text: string }

/** Languages this lexer claims to know. Anything else is returned plain, on purpose. */
const KEYWORDS: Record<string, ReadonlySet<string>> = {
  ts: new Set([
    'import', 'from', 'export', 'default', 'const', 'let', 'var', 'function', 'return', 'if', 'else',
    'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'new', 'class', 'extends', 'super',
    'this', 'typeof', 'instanceof', 'in', 'of', 'try', 'catch', 'finally', 'throw', 'async', 'await',
    'yield', 'interface', 'type', 'enum', 'implements', 'public', 'private', 'protected', 'readonly',
    'static', 'as', 'satisfies', 'declare', 'namespace', 'abstract', 'null', 'undefined', 'true',
    'false', 'void', 'never', 'unknown', 'any', 'string', 'number', 'boolean', 'object',
  ]),
  py: new Set([
    'def', 'class', 'import', 'from', 'as', 'return', 'if', 'elif', 'else', 'for', 'while', 'in',
    'not', 'and', 'or', 'try', 'except', 'finally', 'raise', 'with', 'lambda', 'yield', 'pass',
    'break', 'continue', 'global', 'nonlocal', 'assert', 'None', 'True', 'False', 'async', 'await',
  ]),
  sh: new Set([
    'if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'case', 'esac',
    'function', 'return', 'export', 'local', 'echo', 'cd', 'set', 'unset', 'source',
  ]),
  json: new Set(['true', 'false', 'null']),
  css: new Set(['important', 'media', 'import', 'keyframes', 'supports']),
}

/** Line-comment openers per language. Block comments are `/*` for the C-like ones only. */
const LINE_COMMENT: Record<string, string> = { ts: '//', py: '#', sh: '#', css: '//', json: '' }

/**
 * Which lexer a file gets, from its extension alone.
 *
 * By EXTENSION and never by content sniffing: a file's name is a fact, and guessing a language from
 * the first line of a file somebody is about to read is how a shell script gets drawn as Python.
 * `null` means "no lexer" and yields plain, numbered lines.
 */
export function languageOf(name: string): string | null {
  const ext = (name.split('/').pop() ?? name).split('.').pop()?.toLowerCase() ?? ''
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) return 'ts'
  if (['py'].includes(ext)) return 'py'
  if (['sh', 'bash', 'zsh'].includes(ext)) return 'sh'
  if (['json', 'jsonc'].includes(ext)) return 'json'
  if (['css', 'scss'].includes(ext)) return 'css'
  return null
}

const ID_START = /[A-Za-z_$]/
const ID_PART = /[A-Za-z0-9_$]/
const DIGIT = /[0-9]/
const PUNCT = /[{}()[\].,;:?!<>=+\-*/%&|^~]/

/**
 * One line into tokens. Block-comment state is carried BETWEEN lines by the caller, because a `/*`
 * on one line colours every line until its close and a per-line lexer that forgot that would draw
 * half a comment as code.
 */
export function tokenizeLine(
  line: string, lang: string, inBlockComment: boolean,
): { tokens: Token[]; inBlockComment: boolean } {
  const keywords = KEYWORDS[lang] ?? new Set<string>()
  const lineComment = LINE_COMMENT[lang] ?? ''
  const cLike = lang === 'ts' || lang === 'css'
  const tokens: Token[] = []
  let block = inBlockComment
  let i = 0
  const push = (kind: TokenKind, text: string): void => {
    const last = tokens[tokens.length - 1]
    if (last && last.kind === kind) last.text += text
    else tokens.push({ kind, text })
  }

  while (i < line.length) {
    if (block) {
      const end = line.indexOf('*/', i)
      if (end === -1) { push('comment', line.slice(i)); i = line.length; break }
      push('comment', line.slice(i, end + 2)); i = end + 2; block = false
      continue
    }
    if (cLike && line.startsWith('/*', i)) { block = true; continue }
    if (lineComment !== '' && line.startsWith(lineComment, i)) {
      push('comment', line.slice(i)); i = line.length; break
    }
    const ch = line[i]!
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1
      while (j < line.length && line[j] !== ch) { if (line[j] === '\\') j++; j++ }
      push('string', line.slice(i, Math.min(j + 1, line.length)))
      i = j + 1
      continue
    }
    if (DIGIT.test(ch)) {
      let j = i
      while (j < line.length && /[0-9._xXa-fA-F]/.test(line[j]!)) j++
      push('number', line.slice(i, j)); i = j
      continue
    }
    if (ID_START.test(ch)) {
      let j = i
      while (j < line.length && ID_PART.test(line[j]!)) j++
      const word = line.slice(i, j)
      push(keywords.has(word) ? 'keyword' : 'plain', word)
      i = j
      continue
    }
    push(PUNCT.test(ch) ? 'punct' : 'plain', ch)
    i++
  }
  return { tokens, inBlockComment: block }
}

/** A whole file, line by line. Empty input is ONE empty line, so the gutter still starts at 1. */
export function highlight(text: string, lang: string | null): Token[][] {
  const lines = text.split('\n')
  if (lang === null) return lines.map(l => [{ kind: 'plain' as const, text: l }])
  const out: Token[][] = []
  let block = false
  for (const line of lines) {
    const r = tokenizeLine(line, lang, block)
    block = r.inBlockComment
    out.push(r.tokens)
  }
  return out
}
