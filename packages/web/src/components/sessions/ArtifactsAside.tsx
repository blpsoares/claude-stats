/**
 * ArtifactsAside — what this session has written, and the file itself.
 *
 * TWO LAYERS, one panel. The LIST is every file the conversation shows this session touching, newest
 * first; clicking one replaces the list with `ArtifactDoc` and a way back. They are layers rather
 * than a split because the panel is already the narrow column: a list and a document sharing 440px
 * would give the document less room than the conversation it was opened from.
 *
 * IT NEVER CHANGES WHAT IT SHOWS ON ITS OWN. The list updates with each poll of the conversation —
 * that is the "in real time" half — but the OPEN FILE changes only on a click. There is deliberately
 * no effect here that selects an artifact from incoming data: a panel that swaps the document you
 * are reading because the session wrote something else is a panel you cannot read in.
 *
 * THE GALLERY IS THE OTHER DIRECTION. Files, Docs and Live all answer "what did this session DO";
 * the fourth tab answers "what did I SEND it" — the attachments a person put on a message, grouped
 * by the message that carried them. It reads the same `turns` the Live feed does, so it can never
 * claim something the transcript does not show, and its rules live in `gallery.ts`.
 *
 * THREE EMPTY STATES, THREE SENTENCES, and never one shared empty box. "The conversation has not
 * loaded", "this session has written nothing" and "this harness cannot be read this way" are
 * different facts, and only the second is a statement about the session's work. The third reuses
 * `/api/fleet/chat`'s own `unavailable` sentence verbatim rather than inventing a second wording
 * for the same refusal.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  FileEdit, FilePlus2, PanelRightClose, Loader, FileText, Activity, Files,
  BookOpen, Terminal, Brain, Send, Eye, Image, Sparkles, ChevronLeft,
} from 'lucide-react'
import type { Artifact } from '../../lib/sessionArtifacts'
import {
  countSkills, groupSkills, shortName, skillInvocation, type SkillEntry,
} from '../../lib/skillGroups'
import { requestDraft } from '../../lib/composerStore'
import { splitFrontmatter } from '../../lib/skillGroups'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useIsMobile } from '../../hooks/useIsMobile'
import { agoLabel, isDoc, liveEvents, writeStatus, type LiveEvent, type LiveTurn, type WriteStatus } from '../../lib/artifactTabs'
import {
  galleryFileCount, galleryGroups, parseGalleryScope, parseGalleryView, producedGroups,
  type GalleryScope, type GalleryTurn, type GalleryView,
} from '../../lib/gallery'
import { ArtifactDoc } from './ArtifactDoc'
import { GalleryTab } from './GalleryTab'

type TabId = 'files' | 'docs' | 'live' | 'gallery' | 'skills'

/** Where the view toggle is remembered. One key, read and written in one place. */
const GALLERY_VIEW_KEY = 'agentistics:gallery-view'
const GALLERY_SCOPE_KEY = 'agentistics:gallery-scope'
const SKILL_FORMAT_KEY = 'agentistics:skill-format'

export interface ArtifactsAsideProps {
  /**
   * A tab an OPENER asked for, with the stamp that makes it a request rather than a setting.
   *
   * The reader's own choice is what normally decides the tab; this exists because the edge marker's
   * whole sentence is "the harness is running something", and pressing it to land on the file list
   * answers a question nobody asked. See `artifactsStore.ts`.
   */
  tabRequest?: { tab: string; at: number } | null
  sessionId: string
  lang: 'pt' | 'en'
  /** Every file this session touched, newest first. */
  artifacts: readonly Artifact[]
  /** The conversation has not answered yet — distinct from having answered with nothing. */
  loading: boolean
  /**
   * The harness's own refusal, when the conversation cannot be read at all. Already localized by
   * the server; shown verbatim so this panel and the chat give one answer.
   */
  unavailable?: string
  onClose: () => void
  /**
   * The session wrote through commands whose paths cannot be read off the command line.
   *
   * Reported rather than swallowed: on a session that had produced eighty files this panel said
   * "nothing written in this session yet", which is a confident wrong answer. "I cannot list these"
   * and "there are none" are different facts and get different sentences.
   */
  unlistedWrites?: boolean
  /**
   * The conversation's turns, for the LIVE tab.
   *
   * The feed is derived from the same turns the chat renders, so it can never claim something the
   * transcript does not show — which is the only guarantee that matters for a view whose whole
   * promise is "this is what is happening".
   */
  turns?: readonly LiveTurn[]
  /**
   * What the SERVER knows about each listed path: how big it is, and whether it belongs to the
   * project or is scratch under the system temp directory.
   *
   * The browser cannot answer either — it has the conversation, not the disk — and a size or a
   * scope guessed from a path would be exactly the confident wrong answer this panel keeps being
   * asked not to give.
   */
  facts?: ReadonlyMap<string, { bytes: number; scope: 'project' | 'temp' }>
}

/** `new` and `edited` read at a glance from the glyph; the word is beside it for everyone else. */
function KindIcon({ kind }: { kind: Artifact['kind'] }) {
  return kind === 'new'
    ? <FilePlus2 size={13} style={{ color: 'var(--accent-green, #22c55e)', flexShrink: 0 }} />
    : <FileEdit size={13} style={{ color: 'var(--anthropic-orange)', flexShrink: 0 }} />
}

export function ArtifactsAside({
  sessionId, lang, artifacts, loading, unavailable, unlistedWrites, turns, facts, onClose,
  tabRequest,
}: ArtifactsAsideProps) {
  const pt = lang === 'pt'
  const isMobile = useIsMobile()
  const [open, setOpen] = useState<Artifact | null>(null)
  const [tab, setTab] = useState<TabId>('files')
  /**
   * Honour a requested tab, once per request.
   *
   * Keyed on the STAMP and not on the value: the reader must stay free to move afterwards, which a
   * `[tabRequest.tab]` dependency would take away — they click Files, the prop still reads `live`,
   * and nothing changes so nothing re-runs, but the next unrelated render restores it.
   * An unknown tab is IGNORED rather than defaulted: whoever wrote it meant something this panel
   * does not have, and dropping them on Files would look like the request was honoured.
   */
  const askedAt = tabRequest?.at
  useEffect(() => {
    const t = tabRequest?.tab
    if (t === 'files' || t === 'docs' || t === 'live' || t === 'gallery' || t === 'skills') setTab(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askedAt])

  /** DOCS is a SUBSET of files, never a second list — a document cannot be in one and missing from
   *  the other. `isDoc` decides it by extension, which is what can be known without opening it. */
  const docs = useMemo(() => artifacts.filter(a => isDoc(a.path)), [artifacts])
  /**
   * CHRONOLOGICAL, oldest first, and the view follows the tail.
   *
   * It was newest-first, and the ordering was unreadable because nothing on the row said which end
   * was which — reported as exactly that. A feed of what a session is DOING reads like a terminal
   * or a chat: the newest thing is at the BOTTOM, you arrive at it, and it stays in view while more
   * arrives. Each row carries how long ago it happened, so the direction is stated rather than
   * inferred from a scroll position.
   */
  const feed = useMemo(() => liveEvents(turns ?? []), [turns])
  /**
   * The gallery: what the PERSON sent, grouped by message, PLUS what the SESSION produced.
   *
   * Two sources, one list, because a reader looking for a picture is not asking who made it. The
   * produced block goes LAST: the sent groups carry the messages they came with and read as the
   * conversation, while the produced one is a single block with no message of its own.
   */
  const gallery = useMemo(() => [
    ...galleryGroups((turns ?? []) as readonly GalleryTurn[]),
    ...producedGroups(artifacts),
  ], [turns, artifacts])
  const galleryFiles = useMemo(() => galleryFileCount(gallery), [gallery])
  /** LIST or GRID, remembered. A private window that refuses storage simply keeps the default. */
  const [galleryView, setGalleryView] = useState<GalleryView>(() => {
    try { return parseGalleryView(localStorage.getItem(GALLERY_VIEW_KEY)) } catch { return 'grid' }
  })
  /** WHOSE files — remembered like the view is. A private window that refuses storage keeps `all`. */
  const [galleryScope, setGalleryScope] = useState<GalleryScope>(() => {
    try { return parseGalleryScope(localStorage.getItem(GALLERY_SCOPE_KEY)) } catch { return 'all' }
  })
  const chooseGalleryScope = (v: GalleryScope) => {
    setGalleryScope(v)
    try { localStorage.setItem(GALLERY_SCOPE_KEY, v) } catch { /* private mode */ }
  }
  const chooseGalleryView = (v: GalleryView) => {
    setGalleryView(v)
    try { localStorage.setItem(GALLERY_VIEW_KEY, v) } catch { /* private mode */ }
  }
  /**
   * The skills this session can invoke, read ONCE and only when the tab is opened.
   *
   * The composer fetches the same list for its `/` picker; this is a second reader of one route,
   * not a second source. Deliberately not lifted into a shared store: the two are opened at
   * different moments and a store would fetch for a reader that never asked.
   *
   * `null` is "not read yet" and `[]` is "none", which are different sentences on screen — the same
   * distinction the rest of this panel keeps.
   */
  const [skills, setSkills] = useState<SkillEntry[] | null>(null)
  const [skillsNote, setSkillsNote] = useState<string | null>(null)
  const [skillQuery, setSkillQuery] = useState('')
  /** The skill being READ, and its file. `null` is the list; a name is the detail view. */
  const [openSkill, setOpenSkill] = useState<string | null>(null)
  /** How the skill's file is shown. Remembered, because it is a preference and not a per-skill one. */
  const [skillFormat, setSkillFormat] = useState<'md' | 'text'>(() => {
    try { return localStorage.getItem(SKILL_FORMAT_KEY) === 'text' ? 'text' : 'md' } catch { return 'md' }
  })
  const chooseSkillFormat = (v: 'md' | 'text') => {
    setSkillFormat(v)
    try { localStorage.setItem(SKILL_FORMAT_KEY, v) } catch { /* private mode */ }
  }
  const [skillBody, setSkillBody] = useState<
    { ok: true; text: string; truncated: boolean } | { ok: false; message: string } | null
  >(null)
  useEffect(() => {
    if (openSkill === null) { setSkillBody(null); return }
    let alive = true
    setSkillBody(null)
    fetch(`/api/fleet/skill?id=${encodeURIComponent(sessionId)}&name=${encodeURIComponent(openSkill)}&lang=${pt ? 'pt' : 'en'}`)
      .then(r => r.json())
      .then((d: { ok?: boolean; text?: string; truncated?: boolean; message?: string }) => {
        if (!alive) return
        setSkillBody(d?.ok
          ? { ok: true, text: d.text ?? '', truncated: d.truncated === true }
          : { ok: false, message: d?.message ?? (pt ? 'Não foi possível ler.' : 'Could not read it.') })
      })
      .catch(() => {
        if (alive) setSkillBody({ ok: false, message: pt ? 'Não foi possível ler.' : 'Could not read it.' })
      })
    return () => { alive = false }
  }, [openSkill, sessionId, pt])
  const skillGroups = useMemo(
    () => groupSkills(skills ?? [], skillQuery, pt ? 'pt' : 'en'),
    [skills, skillQuery, pt],
  )
  useEffect(() => {
    if (tab !== 'skills' || skills !== null) return
    let alive = true
    fetch(`/api/fleet/skills?id=${encodeURIComponent(sessionId)}&lang=${pt ? 'pt' : 'en'}`)
      .then(r => (r.ok ? r.json() : null))
      .then((d: { skills?: SkillEntry[]; reason?: string } | null) => {
        if (!alive) return
        setSkills(d?.skills ?? [])
        setSkillsNote(d?.reason ?? null)
      })
      .catch(() => { if (alive) setSkills([]) })
    return () => { alive = false }
  }, [tab, skills, sessionId, pt])

  const feedRef = useRef<HTMLDivElement>(null)
  /** A clock, so "3m ago" ages while the panel is open rather than freezing at its first render. */
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    if (tab !== 'live') return
    const el = feedRef.current
    if (!el) return
    // Follow the tail only while the reader IS at the tail. Yanking the view down while somebody
    // scrolled up to read something is the worst thing a live view does — the same rule the chat
    // keeps.
    const atTail = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (atTail || el.scrollTop === 0) el.scrollTop = el.scrollHeight
  }, [feed.length, tab])

  const live = artifacts.filter(a => a.live)
  const past = artifacts.filter(a => !a.live)
  const created = artifacts.filter(a => a.kind === 'new').length

  const header = (
    <header style={{
      display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
      padding: '10px 12px', borderBottom: '1px solid var(--border)',
    }}>
      <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.3, color: 'var(--text-primary)' }}>
        {pt ? 'Conteúdo' : 'Contents'}
      </span>
      {artifacts.length > 0 && (
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
          {artifacts.length} {pt ? (artifacts.length === 1 ? 'arquivo' : 'arquivos') : (artifacts.length === 1 ? 'file' : 'files')}
          {created > 0 && ` · ${created} ${pt ? (created === 1 ? 'novo' : 'novos') : 'new'}`}
        </span>
      )}
      <button
        onClick={onClose}
        aria-label={pt ? 'Fechar artefatos' : 'Close artifacts'}
        title={pt ? 'Fechar o painel' : 'Close the panel'}
        style={{
          marginLeft: 'auto', display: 'flex', width: 26, height: 26, borderRadius: 7,
          alignItems: 'center', justifyContent: 'center', border: 'none',
          background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer',
        }}
      >
        <PanelRightClose size={15} />
      </button>
    </header>
  )

  /** The three tabs. A count rides each one, so the panel says what is behind a tab unopened. */
  const tabs: { id: TabId; label: string; icon: React.ReactNode; count: number }[] = [
    { id: 'files', label: pt ? 'Arquivos' : 'Files', icon: <Files size={12} />, count: artifacts.length },
    { id: 'docs', label: pt ? 'Docs' : 'Docs', icon: <BookOpen size={12} />, count: docs.length },
    { id: 'live', label: 'Live', icon: <Activity size={12} />, count: feed.length },
    {
      id: 'gallery',
      label: pt ? 'Galeria' : 'Gallery',
      icon: <Image size={12} />,
      count: galleryFiles,
    },
    // The count is 0 until the tab is opened, and that is honest rather than lazy: the panel has
    // not asked the host yet, and a number it has not measured is the thing this codebase refuses
    // to print everywhere else.
    { id: 'skills', label: 'Skills', icon: <Sparkles size={12} />, count: skills?.length ?? 0 },
  ]

  const tabBar = (
    <div role="tablist" style={{
      display: 'flex', gap: 2, padding: '6px 8px', flexShrink: 0,
      borderBottom: '1px solid var(--border)',
    }}>
      {tabs.map(t => {
        const on = tab === t.id
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={on}
            onClick={() => setTab(t.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 5, padding: '4px 9px',
              borderRadius: 7, border: 'none', cursor: 'pointer', fontFamily: 'inherit',
              fontSize: 11.5, fontWeight: on ? 700 : 500,
              background: on ? 'var(--bg-elevated)' : 'transparent',
              color: on ? 'var(--text-primary)' : 'var(--text-tertiary)',
            }}
          >
            {t.icon}
            {t.label}
            {t.count > 0 && (
              <span style={{ fontSize: 10, opacity: 0.7, fontVariantNumeric: 'tabular-nums' }}>{t.count}</span>
            )}
          </button>
        )
      })}
    </div>
  )

  const liveBody = (): React.ReactNode => {
    if (feed.length === 0) {
      return <Note text={pt
        ? 'Nada aconteceu nesta conversa ainda.'
        : 'Nothing has happened in this conversation yet.'} />
    }
    return (
      <div ref={feedRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 6px 10px' }}>
        {/* THE DIRECTION, said rather than inferred. A reader arriving at a scrolled list cannot
            tell which end is the newest, and asked exactly that. It sits at the TOP because that is
            the end somebody scrolls away from — the bottom explains itself by being where the view
            lands. */}
        <p style={{
          margin: '0 8px 6px', fontSize: 10, lineHeight: 1.5, color: 'var(--text-tertiary)',
          borderBottom: '1px solid var(--border-subtle)', paddingBottom: 6,
        }}>
          {pt
            ? 'Mais antigo em cima · o mais recente fica embaixo, e a view acompanha.'
            : 'Oldest at the top · the newest stays at the bottom, and the view follows it.'}
        </p>
        {feed.map((e, i) => (
          <EventRow
            key={i} e={e} pt={pt} now={now}
            // A WROTE row is a link to the file it names. Only when that file is actually in the
            // Files list: the feed shows every write the transcript recorded, while Files shows the
            // ones still readable on disk, and offering to open a deleted file would be a row whose
            // only outcome is a refusal.
            {...(openFromFeed(e.text) ? { onOpen: () => openFromFeed(e.text)!() } : {})}
            {...(e.kind === 'wrote'
              ? { status: writeStatus(e.text, new Set(artifacts.map(a => a.path))) }
              : {})}
          />
        ))}
      </div>
    )
  }

  /**
   * Clicking a written path in the feed takes you to the file — the Files tab, with it open.
   *
   * Returns null when the path is not in the list, and the row is then plain text rather than a
   * dead link: the feed records every write the transcript saw, while Files holds the ones still
   * readable, and a link whose only outcome is a refusal is the control-that-reads-as-broken this
   * codebase argues against everywhere else.
   */
  const openFromFeed = (path: string): (() => void) | null => {
    const hit = artifacts.find(a => a.path === path)
    if (!hit) return null
    return () => { setTab('files'); setOpen(hit) }
  }

  const fileList = (list: readonly Artifact[], emptyText: string): React.ReactNode => {
    if (list.length === 0) return <Note text={emptyText} />
    const liveOnes = list.filter(a => a.live)
    const pastOnes = list.filter(a => !a.live)
    return (
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 6px 10px' }}>
        {liveOnes.length > 0 && (
          <Band label={pt ? 'agora' : 'now'}>
            {liveOnes.map(a => <Row key={a.path} a={a} pt={pt} fact={facts?.get(a.path)} onOpen={() => setOpen(a)} />)}
          </Band>
        )}
        {pastOnes.length > 0 && (
          <Band label={liveOnes.length > 0 ? (pt ? 'antes' : 'earlier') : undefined}>
            {pastOnes.map(a => <Row key={a.path} a={a} pt={pt} fact={facts?.get(a.path)} onOpen={() => setOpen(a)} />)}
          </Band>
        )}
        {unlistedWrites && (
          <p style={{ margin: '6px 8px 0', fontSize: 10.5, lineHeight: 1.5, color: 'var(--text-tertiary)' }}>
            {pt
              ? 'A sessão também escreveu por comandos cujos caminhos não dá para ler; esses arquivos não estão nesta lista.'
              : 'The session also wrote through commands whose paths cannot be read; those files are not in this list.'}
          </p>
        )}
      </div>
    )
  }

  /**
   * The SKILLS this session can invoke.
   *
   * A reference list, not a launcher: invoking one is typing `/name`, which the composer's own
   * picker already does with the draft in front of you. Putting a run button here would be a second
   * way to send something into a session, and the two would disagree the first time one of them
   * learned about arguments.
   *
   * THREE STATES, three sentences: not read yet, none installed, and the host's own reason when it
   * has one (a harness that has no skills at all says so through the route).
   */
  const skillsBody = () => {
    // THE DETAIL IS A SCREEN, not a modal: the panel is already a narrow column, and a dialog over
    // a column that width covers the thing it is about. `esc` and a back row return to the list.
    if (openSkill !== null) {
      const sk = (skills ?? []).find(x => x.name === openSkill)
      return (
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
            padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)',
          }}>
            <button
              onClick={() => setOpenSkill(null)}
              style={{
                display: 'flex', alignItems: 'center', gap: 5, minHeight: 28, padding: '0 8px',
                borderRadius: 7, border: '1px solid var(--border-subtle)', background: 'transparent',
                color: 'var(--text-secondary)', fontFamily: 'inherit', fontSize: 11.5, cursor: 'pointer',
              }}
            >
              <ChevronLeft size={13} />{pt ? 'Skills' : 'Skills'}
            </button>
            <span style={{
              minWidth: 0, flex: 1, fontSize: 12, fontWeight: 650, color: 'var(--text-primary)',
              fontFamily: 'var(--font-mono, ui-monospace, monospace)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>/{openSkill}</span>
            {/* INVOKE puts the line in the composer; it never sends. What reaches a session is
                what the person pressed enter on — see `composerStore.ts`. */}
            <button
              onClick={() => requestDraft(sessionId, skillInvocation({ name: openSkill, description: '' }))}
              title={pt ? 'Coloca /nome na caixa de mensagem' : 'Puts /name in the message box'}
              style={{
                display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0,
                minHeight: 28, padding: '0 10px', borderRadius: 7, cursor: 'pointer',
                border: '1px solid var(--anthropic-orange)',
                background: 'var(--anthropic-orange-dim)', color: 'var(--anthropic-orange)',
                fontFamily: 'inherit', fontSize: 11.5, fontWeight: 650,
              }}
            >
              <Sparkles size={12} />{pt ? 'Usar esta skill' : 'Use this skill'}
            </button>
          </div>
          <div style={{ padding: '10px 12px', overflowY: 'auto', minHeight: 0, flex: 1 }}>
            {sk?.description && (
              <p style={{ margin: '0 0 10px', fontSize: 11.5, lineHeight: 1.55, color: 'var(--text-secondary)' }}>
                {sk.description}
              </p>
            )}
            {skillBody === null ? (
              <Note icon={<Loader size={13} className="ag-working-spin" />}
                text={pt ? 'Lendo a skill…' : 'Reading the skill…'} />
            ) : !skillBody.ok ? (
              <Note text={skillBody.message} />
            ) : (
              <>
                {/* TWO READINGS OF ONE FILE, and both are wanted: a SKILL.md is written to be read
                    (headings, lists, tables) and is also a file whose exact bytes matter when you
                    are about to run it. Formatted by default, source one click away, and the
                    choice is remembered. */}
                <div role="tablist" style={{
                  display: 'flex', gap: 2, padding: 2, marginBottom: 8, borderRadius: 8,
                  background: 'var(--bg-base)', border: '1px solid var(--border-subtle)',
                  width: 'fit-content',
                }}>
                  {([['md', pt ? 'Formatado' : 'Formatted'], ['text', pt ? 'Texto' : 'Text']] as const)
                    .map(([id, label]) => (
                      <button
                        key={id}
                        role="tab"
                        aria-selected={skillFormat === id}
                        onClick={() => chooseSkillFormat(id)}
                        style={{
                          minHeight: isMobile ? 44 : 24, padding: '0 10px', borderRadius: 6,
                          border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11,
                          background: skillFormat === id ? 'var(--bg-elevated)' : 'transparent',
                          color: skillFormat === id ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
                          fontWeight: skillFormat === id ? 650 : 400,
                        }}
                      >{label}</button>
                    ))}
                </div>
                {skillFormat === 'md' ? (
                  <div className="ag-chat-md" style={{
                    fontSize: 12, lineHeight: 1.6, color: 'var(--text-secondary)',
                    overflowWrap: 'anywhere',
                  }}>
                    {/* The FRONTMATTER is not prose and markdown does not know that: rendered, its
                        `---` becomes a rule and `name:`/`description:` become a paragraph that
                        reads like the skill's first sentence. It is shown as the header it is. */}
                    {(() => {
                      const { front, body } = splitFrontmatter(skillBody.text)
                      return (
                        <>
                          {front !== '' && (
                            <pre style={{
                              margin: '0 0 10px', padding: '8px 10px', borderRadius: 8,
                              background: 'var(--bg-base)', border: '1px solid var(--border-subtle)',
                              fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                              fontSize: 10.5, lineHeight: 1.55, color: 'var(--text-tertiary)',
                              whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
                            }}>{front}</pre>
                          )}
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
                        </>
                      )
                    })()}
                  </div>
                ) : (
                  <pre style={{
                    margin: 0, padding: '10px 12px', borderRadius: 9, overflowX: 'auto',
                    background: 'var(--bg-base)', border: '1px solid var(--border-subtle)',
                    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                    fontSize: 11, lineHeight: 1.6, color: 'var(--text-secondary)',
                    whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
                  }}>{skillBody.text}</pre>
                )}
                {skillBody.truncated && (
                  <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--text-tertiary)' }}>
                    {pt
                      ? 'Mostrando só o começo — o arquivo é grande.'
                      : 'Showing the beginning only — the file is large.'}
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      )
    }

    return (
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
        {skills !== null && skills.length > 0 && (
          <div style={{ padding: '8px 12px', flexShrink: 0 }}>
            <input
              value={skillQuery}
              onChange={e => setSkillQuery(e.target.value)}
              placeholder={pt ? 'Buscar skill…' : 'Search skills…'}
              aria-label={pt ? 'Buscar skill' : 'Search skills'}
              style={{
                width: '100%', boxSizing: 'border-box', minHeight: 30, padding: '0 10px',
                borderRadius: 8, border: '1px solid var(--border-subtle)',
                background: 'var(--bg-base)', color: 'var(--text-primary)',
                fontFamily: 'inherit',
                // 16px on a phone or iOS Safari zooms the viewport — the repo's own rule.
                fontSize: isMobile ? 16 : 12,
              }}
            />
          </div>
        )}
        <div style={{ padding: '0 12px 10px', overflowY: 'auto', minHeight: 0, flex: 1 }}>
          {skills === null ? (
            <Note text={pt ? 'Lendo as skills desta sessão…' : 'Reading this session’s skills…'} />
          ) : skills.length === 0 ? (
            <Note text={skillsNote ?? (pt
              ? 'Nenhuma skill instalada para esta sessão.'
              : 'No skills installed for this session.')} />
          ) : countSkills(skillGroups) === 0 ? (
            // The list is not empty — the SEARCH emptied it, and those are different sentences.
            <Note text={pt
              ? `Nenhuma skill encontrada para “${skillQuery.trim()}”.`
              : `No skill matches “${skillQuery.trim()}”.`} />
          ) : (
            <>
              {skillsNote && (
                <p style={{ margin: '0 0 8px', fontSize: 11, lineHeight: 1.5, color: 'var(--text-tertiary)' }}>
                  {skillsNote}
                </p>
              )}
              {skillGroups.map(group => (
                <Band key={group.key || '_own'} label={`${group.label} · ${group.skills.length}`}>
                  {group.skills.map(sk => (
                    <button
                      key={sk.name}
                      onClick={() => setOpenSkill(sk.name)}
                      style={{
                        display: 'block', width: '100%', textAlign: 'left',
                        padding: '8px 10px', marginBottom: 6, borderRadius: 9, cursor: 'pointer',
                        background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
                        fontFamily: 'inherit',
                      }}
                    >
                      <span style={{
                        display: 'block', fontSize: 12, fontWeight: 650, color: 'var(--text-primary)',
                        fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                      }}>/{shortName(sk)}</span>
                      {sk.description && (
                        <span style={{
                          display: 'block', marginTop: 3, fontSize: 11, lineHeight: 1.5,
                          color: 'var(--text-tertiary)',
                        }}>{sk.description}</span>
                      )}
                    </button>
                  ))}
                </Band>
              ))}
            </>
          )}
        </div>
      </div>
    )
  }

  /**
   * The gallery, or the reason it is not showing one.
   *
   * "The conversation has not loaded" and "nothing was ever sent" are different facts and get
   * different sentences — the same rule the other three tabs follow. The empty one is `GalleryTab`'s
   * own, because it is a statement about the gallery rather than about this panel.
   */
  const galleryBody = (): React.ReactNode => {
    if (loading && (turns?.length ?? 0) === 0) {
      return (
        <Note icon={<Loader size={13} className="ag-working-spin" />}
          text={pt ? 'Lendo a conversa…' : 'Reading the conversation…'} />
      )
    }
    return (
      <GalleryTab
        sessionId={sessionId}
        groups={gallery}
        lang={lang}
        view={galleryView}
        onViewChange={chooseGalleryView}
        scope={galleryScope}
        onScopeChange={chooseGalleryScope}
      />
    )
  }

  const body = (): React.ReactNode => {
    // The refusal outranks everything: there is no list to be empty when the conversation cannot be
    // read at all.
    if (unavailable) return <Note text={unavailable} />
    if (loading && artifacts.length === 0) {
      return (
        <Note icon={<Loader size={13} className="ag-working-spin" />}
          text={pt ? 'Lendo a conversa…' : 'Reading the conversation…'} />
      )
    }
    if (artifacts.length === 0) {
      // The two empty answers are NOT the same. One is a fact about the session's work; the other
      // is a limit of this reader, and saying the first when the second is true is the confident
      // wrong answer this panel was reported for.
      return unlistedWrites ? (
        <Note text={pt
          ? 'Esta sessão escreveu por comandos de shell cujos caminhos não dá para ler da linha de comando — um interpretador alimentado por heredoc, por exemplo. Os arquivos existem; esta lista não consegue nomeá-los.'
          : 'This session wrote through shell commands whose paths cannot be read from the command line — an interpreter fed a heredoc, for instance. The files exist; this list cannot name them.'} />
      ) : (
        <Note text={pt
          ? 'Nada escrito ainda nesta sessão. Arquivos aparecem aqui assim que a sessão escreve ou edita um.'
          : 'Nothing written in this session yet. Files appear here as soon as the session writes or edits one.'} />
      )
    }
    return tab === 'docs'
      ? fileList(docs, pt
          ? 'Nenhum documento escrito nesta sessão DENTRO da pasta dela. Arquivos .md, .txt e afins aparecem aqui — mas só os que ficam na pasta da sessão: um arquivo escrito fora dela não pode ser lido daqui, e por isso não é listado.'
          : 'No document written in this session INSIDE its folder. Files like .md and .txt appear here — but only those inside the session\'s folder: a file written outside it cannot be read from here, so it is not listed.')
      : fileList(artifacts, pt
          ? 'Nada escrito ainda nesta sessão. Arquivos aparecem aqui assim que a sessão escreve ou edita um.'
          : 'Nothing written in this session yet. Files appear here as soon as the session writes or edits one.')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, minWidth: 0 }}>
      {open ? (
        <ArtifactDoc sessionId={sessionId} artifact={open} lang={lang} onBack={() => setOpen(null)} />
      ) : (
        <>
          {header}
          {/* The tab bar is BELOW the header, so the close button keeps one place whatever tab is
              open — a control that moves with the content is one people stop finding. */}
          {!unavailable && tabBar}
          {/* The REFUSAL outranks every tab: there is no list, feed or gallery to be empty when
              the conversation cannot be read at all, and `body()` is where that one sentence
              lives. */}
          {unavailable ? body()
            : tab === 'live' ? liveBody()
            : tab === 'gallery' ? galleryBody()
            : tab === 'skills' ? skillsBody()
            : body()}
        </>
      )}
    </div>
  )
}

function Band({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 8 }}>
      {label && (
        <p style={{
          margin: '4px 6px 4px', fontSize: 9.5, fontWeight: 700, letterSpacing: 0.5,
          textTransform: 'uppercase', color: 'var(--text-tertiary)',
        }}>{label}</p>
      )}
      {children}
    </div>
  )
}

/** A size a person reads. Two figures is all "how big is this" needs. */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function Row({ a, pt, fact, onOpen }: {
  a: Artifact; pt: boolean
  fact?: { bytes: number; scope: 'project' | 'temp' }
  onOpen: () => void
}) {
  return (
    <button
      onClick={onOpen}
      title={a.path}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 8, width: '100%', textAlign: 'left',
        padding: '7px 8px', borderRadius: 8, border: 'none', background: 'transparent',
        cursor: 'pointer', fontFamily: 'inherit', minWidth: 0,
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-elevated)' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
    >
      <span style={{ paddingTop: 2 }}><KindIcon kind={a.kind} /></span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{
          display: 'block', fontSize: 12.5, color: 'var(--text-primary)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{a.name}</span>
        <span style={{
          display: 'block', fontSize: 10.5, color: 'var(--text-tertiary)', direction: 'rtl',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{a.dir}</span>
        {/* The live row says what it is DOING; the others say how much they were touched, and only
            when it was more than once — "1 edit" is noise on every row that has one. */}
        {/* THE FACTS, on one line: how big, how many times it was touched, and whether it is the
            project's or scratch. The scope is said only for TEMP — everything else is the project,
            and a badge on every row would be noise on the common case. */}
        <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, fontSize: 10.5, color: 'var(--text-tertiary)' }}>
          {a.live && (
            <span style={{ color: 'var(--anthropic-orange)' }}>{pt ? 'escrevendo…' : 'writing…'}</span>
          )}
          {fact && <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtBytes(fact.bytes)}</span>}
          {a.touches > 1 && <span>{a.touches} {pt ? 'edições' : 'edits'}</span>}
          {fact?.scope === 'temp' && (
            <span style={{
              padding: '0 5px', borderRadius: 4, fontSize: 9.5, fontWeight: 700, letterSpacing: 0.3,
              background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
            }}>{pt ? 'temporário' : 'temp'}</span>
          )}
        </span>
      </span>
    </button>
  )
}

/**
 * One line of the live feed.
 *
 * The KIND leads, as a glyph and a colour, because "read a file" and "ran a command" are different
 * events and a grey list of strings is a log rather than a view. The text is monospaced for the
 * three kinds that carry a path or a command — those are read character by character — and left in
 * the reading face for the two that carry prose.
 */
function EventRow({ e, pt, now, onOpen, status }: {
  e: LiveEvent; pt: boolean; now: number; onOpen?: () => void; status?: WriteStatus
}) {
  const meta: Record<LiveEvent['kind'], { icon: React.ReactNode; color: string; label: string }> = {
    wrote: { icon: <FileEdit size={11} />, color: 'var(--anthropic-orange)', label: pt ? 'escreveu' : 'wrote' },
    read: { icon: <Eye size={11} />, color: 'var(--text-tertiary)', label: pt ? 'leu' : 'read' },
    ran: { icon: <Terminal size={11} />, color: 'var(--text-secondary)', label: pt ? 'rodou' : 'ran' },
    thought: { icon: <Brain size={11} />, color: '#a78bfa', label: pt ? 'pensou' : 'thought' },
    delegated: { icon: <Send size={11} />, color: '#22c55e', label: pt ? 'delegou' : 'delegated' },
  }
  const m = meta[e.kind]
  const mono = e.kind === 'wrote' || e.kind === 'read' || e.kind === 'ran'
  const Tag = onOpen ? 'button' : 'div'
  return (
    <Tag
      {...(onOpen ? { onClick: onOpen, title: e.text } : {})}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 7, padding: '5px 8px',
        opacity: e.live ? 1 : 0.92,
        width: '100%', textAlign: 'left', border: 'none', background: 'transparent',
        borderRadius: 7, fontFamily: 'inherit',
        cursor: onOpen ? 'pointer' : 'default',
      }}
      {...(onOpen ? {
        onMouseEnter: (ev: React.MouseEvent<HTMLElement>) => { ev.currentTarget.style.background = 'var(--bg-elevated)' },
        onMouseLeave: (ev: React.MouseEvent<HTMLElement>) => { ev.currentTarget.style.background = 'transparent' },
      } : {})}
    >
      <span style={{ color: m.color, paddingTop: 2, flexShrink: 0 }}>{m.icon}</span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{
          fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase',
          color: m.color, marginRight: 6,
        }}>{m.label}</span>
        <span style={{
          fontSize: 11.5, color: 'var(--text-secondary)', wordBreak: 'break-word',
          fontFamily: mono ? 'var(--font-mono, ui-monospace, monospace)' : 'inherit',
        }}>{e.text}</span>
        {/* WHY this path is not a link. Without it one row opens and its neighbour does nothing,
            with no way to tell which is which — and "it is scratch" and "it is gone" send a reader
            to two different conclusions about their own work. */}
        {status === 'temp' && (
          <span style={{
            marginLeft: 6, padding: '0 5px', borderRadius: 4, fontSize: 9,
            fontWeight: 700, letterSpacing: 0.3, color: 'var(--text-tertiary)',
            background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
          }}>{pt ? 'temporário' : 'temp'}</span>
        )}
        {status === 'gone' && (
          <span style={{
            marginLeft: 6, padding: '0 5px', borderRadius: 4, fontSize: 9,
            fontWeight: 700, letterSpacing: 0.3, color: 'var(--text-tertiary)',
            background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
          }}>{pt ? 'não está mais lá' : 'no longer there'}</span>
        )}
      </span>
      {/* HOW LONG AGO, right-aligned, so the column reads as a timeline down the edge. Absent when
          the transcript recorded no time — nothing here is invented. */}
      {agoLabel(e.at, now, pt) !== '' && (
        <span style={{
          flexShrink: 0, fontSize: 10, color: 'var(--text-tertiary)',
          fontVariantNumeric: 'tabular-nums', paddingTop: 2,
        }}>{agoLabel(e.at, now, pt)}</span>
      )}
    </Tag>
  )
}

function Note({ text, icon }: { text: string; icon?: React.ReactNode }) {
  return (
    <div style={{
      flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '20px 18px',
    }}>
      <p style={{
        margin: 0, fontSize: 12, lineHeight: 1.6, textAlign: 'center',
        color: 'var(--text-tertiary)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
      }}>
        {icon}
        {text}
      </p>
    </div>
  )
}
