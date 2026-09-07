/**
 * ArtifactDoc — one file the session wrote, read here.
 *
 * Markdown goes through the SAME `react-markdown` + `remark-gfm` the chat bubbles use, under the
 * same `.ag-chat-md` styles, so a table or a code block reads the same in both places — and, not
 * incidentally, scrolls inside its own box there already, which is what keeps the page body from
 * ever scrolling sideways. `remark-breaks` is deliberately NOT here: a single newline is a line
 * break in a chat message and is not one in a document, and a spec re-flowed at every line ending
 * would not be the file the session wrote.
 *
 * Everything that is not markdown is monospace and unhighlighted: syntax highlighting would be a
 * new dependency for a panel whose purpose is reading prose.
 *
 * `⧉` copies the ABSOLUTE path. It opens no editor — this server does not launch programs on
 * behalf of a page, and a button that pretended to would be the one dishonest control here.
 *
 * THREE STATES, THREE SENTENCES. Reading, refused, and read — never one empty box for all three.
 * The refusal is the machine's OWN sentence, rendered verbatim: this component composes none of
 * them, exactly as the pure modules behind the route name none of them either.
 */

import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { highlight, languageOf, type TokenKind } from '../../lib/codeHighlight'
import remarkGfm from 'remark-gfm'
import { ArrowLeft, Check, Copy, FileText } from 'lucide-react'
import type { Artifact } from '../../lib/sessionArtifacts'

/** What `GET /api/fleet/file` answers. Mirrors `ArtifactResponse` on the server. */
type ArtifactPayload =
  | { ok: true; text: string; path: string; relPath: string; bytes: number; truncated: boolean }
  | { ok: false; message: string }

export interface ArtifactDocProps {
  /** The session the file belongs to — the server rebuilds ITS allowlist from this. */
  sessionId: string
  /** The row that was clicked, from `artifactsFromTurns`. */
  artifact: Artifact
  lang: 'pt' | 'en'
  /** Back to the list. Absent where there is nowhere to go back to. */
  onBack?: () => void
}

/**
 * The file, as something to read: a gutter of line numbers beside coloured code.
 *
 * The colours are the application's own tokens rather than an editor theme's, so a file read here
 * looks like the product it is read in — and they follow light and dark with it, which a fixed
 * palette from a highlighter's stylesheet would not.
 *
 * A language the lexer does not know renders PLAIN and still numbered. Mis-colouring is worse than
 * no colouring: a string drawn as code tells the reader something false about the file, and this
 * view exists to be trusted.
 */
function CodeView({ text, name }: { text: string; name: string }) {
  const lang = languageOf(name)
  const lines = highlight(text, lang)
  const colour: Record<TokenKind, string> = {
    plain: 'var(--text-secondary)',
    comment: 'var(--text-tertiary)',
    string: 'var(--accent-green, #22c55e)',
    number: 'var(--anthropic-orange)',
    keyword: '#a78bfa',
    punct: 'var(--text-tertiary)',
  }
  return (
    <div style={{
      borderRadius: 9, background: 'var(--bg-base)', border: '1px solid var(--border-subtle)',
      maxWidth: '100%', overflowX: 'auto',
      fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, Consolas, monospace",
      fontSize: 12, lineHeight: 1.6,
    }}>
      <table style={{ borderCollapse: 'collapse', width: 'max-content', minWidth: '100%' }}>
        <tbody>
          {lines.map((toks, i) => (
            <tr key={i}>
              {/* The gutter is `user-select: none` so copying the code does not take the numbers
                  with it — the one thing that makes a numbered view useless to copy from. */}
              <td style={{
                userSelect: 'none', textAlign: 'right', verticalAlign: 'top',
                padding: '0 10px 0 12px', width: 1, whiteSpace: 'nowrap',
                color: 'var(--text-tertiary)', opacity: 0.55, fontVariantNumeric: 'tabular-nums',
                position: 'sticky', left: 0, background: 'var(--bg-base)',
              }}>{i + 1}</td>
              <td style={{ padding: '0 12px 0 0', whiteSpace: 'pre', verticalAlign: 'top' }}>
                {toks.length === 0
                  ? '\u00a0'
                  : toks.map((t, j) => (
                    <span key={j} style={{ color: colour[t.kind] }}>{t.text}</span>
                  ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** The cap the server applies, restated in words rather than in bytes. */
const MIB = 1024 * 1024

/** A size a person reads, not a byte count. Two figures is all a "how big is this" needs. */
function fmtBytes(n: number, pt: boolean): string {
  if (n < 1024) return `${n} B`
  const kb = n / 1024
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0).replace('.', pt ? ',' : '.')} kB`
  const mb = kb / 1024
  return `${mb.toFixed(mb < 10 ? 1 : 0).replace('.', pt ? ',' : '.')} MB`
}

/** Markdown is rendered as a document; everything else is shown as the text it is. */
function isMarkdown(name: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(name)
}

export function ArtifactDoc({ sessionId, artifact, lang, onBack }: ArtifactDocProps) {
  const pt = lang === 'pt'
  const [payload, setPayload] = useState<ArtifactPayload | null>(null)
  const [failed, setFailed] = useState(false)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // The file is fetched when it is CHOSEN and never again on its own. A document that reloaded
  // under the reader while a session kept writing is the "follow" behaviour the terminal's tail
  // already records the lesson for: the list updates live, the open file does not.
  useEffect(() => {
    let alive = true
    setPayload(null)
    setFailed(false)
    const q = new URLSearchParams({ id: sessionId, path: artifact.path, lang })
    fetch(`/api/fleet/file?${q}`)
      .then(r => r.json() as Promise<ArtifactPayload>)
      .then(d => { if (alive) setPayload(d) })
      .catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [sessionId, artifact.path, lang])

  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current) }, [])

  const copyPath = () => {
    void navigator.clipboard?.writeText(artifact.path).then(() => {
      setCopied(true)
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 1600)
    }).catch(() => { /* A clipboard the browser withheld is not something to report as a fault. */ })
  }

  const shown = payload?.ok ? payload : null
  // The server's relative path once it has answered; the transcript's directory until then, so the
  // header does not jump from one description of the same file to another.
  const subtitle = shown?.relPath ?? artifact.dir

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, height: '100%',
      background: 'var(--bg-surface)',
    }}>
      {/* Header: what this is, where it is, and the one thing you can do with the path. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, minWidth: 0,
        padding: '8px 10px', borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            aria-label={pt ? 'Voltar para a lista de arquivos' : 'Back to the file list'}
            title={pt ? 'Voltar' : 'Back'}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 32, height: 32, minWidth: 32, flexShrink: 0,
              borderRadius: 8, border: '1px solid var(--border)',
              background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer',
            }}
          >
            <ArrowLeft size={15} />
          </button>
        )}

        <FileText size={15} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />

        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{
            fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {artifact.name}
          </div>
          {/* The path is DIRECTION-clipped from the left: the tail of a path is what identifies it. */}
          <div
            title={artifact.path}
            style={{
              fontSize: 10.5, color: 'var(--text-tertiary)', direction: 'rtl', textAlign: 'left',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >
            <bdi>{subtitle}</bdi>
          </div>
        </div>

        <button
          type="button"
          onClick={copyPath}
          aria-label={pt ? 'Copiar o caminho completo' : 'Copy the full path'}
          title={pt ? 'Copiar o caminho completo' : 'Copy the full path'}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 32, height: 32, minWidth: 32, flexShrink: 0,
            borderRadius: 8, border: '1px solid var(--border)',
            background: 'transparent',
            color: copied ? 'var(--accent-green)' : 'var(--text-secondary)',
            cursor: 'pointer',
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>

      {/* Truncation is stated ABOVE the text, before it is read. A document silently cut short is
          one that lies about being complete, which for a spec is the whole point of reading it. */}
      {shown?.truncated && (
        <div role="status" style={{
          flexShrink: 0, padding: '6px 12px', fontSize: 11,
          color: 'var(--text-secondary)', background: 'var(--bg-elevated)',
          borderBottom: '1px solid var(--border-subtle)',
        }}>
          {pt
            ? `Mostrando o primeiro ${fmtBytes(MIB, true)} de ${fmtBytes(shown.bytes, true)}.`
            : `Showing the first ${fmtBytes(MIB, false)} of ${fmtBytes(shown.bytes, false)}.`}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: '12px 14px' }}>
        {failed ? (
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-secondary)' }}>
            {pt
              ? 'Não consegui falar com o servidor para ler este arquivo.'
              : 'The server could not be reached to read this file.'}
          </p>
        ) : payload === null ? (
          <p role="status" style={{ margin: 0, fontSize: 12.5, color: 'var(--text-tertiary)' }}>
            {pt ? 'Lendo o arquivo…' : 'Reading the file…'}
          </p>
        ) : !payload.ok ? (
          // The machine's own sentence, verbatim. This component words no refusal.
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            {payload.message}
          </p>
        ) : isMarkdown(artifact.name) ? (
          <div className="ag-chat-md" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{payload.text}</ReactMarkdown>
          </div>
        ) : (
          // A READING VIEW: numbered lines, coloured tokens, this app's own palette. Wide code
          // scrolls INSIDE this box — the page body must never scroll sideways.
          <CodeView text={payload.text} name={artifact.name} />
        )}
      </div>
    </div>
  )
}
