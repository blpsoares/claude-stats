import React, { useState, useMemo, useEffect, useRef, useReducer, lazy, Suspense, useSyncExternalStore } from 'react'
import type { SessionMeta } from '@agentistics/core'
import { sessionTime } from '../lib/sessionTime'
import { formatProjectName, repoShortName, sessionLabel, sessionTokenTotal } from '@agentistics/core'
import type { SessionActivity } from '../lib/sessionNotifications'
import type { FleetActionId, FleetRow, FleetVerb } from '../lib/fleet'
import { primaryAction, isWatchable, type PrimaryAction } from '../lib/sessionActions'
import { SessionActionsMenu, SessionActionsPanel, useSessionActionsController } from './SessionActions'
import { useTerminalStream } from '../hooks/useTerminalStream'
import { useTerminalWrite } from '../hooks/useTerminalWrite'
import { terminalStatus, type TerminalTone } from '../lib/terminalStream'
import {
  INITIAL_COMPOSER,
  canSubmit,
  composerReducer,
  interactionBlock,
} from '../lib/terminalInput'
import { operatorId, recordPromptSend, resolveAuthor } from '../lib/promptAudit'
import { getTerminalZoom, setTerminalZoom, subscribeTerminalZoom, ZOOM_STEP, ZOOM_MIN, ZOOM_MAX } from '../lib/terminalZoom'
import { getPinnedIds, isSessionPinned, togglePinnedSession, subscribePinnedSessions, pinnedServerSnapshot, MAX_PINNED } from '../lib/pinnedSessions'
import { getOpenModalSession, setOpenModalSession, subscribeOpenModalSession } from '../lib/openModalSession'
import { useIsMobile } from '../hooks/useIsMobile'
import { encodeProjectDir } from '../lib/sessionTranscript'
import { resumeCommand } from '../lib/resumeCommand'
import { HARNESS_LABELS, HARNESS_COLORS } from '../lib/harness'
import { format, parseISO } from 'date-fns'
import { OVERLAY_TOP } from '../lib/mobileOverlay'
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  Terminal,
  Check,
  Copy,
  ChevronsRight,
  Search,
  Clock,
  Wrench,
  FileCode,
  GitCommit,
  LayoutGrid,
  List,
  Layers,
  ChevronDown,
  ChevronUp,
  Folder,
  Radio,
  Tag,
  Bookmark,
  Bot,
  ArrowUpDown,
  Filter,
  Maximize2,
  Eye,
  Send,
  RotateCcw,
  Hand,
  Keyboard,
  ZoomIn,
  ZoomOut,
  Pin,
  PinOff,
  X,
} from 'lucide-react'

/** The lazy terminal chunk: xterm's weight lands here, downloaded only when a card is expanded to
 *  watch a live session — never on the initial dashboard load. */
const SessionTerminal = lazy(() => import('./SessionTerminal'))

// Types

interface Props {
  sessions: SessionMeta[]
  lang: 'pt' | 'en'
  onSelect?: (session: SessionMeta) => void
  /** session_ids to pin to the top of the list (e.g. live/open sessions), regardless of sort. */
  pinnedIds?: Set<string>
  /** What each LIVE session is doing right now, from `/api/live-sessions`. A session absent here
   *  has no observable state — the row says so rather than claiming one. */
  activities?: Record<string, SessionActivity>
  viewMode?: 'list' | 'grid'
  onViewModeChange?: (mode: 'list' | 'grid') => void
  /**
   * The LIVE fleet, keyed by the stored session id it is driving — see `lib/fleet.ts`.
   *
   * Optional, and its absence is what makes this component reusable outside the Sessions page: the
   * repo, project and custom-layout surfaces render the same rows as HISTORY and have no business
   * offering to kill anything. A row with no fleet entry simply draws no action bar; it is never
   * given a disabled one, because "agentop does not host this conversation" is a different fact
   * from "this page did not ask".
   */
  fleet?: Map<string, FleetRow>
  onFleetAction?: (req: { id: string; action: FleetActionId; text?: string; choice?: number })
    => Promise<{ ok: boolean; message: string; id?: string }>
  /** Dashboard theme — the live terminal's palette follows it. Only the Sessions page needs it. */
  theme?: 'dark' | 'light'
  /** Initial grouping. Defaults to 'project' for the history surfaces; the Sessions page opens on
   *  'repo'. */
  defaultGrouping?: SessionGrouping
  /** Initial status shortcut. Defaults to 'all'; the Sessions page opens on 'active' so a machine's
   *  live work is what you see first, without a click. */
  defaultStatus?: StatusShortcut
  title?: React.ReactNode
  subtitle?: React.ReactNode
  topActions?: React.ReactNode
  /** Who a write-channel send is attributed to in the audit — the IAM display name where the
   *  dashboard has a login, else the browser's own operator id (resolved in `promptAudit`). */
  authorName?: string
}

/** `task` is deliberately absent: a task is a fact of the agentop session registry, not of a
 *  stored `SessionMeta`, so a "group by task" here could only ever produce one "no task" band. */
export type SessionGrouping = 'none' | 'status' | 'repo' | 'project' | 'harness' | 'model' | 'marked'

const STATUS_BUCKETS: Record<SessionActivity, { label: string; color: string }> = {
  'waiting-approval': { label: 'Aguardando aprovação', color: '#ef4444' },
  waiting: { label: 'Aguardando resposta', color: '#f59e0b' },
  working: { label: 'Trabalhando', color: '#22c55e' },
  exited: { label: 'Encerradas / Histórico', color: 'var(--text-tertiary)' },
}
export type StatusShortcut = 'all' | 'active' | 'waiting' | 'closed'
export type SortKey = 'date' | 'status' | 'tokens' | 'messages' | 'tools' | 'files' | 'name'
export type SortDir = 'asc' | 'desc'

// Translations

const T = {
  pt: {
    group_by: 'Agrupar por:',
    group_none: 'Nenhum',
    group_status: 'Status',
    group_repo: 'Repositório',
    group_project: 'Projeto',
    group_task: 'Tarefa',
    group_harness: 'Harness',
    group_model: 'Modelo',
    group_marked: 'Marcadas',

    shortcut_all: 'Todas',
    shortcut_active: 'Ativas',
    shortcut_waiting: 'Aguardando',
    shortcut_closed: 'Encerradas',

    sort_date: 'Data',
    sort_status: 'Status',
    sort_tokens: 'Tokens',
    sort_messages: 'Mensagens',
    sort_tools: 'Tools',
    sort_files: 'Arquivos',
    sort_name: 'Nome',

    filters: 'Filtros',
    search_placeholder: 'Buscar sessão...',
    showing: 'Exibindo',
    of: 'de',
    per_page: 'por página',
    no_results: 'Nenhuma sessão encontrada',
    page: 'Página',
    sessions_unit: 'sessões',
    details_btn: 'Detalhes da sessão',
  },
  en: {
    group_by: 'Group by:',
    group_none: 'None',
    group_status: 'Status',
    group_repo: 'Repo',
    group_project: 'Project',
    group_task: 'Task',
    group_harness: 'Harness',
    group_model: 'Model',
    group_marked: 'Marked',

    shortcut_all: 'All',
    shortcut_active: 'Active',
    shortcut_waiting: 'Waiting',
    shortcut_closed: 'Closed',

    sort_date: 'Date',
    sort_status: 'Status',
    sort_tokens: 'Tokens',
    sort_messages: 'Messages',
    sort_tools: 'Tools',
    sort_files: 'Files',
    sort_name: 'Name',

    filters: 'Filters',
    search_placeholder: 'Search session...',
    showing: 'Showing',
    of: 'of',
    per_page: 'per page',
    no_results: 'No sessions found',
    page: 'Page',
    sessions_unit: 'sessions',
    details_btn: 'Session details',
  },
}

// Helpers

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

function totalTokens(s: SessionMeta): number {
  // All four billed counters — `input + output` alone is a fraction of a percent of the volume.
  return sessionTokenTotal(s)
}

function totalMessages(s: SessionMeta): number {
  return (s.user_message_count || 0) + (s.assistant_message_count || 0)
}

function totalTools(s: SessionMeta): number {
  return Object.values(s.tool_counts ?? {}).reduce((a, b) => a + b, 0)
}

function truncate(str: string, max: number): string {
  if (!str) return ''
  return str.length <= max ? str : str.slice(0, max) + '…'
}

/** The state is the live poll's, never the session record's — a stored session has none, and a
 *  pinned row is only known to be OPEN, which is why it falls back to "working". */
function getStatusInfo(state?: SessionActivity, isPinned?: boolean): { color: string; labelPt: string; labelEn: string } {
  if (state === 'waiting-approval') {
    return { color: '#ef4444', labelPt: 'precisa de aprovação', labelEn: 'needs approval' }
  }
  if (state === 'waiting') {
    return { color: '#f59e0b', labelPt: 'aguardando resposta', labelEn: 'waiting input' }
  }
  if (state === 'working' || isPinned) {
    return { color: '#22c55e', labelPt: 'trabalhando', labelEn: 'working' }
  }
  return { color: 'rgba(156, 163, 175, 0.5)', labelPt: 'encerrada', labelEn: 'closed' }
}

// Sub-components

function Chip({
  icon,
  label,
  color = 'var(--text-tertiary)',
  title,
}: {
  icon: React.ReactNode
  label: string
  color?: string
  title?: string
}) {
  return (
    <div
      title={title}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 3,
        fontSize: 10,
        color,
        fontWeight: 500,
        cursor: title ? 'help' : undefined,
      }}
    >
      {icon}
      {label}
    </div>
  )
}

function HarnessBadge({ harness }: { harness?: string }) {
  if (!harness) return null
  const h = harness.toLowerCase()
  const color = (HARNESS_COLORS as Record<string, string>)[h] ?? '#888'
  const label = (HARNESS_LABELS as Record<string, string>)[h] ?? harness
  return (
    <span
      title={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 6px',
        borderRadius: 4,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: 0.3,
        lineHeight: 1.4,
        background: `${color}18`,
        color,
        border: `1px solid ${color}44`,
        flexShrink: 0,
        textTransform: 'uppercase',
      }}
    >
      {label}
    </span>
  )
}

function SourceDot({ source }: { source?: 'meta' | 'jsonl' | 'subdir' }) {
  if (!source) return null
  const colors: Record<string, string> = {
    meta: 'var(--anthropic-orange, #e8690b)',
    jsonl: 'var(--accent-blue, #3b82f6)',
    subdir: 'var(--accent-purple, #a855f7)',
  }
  const color = colors[source] ?? 'var(--text-tertiary)'
  return (
    <span
      title={source}
      style={{
        display: 'inline-block',
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: color,
        flexShrink: 0,
        marginTop: 1,
      }}
    />
  )
}

function PillButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '4px 10px',
        borderRadius: 999,
        border: active
          ? '1px solid var(--anthropic-orange, #e8690b)'
          : '1px solid var(--border-subtle)',
        background: active ? 'rgba(232,105,11,0.12)' : 'transparent',
        color: active ? 'var(--anthropic-orange, #e8690b)' : 'var(--text-secondary)',
        fontSize: 11,
        fontWeight: active ? 600 : 400,
        cursor: 'pointer',
        transition: 'all 0.15s',
        lineHeight: 1.4,
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </button>
  )
}

function IconButton({
  onClick,
  disabled,
  title,
  children,
}: {
  onClick: () => void
  disabled?: boolean
  title?: string
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        borderRadius: 6,
        border: '1px solid var(--border-subtle)',
        background: 'transparent',
        color: disabled ? 'var(--text-tertiary)' : 'var(--text-secondary)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        transition: 'all 0.15s',
        padding: 0,
      }}
    >
      {children}
    </button>
  )
}

function isNayChatSession(projectPath: string): boolean {
  return projectPath.includes('.agentistics/nay-chat')
}

function openSession(s: SessionMeta, e: React.MouseEvent) {
  e.stopPropagation()
  if (isNayChatSession(s.project_path)) {
    window.dispatchEvent(new CustomEvent('agentistics:open-nay-chat', {
      detail: { sessionId: s.session_id },
    }))
  } else {
    const harness = s.harness ?? 'claude'
    const encodedDir = encodeProjectDir(s.project_path)
    window.dispatchEvent(new CustomEvent('agentistics:open-transcript', {
      detail: {
        harness,
        sessionId: s.session_id,
        project: { path: s.project_path, name: s.project_path.split('/').pop() ?? s.project_path, encodedDir },
      },
    }))
  }
}

// Grouping Helper: extracts bucket key for a session
function getSessionBucketKey(
  s: SessionMeta,
  groupBy: SessionGrouping,
  pinnedIds?: Set<string>,
  activities?: Record<string, SessionActivity>,
): { key: string; label: string; icon: React.ReactNode } {
  const isPinned = pinnedIds?.has(s.session_id)
  switch (groupBy) {
    case 'status': {
      // The state comes from the live poll, never from the session record — a stored session
      // carries no state, and grouping every one of them under "working" would be an invention.
      const st = activities?.[s.session_id]
      if (st) {
        const info = STATUS_BUCKETS[st]
        return { key: st, label: info.label, icon: <Radio size={13} style={{ color: info.color }} /> }
      }
      if (isPinned) return { key: 'working', label: 'Em Execução / Ativa', icon: <Radio size={13} style={{ color: '#22c55e' }} /> }
      return { key: 'closed', label: 'Encerradas / Histórico', icon: <Radio size={13} style={{ color: 'var(--text-tertiary)' }} /> }
    }
    case 'repo': {
      // A repo is keyed by its normalized git remote — never by a path segment, which splits the
      // same repository across machines and worktrees.
      const remote = s.git_remote ? repoShortName(s.git_remote) : ''
      const repo = remote || 'Sem repositório'
      return { key: repo, label: repo, icon: <GitCommit size={13} style={{ color: 'var(--accent-purple, #a855f7)' }} /> }
    }
    case 'project': {
      const proj = s.project_path ? formatProjectName(s.project_path) : 'Sem projeto'
      return { key: proj, label: proj, icon: <Folder size={13} style={{ color: 'var(--anthropic-orange)' }} /> }
    }
    case 'harness': {
      const h = s.harness || 'claude'
      const label = (HARNESS_LABELS as Record<string, string>)[h] ?? h
      return { key: h, label, icon: <Bot size={13} style={{ color: (HARNESS_COLORS as Record<string, string>)[h] || 'var(--text-primary)' }} /> }
    }
    case 'model': {
      const model = s.model || 'Sem modelo definido'
      return { key: model, label: model, icon: <Tag size={13} style={{ color: 'var(--accent-blue, #3b82f6)' }} /> }
    }
    case 'marked': {
      if (isPinned) return { key: 'marked', label: 'Marcadas / Live Sessions', icon: <Bookmark size={13} style={{ color: 'var(--anthropic-orange)' }} /> }
      return { key: 'unmarked', label: 'Outras Sessões', icon: <Bookmark size={13} style={{ color: 'var(--text-tertiary)' }} /> }
    }
    default:
      return { key: 'all', label: 'Todas as Sessões', icon: <Layers size={13} /> }
  }
}

const PAGE_SIZE_OPTIONS = [5, 10, 20, 50]

export function RecentSessions({ sessions, lang, onSelect, pinnedIds, activities, viewMode: externalViewMode, onViewModeChange, fleet, onFleetAction, theme, defaultGrouping, defaultStatus, title, subtitle, topActions, authorName }: Props) {
  const t = T[lang]

  // Grouping state — 'project' on the history surfaces; the Sessions page opens on 'repo'.
  const [groupBy, setGroupBy] = useState<SessionGrouping>(defaultGrouping ?? 'project')

  // Status shortcut filter — 'all' by default; the Sessions page opens on 'active'.
  const [statusShortcut, setStatusShortcut] = useState<StatusShortcut>(defaultStatus ?? 'all')

  // Sort state
  const [sortKey, setSortKey] = useState<SortKey>('date')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  // Search state
  const [search, setSearch] = useState('')

  // View mode (list vs grid)
  const [internalViewMode, setInternalViewMode] = useState<'list' | 'grid'>('list')
  const viewMode = externalViewMode ?? internalViewMode

  function handleViewModeChange(mode: 'list' | 'grid') {
    if (onViewModeChange) onViewModeChange(mode)
    setInternalViewMode(mode)
  }

  // Pinned-to-top: up to three sessions the user always wants in sight. They live in their own block
  // above the list, OUTSIDE the grouping and the status filter, and are excluded from the list below
  // so they never appear twice. A SEARCH wins over pinning (its own flat/recent rule), so the block
  // steps aside while a search is active.
  const pinnedTopIds = usePinnedIds()
  const searching = search.trim().length > 0

  // Does a session pass the current status shortcut? Used to MARK a pinned card that the active
  // filter would otherwise hide — pinning beats the filter, but the list must not lie about it.
  const matchesStatusShortcut = (s: SessionMeta): boolean => {
    if (statusShortcut === 'all') return true
    const isLive = pinnedIds?.has(s.session_id)
    if (statusShortcut === 'active') return Boolean(isLive)
    if (statusShortcut === 'waiting') {
      const st = activities?.[s.session_id]
      return Boolean(isLive) && (st === 'waiting' || st === 'waiting-approval')
    }
    if (statusShortcut === 'closed') return !isLive
    return true
  }

  const pinnedSessions = useMemo(() => {
    if (searching || pinnedTopIds.length === 0) return []
    const bySessionId = new Map(sessions.map(s => [s.session_id, s]))
    return pinnedTopIds.map(id => bySessionId.get(id)).filter((s): s is SessionMeta => Boolean(s))
  }, [pinnedTopIds, sessions, searching])
  const pinnedTopSet = useMemo(() => new Set(searching ? [] : pinnedTopIds), [pinnedTopIds, searching])

  // Pagination state (default 5 per page)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(5)

  // Per-group pagination state
  const [groupPages, setGroupPages] = useState<Record<string, number>>({})

  // Collapsed groups accordion map
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})

  // Filter & Sort list
  const filteredAndSorted = useMemo(() => {
    // Pinned-to-top sessions render in their own block above; drop them here so they never appear
    // twice. A search suspends pinning, so they flow back into the list.
    let list = pinnedTopSet.size > 0 ? sessions.filter(s => !pinnedTopSet.has(s.session_id)) : [...sessions]

    // Text search filter
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter(
        s =>
          (s.title ?? '').toLowerCase().includes(q) ||
          (s.first_prompt ?? '').toLowerCase().includes(q) ||
          (s.project_path ?? '').toLowerCase().includes(q) ||
          (s.git_remote ?? '').toLowerCase().includes(q)
      )
    }

    // Status shortcut filter
    if (statusShortcut !== 'all') {
      list = list.filter(s => {
        const isLive = pinnedIds?.has(s.session_id)
        if (statusShortcut === 'active') return isLive
        if (statusShortcut === 'waiting') {
          const st = activities?.[s.session_id]
          return isLive && (st === 'waiting' || st === 'waiting-approval')
        }
        if (statusShortcut === 'closed') return !isLive
        return true
      })
    }

    // Sorting
    list.sort((a, b) => {
      // Float pinned sessions if sortKey is date
      if (pinnedIds && sortKey === 'date') {
        const pa = pinnedIds.has(a.session_id) ? 1 : 0
        const pb = pinnedIds.has(b.session_id) ? 1 : 0
        if (pa !== pb) return pb - pa
      }

      let res = 0
      switch (sortKey) {
        case 'date':
          res = new Date(b.start_time).getTime() - new Date(a.start_time).getTime()
          break
        case 'tokens':
          res = totalTokens(b) - totalTokens(a)
          break
        case 'messages':
          res = totalMessages(b) - totalMessages(a)
          break
        case 'tools':
          res = totalTools(b) - totalTools(a)
          break
        case 'files':
          res = (b.files_modified ?? 0) - (a.files_modified ?? 0)
          break
        case 'name':
          res = (sessionLabel(a) || a.project_path || '').localeCompare(sessionLabel(b) || b.project_path || '')
          break
        case 'status': {
          const pa = pinnedIds?.has(a.session_id) ? 1 : 0
          const pb = pinnedIds?.has(b.session_id) ? 1 : 0
          res = pb - pa
          break
        }
        default:
          res = 0
      }
      return sortDir === 'asc' ? -res : res
    })

    return list
  }, [sessions, search, statusShortcut, sortKey, sortDir, pinnedIds, pinnedTopSet])

  // Grouped list
  const groups = useMemo(() => {
    if (groupBy === 'none') return []

    const map = new Map<string, { key: string; label: string; icon: React.ReactNode; sessions: SessionMeta[] }>()
    for (const s of filteredAndSorted) {
      const bucket = getSessionBucketKey(s, groupBy, pinnedIds, activities)
      const existing = map.get(bucket.key)
      if (existing) {
        existing.sessions.push(s)
      } else {
        map.set(bucket.key, { key: bucket.key, label: bucket.label, icon: bucket.icon, sessions: [s] })
      }
    }
    return Array.from(map.values())
  }, [filteredAndSorted, groupBy, pinnedIds, activities])

  // Reset page on filter changes
  const totalItems = filteredAndSorted.length
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
  const safePage = Math.min(page, totalPages - 1)
  const startIdx = safePage * pageSize
  const endIdx = Math.min(startIdx + pageSize, totalItems)
  const pageItems = filteredAndSorted.slice(startIdx, endIdx)

  function changeSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(d => (d === 'desc' ? 'asc' : 'desc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
    setPage(0)
  }

  function toggleGroupCollapse(key: string) {
    setCollapsedGroups(prev => ({ ...prev, [key]: !prev[key] }))
  }

  const groupOptions: { key: SessionGrouping; label: string }[] = [
    { key: 'none', label: t.group_none },
    { key: 'status', label: t.group_status },
    { key: 'repo', label: t.group_repo },
    { key: 'project', label: t.group_project },
    { key: 'harness', label: t.group_harness },
    { key: 'model', label: t.group_model },
    { key: 'marked', label: t.group_marked },
  ]

  const shortcutOptions: { key: StatusShortcut; label: string }[] = [
    { key: 'all', label: t.shortcut_all },
    { key: 'active', label: t.shortcut_active },
    { key: 'waiting', label: t.shortcut_waiting },
    { key: 'closed', label: t.shortcut_closed },
  ]

  const sortOptions: { key: SortKey; label: string }[] = [
    { key: 'date', label: t.sort_date },
    { key: 'status', label: t.sort_status },
    { key: 'tokens', label: t.sort_tokens },
    { key: 'messages', label: t.sort_messages },
    { key: 'tools', label: t.sort_tools },
    { key: 'files', label: t.sort_files },
    { key: 'name', label: t.sort_name },
  ]

  const inputStyle: React.CSSProperties = {
    padding: '4px 8px',
    borderRadius: 6,
    border: '1px solid var(--border-subtle)',
    background: 'var(--bg-elevated)',
    color: 'var(--text-primary)',
    fontSize: 11,
    outline: 'none',
    minWidth: 0,
    fontFamily: 'inherit',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%', minWidth: 0, boxSizing: 'border-box' }}>
      {/* Control Bar: Agrupar por + Filtros + Ordenação */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          padding: '14px 18px',
          borderRadius: 12,
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-subtle)',
        }}
      >
        {/* Row 0: Title, Subtitle, and Top Actions (Notifications + View Mode) if provided */}
        {(title || subtitle || topActions) && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', paddingBottom: 10, borderBottom: '1px solid var(--border-subtle)' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 260 }}>
              {title && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>
                  {title}
                </div>
              )}
              {subtitle && (
                <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
                  {subtitle}
                </div>
              )}
            </div>
            {topActions && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {topActions}
              </div>
            )}
          </div>
        )}

        {/* Row 1: Agrupar por */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', flexShrink: 0 }}>
            <Layers size={13} style={{ color: 'var(--anthropic-orange)' }} />
            <span>{t.group_by}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
            {groupOptions.map(opt => (
              <PillButton key={opt.key} active={groupBy === opt.key} onClick={() => { setGroupBy(opt.key); setPage(0) }}>
                {opt.label}
              </PillButton>
            ))}
          </div>
        </div>

        {/* Row 2: Status Shortcuts + Sort + Search + View Mode */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          {/* Shortcuts & Sort */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            {/* Status shortcuts */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <Filter size={12} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
              {shortcutOptions.map(opt => (
                <PillButton key={opt.key} active={statusShortcut === opt.key} onClick={() => { setStatusShortcut(opt.key); setPage(0) }}>
                  {opt.label}
                </PillButton>
              ))}
            </div>

            {/* Separator */}
            <div style={{ width: 1, height: 16, background: 'var(--border-subtle)' }} />

            {/* Sort keys */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <ArrowUpDown size={12} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
              {sortOptions.map(opt => (
                <PillButton key={opt.key} active={sortKey === opt.key} onClick={() => changeSort(opt.key)}>
                  {opt.label} {sortKey === opt.key ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </PillButton>
              ))}
            </div>

          </div>

          {/* Search Input & View Mode */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <div style={{ position: 'relative', width: 180 }}>
              <Search
                size={12}
                style={{
                  position: 'absolute',
                  left: 8,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: 'var(--text-tertiary)',
                  pointerEvents: 'none',
                }}
              />
              <input
                type="text"
                value={search}
                onChange={e => { setSearch(e.target.value); setPage(0) }}
                placeholder={t.search_placeholder}
                style={{ ...inputStyle, paddingLeft: 24, width: '100%', boxSizing: 'border-box' }}
              />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', border: '1px solid var(--border-subtle)', borderRadius: 6, padding: 2, background: 'var(--bg-elevated)' }}>
              <button
                onClick={() => handleViewModeChange('list')}
                title={lang === 'pt' ? 'Exibir em lista' : 'List view'}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 24,
                  height: 22,
                  borderRadius: 4,
                  border: 'none',
                  background: viewMode === 'list' ? 'var(--bg-card)' : 'transparent',
                  color: viewMode === 'list' ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
                  cursor: 'pointer',
                }}
              >
                <List size={13} />
              </button>
              <button
                onClick={() => handleViewModeChange('grid')}
                title={lang === 'pt' ? 'Exibir em grid' : 'Grid view'}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 24,
                  height: 22,
                  borderRadius: 4,
                  border: 'none',
                  background: viewMode === 'grid' ? 'var(--bg-card)' : 'transparent',
                  color: viewMode === 'grid' ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
                  cursor: 'pointer',
                }}
              >
                <LayoutGrid size={13} />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Pinned-to-top block — always here, above the grouping, unmoved by it. Excluded from the
          list below so nothing shows twice; hidden while a search is active (search wins). */}
      {pinnedSessions.length > 0 && (
        <div
          style={{
            background: 'var(--bg-surface)', border: '1px solid var(--anthropic-orange-dim, rgba(232,105,11,0.35))',
            borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 10,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
            <Pin size={14} fill="currentColor" style={{ color: 'var(--anthropic-orange)' }} />
            <span>{lang === 'pt' ? 'Fixadas' : 'Pinned'}</span>
            <span
              style={{
                fontSize: 11, padding: '1px 8px', borderRadius: 999,
                background: 'rgba(232,105,11,0.12)', color: 'var(--anthropic-orange)', fontWeight: 600,
              }}
            >
              {pinnedSessions.length} / {MAX_PINNED}
            </span>
            <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-tertiary)' }}>
              {lang === 'pt' ? '— sempre à mão, fora do agrupamento' : '— always in sight, outside the grouping'}
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8, minWidth: 0 }}>
            {pinnedSessions.map(s => {
              const outside = !matchesStatusShortcut(s)
              return (
                <div key={s.session_id} style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                  {outside && (
                    <div style={{ fontSize: 10, color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', gap: 4, paddingLeft: 4 }}>
                      <Filter size={10} />
                      {lang === 'pt'
                        ? 'Fixada — fora do filtro atual da lista'
                        : 'Pinned — outside the list’s current filter'}
                    </div>
                  )}
                  <SessionCard
                    s={s}
                    lang={lang}
                    onSelect={onSelect}
                    isPinned={pinnedIds?.has(s.session_id)}
                    state={activities?.[s.session_id]}
                    fleetRow={fleet?.get(s.session_id)}
                    onFleetAction={onFleetAction}
                    authorName={authorName}
                    viewMode="list"
                    theme={theme}
                  />
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Main Content Area: Grouped or Ungrouped */}
      {filteredAndSorted.length === 0 && pinnedSessions.length === 0 ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '40px 24px',
            gap: 8,
            color: 'var(--text-tertiary)',
            background: 'var(--bg-card)',
            borderRadius: 10,
            border: '1px solid var(--border-subtle)',
          }}
        >
          <Search size={28} style={{ opacity: 0.35 }} />
          <span style={{ fontSize: 13, fontWeight: 500 }}>{t.no_results}</span>
        </div>
      ) : groupBy !== 'none' ? (
        /* Group Bands View */
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {groups.map(g => {
            const isCollapsed = Boolean(collapsedGroups[g.key])
            const gTotal = g.sessions.length
            const gTotalPages = Math.max(1, Math.ceil(gTotal / pageSize))
            const gPage = groupPages[g.key] ?? 0
            const gSafePage = Math.min(gPage, gTotalPages - 1)
            const gStart = gSafePage * pageSize
            const gEnd = Math.min(gStart + pageSize, gTotal)
            const gItems = g.sessions.slice(gStart, gEnd)

            return (
              <div
                key={g.key}
                style={{
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 10,
                  padding: 12,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                {/* Group Band Header */}
                <div
                  onClick={() => toggleGroupCollapse(g.key)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    cursor: 'pointer',
                    userSelect: 'none',
                    padding: '2px 4px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
                    {g.icon}
                    <span>{g.label}</span>
                    <span
                      style={{
                        fontSize: 11,
                        padding: '1px 8px',
                        borderRadius: 999,
                        background: 'rgba(232,105,11,0.12)',
                        color: 'var(--anthropic-orange)',
                        fontWeight: 600,
                      }}
                    >
                      {gTotal} {t.sessions_unit}
                    </span>
                  </div>
                  <div style={{ color: 'var(--text-tertiary)' }}>
                    {isCollapsed ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
                  </div>
                </div>

                {/* Group Items */}
                {!isCollapsed && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: viewMode === 'grid' ? 'repeat(auto-fill, minmax(min(100%, 320px), 1fr))' : '1fr',
                        gap: 8,
                        width: '100%',
                        minWidth: 0,
                        boxSizing: 'border-box',
                      }}
                    >
                      {gItems.map(s => (
                        <SessionCard
                          key={s.session_id}
                          s={s}
                          lang={lang}
                          onSelect={onSelect}
                          isPinned={pinnedIds?.has(s.session_id)}
                          state={activities?.[s.session_id]}
                          fleetRow={fleet?.get(s.session_id)}
                          onFleetAction={onFleetAction}
                          authorName={authorName}
                          viewMode={viewMode}
                          theme={theme}
                        />
                      ))}
                    </div>

                    {/* Group pagination — every grouping keeps the same page size */}
                    {gTotal > pageSize && (
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          flexWrap: 'wrap',
                          gap: 8,
                          paddingTop: 8,
                          borderTop: '1px solid var(--border-subtle)',
                        }}
                      >
                        <span style={{ fontSize: 11, color: 'var(--text-tertiary)', flexShrink: 0 }}>
                          {`${t.showing} ${gStart + 1}–${gEnd} ${t.of} ${gTotal}`}
                        </span>

                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <IconButton
                            onClick={() => setGroupPages(p => ({ ...p, [g.key]: 0 }))}
                            disabled={gSafePage === 0}
                            title={`${t.page} 1`}
                          >
                            <ChevronsLeft size={12} />
                          </IconButton>
                          <IconButton
                            onClick={() => setGroupPages(p => ({ ...p, [g.key]: Math.max(0, gSafePage - 1) }))}
                            disabled={gSafePage === 0}
                          >
                            <ChevronLeft size={12} />
                          </IconButton>

                          <span style={{ fontSize: 11, color: 'var(--text-secondary)', padding: '0 6px', whiteSpace: 'nowrap' }}>
                            {gSafePage + 1} / {gTotalPages}
                          </span>

                          <IconButton
                            onClick={() => setGroupPages(p => ({ ...p, [g.key]: Math.min(gTotalPages - 1, gSafePage + 1) }))}
                            disabled={gSafePage >= gTotalPages - 1}
                          >
                            <ChevronRight size={12} />
                          </IconButton>
                          <IconButton
                            onClick={() => setGroupPages(p => ({ ...p, [g.key]: gTotalPages - 1 }))}
                            disabled={gSafePage >= gTotalPages - 1}
                            title={`${t.page} ${gTotalPages}`}
                          >
                            <ChevronsRight size={12} />
                          </IconButton>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        /* Flat List/Grid View with Pagination */
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: viewMode === 'grid' ? 'repeat(auto-fill, minmax(min(100%, 320px), 1fr))' : '1fr',
            gap: 8,
            width: '100%',
            minWidth: 0,
            boxSizing: 'border-box',
          }}
        >
          {pageItems.map(s => (
            <SessionCard
              key={s.session_id}
              s={s}
              lang={lang}
              onSelect={onSelect}
              isPinned={pinnedIds?.has(s.session_id)}
              state={activities?.[s.session_id]}
              fleetRow={fleet?.get(s.session_id)}
              onFleetAction={onFleetAction}
              authorName={authorName}
              viewMode={viewMode}
              theme={theme}
            />
          ))}
        </div>
      )}

      {/* Pagination Footer (when not grouped or flat view) */}
      {groupBy === 'none' && totalItems > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 8,
            marginTop: 2,
            paddingTop: 10,
            borderTop: '1px solid var(--border-subtle)',
          }}
        >
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)', flexShrink: 0 }}>
            {`${t.showing} ${startIdx + 1}–${endIdx} ${t.of} ${totalItems}`}
          </span>

          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <IconButton onClick={() => setPage(0)} disabled={safePage === 0} title={`${t.page} 1`}>
              <ChevronsLeft size={13} />
            </IconButton>
            <IconButton onClick={() => setPage(p => Math.max(0, p - 1))} disabled={safePage === 0}>
              <ChevronLeft size={13} />
            </IconButton>

            <span style={{ fontSize: 11, color: 'var(--text-secondary)', padding: '0 6px', whiteSpace: 'nowrap' }}>
              {safePage + 1} / {totalPages}
            </span>

            <IconButton onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={safePage >= totalPages - 1}>
              <ChevronRight size={13} />
            </IconButton>
            <IconButton onClick={() => setPage(totalPages - 1)} disabled={safePage >= totalPages - 1} title={`${t.page} ${totalPages}`}>
              <ChevronsRight size={13} />
            </IconButton>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{t.per_page}</span>
            <div style={{ display: 'flex', gap: 4 }}>
              {PAGE_SIZE_OPTIONS.map(size => (
                <PillButton key={size} active={pageSize === size} onClick={() => { setPageSize(size); setPage(0) }}>
                  {size}
                </PillButton>
              ))}
            </div>
          </div>
        </div>
      )}

    </div>
  )
}

// Modal for copying session resume command via Agentop or Native Harness CLI
function ResumeCommandModal({
  s,
  lang,
  onClose,
}: {
  s: SessionMeta
  lang: 'pt' | 'en'
  onClose: () => void
}) {
  const [copiedAgentop, setCopiedAgentop] = useState(false)
  const [copiedNative, setCopiedNative] = useState(false)

  useEffect(() => {
    const originalStyle = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = originalStyle
    }
  }, [])

  const nativeCmd = resumeCommand(s) || (s.project_path ? `cd '${s.project_path}' && ${s.harness || 'claude'} --resume ${s.session_id}` : `${s.harness || 'claude'} --resume ${s.session_id}`)
  const agentopCmd = s.project_path
    ? `cd '${s.project_path}' && agentop session attach ${s.session_id}`
    : `agentop session attach ${s.session_id}`

  const titleName = s.title || (s.project_path ? formatProjectName(s.project_path) : '') || s.session_id.slice(0, 8)

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(0, 0, 0, 0.7)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 540,
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 12,
          padding: 24,
          boxShadow: '0 20px 50px rgba(0,0,0,0.6)',
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
          color: 'var(--text-primary)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 8,
                background: 'rgba(232, 105, 11, 0.12)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--anthropic-orange)',
              }}
            >
              <Terminal size={18} />
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
                {lang === 'pt' ? 'Retomar Sessão' : 'Resume AI Session'}
              </h3>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>
                {titleName}
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-tertiary)',
              cursor: 'pointer',
              padding: 4,
              borderRadius: 6,
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Option 1: Agentop CLI */}
        <div
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 8,
            padding: 14,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--anthropic-orange)' }}>
              {lang === 'pt' ? 'Opção 1: Via Agentop CLI (agentop session attach)' : 'Option 1: Via Agentop CLI (agentop session attach)'}
            </span>
            <button
              onClick={() => {
                navigator.clipboard.writeText(agentopCmd)
                setCopiedAgentop(true)
                setTimeout(() => setCopiedAgentop(false), 2000)
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '4px 10px',
                borderRadius: 6,
                border: copiedAgentop ? '1px solid rgba(34, 197, 94, 0.4)' : '1px solid var(--border-subtle)',
                background: copiedAgentop ? 'rgba(34, 197, 94, 0.12)' : 'var(--bg-surface)',
                color: copiedAgentop ? '#22c55e' : 'var(--text-primary)',
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {copiedAgentop ? <Check size={12} color="#22c55e" /> : <Copy size={12} />}
              <span>{copiedAgentop ? (lang === 'pt' ? 'Copiado!' : 'Copied!') : (lang === 'pt' ? 'Copiar comando Agentop' : 'Copy Agentop command')}</span>
            </button>
          </div>
          <code
            style={{
              fontSize: 12,
              fontFamily: 'var(--font-mono, monospace)',
              background: 'var(--bg-base)',
              padding: '8px 12px',
              borderRadius: 6,
              color: 'var(--text-primary)',
              wordBreak: 'break-all',
            }}
          >
            {agentopCmd}
          </code>
        </div>

        {/* Option 2: Native Harness CLI */}
        <div
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 8,
            padding: 14,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent-blue, #3b82f6)' }}>
              {lang === 'pt' ? `Opção 2: Via ${HARNESS_LABELS[s.harness ?? 'claude']} Nativo` : `Option 2: Via Native ${HARNESS_LABELS[s.harness ?? 'claude']}`}
            </span>
            <button
              onClick={() => {
                navigator.clipboard.writeText(nativeCmd)
                setCopiedNative(true)
                setTimeout(() => setCopiedNative(false), 2000)
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '4px 10px',
                borderRadius: 6,
                border: copiedNative ? '1px solid rgba(34, 197, 94, 0.4)' : '1px solid var(--border-subtle)',
                background: copiedNative ? 'rgba(34, 197, 94, 0.12)' : 'var(--bg-surface)',
                color: copiedNative ? '#22c55e' : 'var(--text-primary)',
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {copiedNative ? <Check size={12} color="#22c55e" /> : <Copy size={12} />}
              <span>{copiedNative ? (lang === 'pt' ? 'Copiado!' : 'Copied!') : (lang === 'pt' ? 'Copiar comando Nativo' : 'Copy Native command')}</span>
            </button>
          </div>
          <code
            style={{
              fontSize: 12,
              fontFamily: 'var(--font-mono, monospace)',
              background: 'var(--bg-base)',
              padding: '8px 12px',
              borderRadius: 6,
              color: 'var(--text-primary)',
              wordBreak: 'break-all',
            }}
          >
            {nativeCmd}
          </code>
        </div>
      </div>

    </div>
  )
}

// ================================================================================================
// SessionCard — one session row, built to ANSWER AT A GLANCE: who is it, what is it doing, what
// state is it in, and does it need you. The row leads with that; everything a glance does not need
// (the metrics, the transcript, the seven other verbs, and the live terminal itself) moves into the
// expanded accordion, reached by clicking the row.
//
// A LIVE row (agentop hosts it, `fleetRow` present) additionally carries the state's ONE lead action
// and a kebab of the rest, and expands to the live terminal + the action panel. A HISTORY row (any
// other page) is the same shell without the live half. The two are split into separate components so
// neither runs the other's hooks (the terminal stream, the actions controller) conditionally.
// ================================================================================================

interface SessionCardProps {
  s: SessionMeta
  lang: 'pt' | 'en'
  onSelect?: (s: SessionMeta) => void
  isPinned?: boolean
  /** What this session is doing right now; absent when it is not live. */
  state?: SessionActivity
  /** The live fleet row driving this conversation, when one is. Absent = a history row. */
  fleetRow?: FleetRow
  onFleetAction?: (req: { id: string; action: FleetActionId; text?: string; choice?: number })
    => Promise<{ ok: boolean; message: string; id?: string }>
  viewMode?: 'list' | 'grid'
  theme?: 'dark' | 'light'
  /** Who a write-channel send is attributed to (threaded to the actions controller for the audit). */
  authorName?: string
}

function SessionCard(props: SessionCardProps) {
  if (props.fleetRow && props.onFleetAction) {
    return <LiveSessionCard {...props} fleetRow={props.fleetRow} onFleetAction={props.onFleetAction} />
  }
  return <HistorySessionCard {...props} />
}

// ---- shared pieces -------------------------------------------------------------------------------

function titleOf(s: SessionMeta): string {
  return s.title || (s.project_path ? formatProjectName(s.project_path) : '') || s.session_id.slice(0, 8)
}

/** The colour for a FLEET state — the same palette `getStatusInfo` uses for the live-poll activity,
 *  so a live row lit from the fleet reads identically to a history row lit from the activity. */
function fleetStateColor(state: FleetRow['state']): string {
  if (state === 'waiting-approval') return '#ef4444'
  if (state === 'waiting') return '#f59e0b'
  if (state === 'working') return '#22c55e'
  if (state === 'exited' || state === 'lost' || state === 'closed') return 'rgba(156, 163, 175, 0.5)'
  return 'var(--text-tertiary)'
}

/** The state badge — the loudest thing on the row, because "does it need you" is the question that
 *  brings someone to this page. Its `color`/`label` come from ONE source per card: the fleet row on
 *  a live card (the same source the primary action reads), the live-poll activity on a history one —
 *  never a mix, so the pill and the action can never contradict each other. */
function StatusPill({ color, label }: { color: string; label: string }) {
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 8px', borderRadius: 999,
        fontSize: 11, fontWeight: 600, color, background: `${color}14`,
        border: `1px solid ${color}33`, flexShrink: 0, whiteSpace: 'nowrap',
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />
      {label}
    </span>
  )
}

/** The recessed second line — WHERE the session lives and WHAT it is on, when the fleet knows: the
 *  project/repo, the model, and (live) the task and note. This is the "who/what" context, kept quiet
 *  under the title so the state and the title stay the loud things. */
function CardMeta({ s, fleetRow, lang }: { s: SessionMeta; fleetRow?: FleetRow; lang: 'pt' | 'en' }) {
  const bits: React.ReactNode[] = []
  const repo = s.git_remote ? repoShortName(s.git_remote) : ''
  const project = fleetRow?.project || (s.project_path ? formatProjectName(s.project_path) : '')
  if (project) bits.push(<span key="p" style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><Folder size={11} style={{ opacity: 0.7 }} />{project}</span>)
  if (repo) bits.push(<span key="r" style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><GitCommit size={11} style={{ opacity: 0.7 }} />{repo}</span>)
  const model = fleetRow?.model || s.model
  if (model) bits.push(<span key="m" style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><Tag size={11} style={{ opacity: 0.7 }} />{model}</span>)
  if (fleetRow?.task) bits.push(<span key="t" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--anthropic-orange)' }}><Bookmark size={11} />{fleetRow.task}</span>)
  if (fleetRow?.note) bits.push(<span key="n" style={{ fontStyle: 'italic', opacity: 0.85 }} title={fleetRow.note}>“{truncate(fleetRow.note, 60)}”</span>)
  if (bits.length === 0) return null
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 11, color: 'var(--text-tertiary)', minWidth: 0 }}>
      {bits.map((b, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span style={{ opacity: 0.4 }}>·</span>}
          {b}
        </React.Fragment>
      ))}
    </div>
  )
}

/** The metric chips — the deep-dive numbers. They do not help answer who/what/state/needs-you, so
 *  they live in the expanded body, not on the collapsed row. */
function CardChips({ s, lang }: { s: SessionMeta; lang: 'pt' | 'en' }) {
  const tokens = totalTokens(s)
  const tools = totalTools(s)
  const msgs = totalMessages(s)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <Chip icon={<Clock size={11} />} label={sessionTime(s, lang).combined} title={sessionTime(s, lang).tooltip} />
      <Chip icon={null} label={`${msgs} msgs`} color="var(--accent-blue, #3b82f6)" />
      {tokens > 0 && <Chip icon={null} label={`${fmt(tokens)} tkn`} color="var(--anthropic-orange, #e8690b)" />}
      {tools > 0 && <Chip icon={<Wrench size={11} />} label={`${tools} tools`} color="var(--accent-green, #22c55e)" />}
      {s.git_commits > 0 && <Chip icon={<GitCommit size={11} />} label={`${s.git_commits} commits`} color="var(--accent-purple, #a855f7)" />}
      {s.files_modified > 0 && <Chip icon={<FileCode size={11} />} label={`${s.files_modified} files`} />}
    </div>
  )
}

/** The small buttons that open the metrics modal / the resume-command modal. Grouped so both card
 *  variants render them the same way. */
function CardFooterButtons({ s, lang, onSelect, onResume }: {
  s: SessionMeta; lang: 'pt' | 'en'; onSelect?: (s: SessionMeta) => void; onResume: () => void
}) {
  const btn: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 6,
    border: '1px solid var(--border-subtle)', background: 'var(--bg-surface)', color: 'var(--text-primary)',
    fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <button onClick={(e) => { e.stopPropagation(); onResume() }} title={lang === 'pt' ? 'Retomar sessão (Agentop / Nativo)' : 'Resume session (Agentop / Native)'} style={{ ...btn, color: 'var(--anthropic-orange)' }}>
        <Terminal size={12} /><span>{lang === 'pt' ? 'Retomar' : 'Resume'}</span>
      </button>
      {onSelect && (
        <button onClick={(e) => { e.stopPropagation(); onSelect(s) }} style={btn}>
          <Maximize2 size={11} /><span>{lang === 'pt' ? 'Métricas da sessão' : 'Session metrics'}</span>
        </button>
      )}
    </div>
  )
}

/** The outer card shell + clickable header shared by both variants. `accent` is the state colour
 *  drawn as a left rule so a row that needs you is spotted without reading it. `affordance` is the
 *  trailing icon that says what a click does — a chevron in the list (expands inline) or a maximize
 *  glyph in the grid (opens the modal, so the grid layout never stretches). */
function CardShell({
  accent, expanded, onToggle, statusPill, harness, title, right, meta, affordance, children,
}: {
  accent: string
  expanded: boolean
  onToggle: () => void
  statusPill: React.ReactNode
  harness?: string
  title: string
  right: React.ReactNode
  meta: React.ReactNode
  affordance: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div
      style={{
        position: 'relative', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
        borderLeft: `3px solid ${accent}`, borderRadius: 10, boxSizing: 'border-box', minWidth: 0, width: '100%',
        display: 'flex', flexDirection: 'column', transition: 'all 0.15s ease',
      }}
    >
      <div
        onClick={onToggle}
        style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 16px', cursor: 'pointer', userSelect: 'none', minWidth: 0 }}
      >
        {/* The header WRAPS. In a grid column (~360px) the action cluster is `flexShrink:0` and wide
            (a "Send a prompt" button + pin + kebab + maximize), so on one non-wrapping row it crushed
            the title to nothing and clipped the harness badge — the fields did not fit the column.
            With `flexWrap`, when the actions cannot sit beside the identity they drop to their own
            row and the pill + badge + title keep a full-width line where the title is readable; on a
            wide card everything stays on one row exactly as before. `marginLeft:auto` right-aligns
            the actions on the shared row (replacing space-between, which mis-spaces a wrapped line). */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, rowGap: 8, minWidth: 0, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: '1 1 170px', minWidth: 0 }}>
            {statusPill}
            <HarnessBadge harness={harness} />
            <span
              style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}
              title={title}
            >
              {title}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, marginLeft: 'auto' }}>
            {right}
            <span style={{ color: 'var(--text-tertiary)', display: 'inline-flex' }}>
              {affordance}
            </span>
          </div>
        </div>
        {meta}
      </div>
      {expanded && (
        <div onClick={e => e.stopPropagation()} style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '0 16px 14px', minWidth: 0 }}>
          {children}
        </div>
      )}
    </div>
  )
}

// ---- the live terminal region --------------------------------------------------------------------

const TERM_TONE_COLOR: Record<TerminalTone, string> = {
  idle: 'var(--text-tertiary)',
  connecting: 'var(--text-tertiary)',
  live: '#22c55e',
  finished: 'var(--anthropic-orange, #e8690b)',
  ended: 'var(--accent-red, #e0342a)',
  // A stall is recoverable (there is a reconnect verb), so it is amber — a warning, not the red
  // fault colour a gone session wears.
  stalled: 'var(--accent-amber, #f59e0b)',
}

/** The live screen of THIS session, inside its own accordion. Mounted only while the card is
 *  expanded and the row is watchable, so the stream opens on demand and closes on collapse. The
 *  emulator is keyed by id, so switching to another session can never show one screen under
 *  another's name. The activity state shown is the fleet row's own (two-sample-verified) state,
 *  never recomputed from the frames; what the SCREEN is (live / finished / gone) comes from the
 *  channel's own fields. */
/** The page-wide, persisted terminal zoom, shared live across every open terminal. */
function useTerminalZoom(): number {
  return useSyncExternalStore(subscribeTerminalZoom, getTerminalZoom, () => 1)
}

/** The A− / % / A+ control. It scales the PIXELS only (the emulator stays at the pane's real column
 *  count), so a bigger font can never reflow the capture; the choice persists across reloads. */
function TerminalZoomControls({ lang }: { lang: 'pt' | 'en' }) {
  const zoom = useTerminalZoom()
  const isMobile = useIsMobile()
  // 44px touch targets on mobile (the repo rule); the compact desktop size otherwise.
  const btn: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: isMobile ? 40 : 24, height: isMobile ? 40 : 22,
    borderRadius: 4, border: 'none', background: 'transparent', color: 'var(--text-secondary)',
    cursor: 'pointer', padding: 0,
  }
  return (
    <div
      onClick={e => e.stopPropagation()}
      title={lang === 'pt' ? 'Tamanho da fonte do terminal' : 'Terminal font size'}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 2, marginLeft: 'auto',
        border: '1px solid var(--border-subtle)', borderRadius: 6, padding: 2, background: 'var(--bg-elevated)',
      }}
    >
      <button
        onClick={() => setTerminalZoom(zoom - ZOOM_STEP)}
        disabled={zoom <= ZOOM_MIN}
        aria-label={lang === 'pt' ? 'Diminuir fonte' : 'Smaller font'}
        style={{ ...btn, opacity: zoom <= ZOOM_MIN ? 0.4 : 1, cursor: zoom <= ZOOM_MIN ? 'default' : 'pointer' }}
      >
        <ZoomOut size={13} />
      </button>
      <button
        onClick={() => setTerminalZoom(1)}
        title={lang === 'pt' ? 'Tamanho padrão' : 'Reset size'}
        style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', fontSize: isMobile ? 12 : 10, fontWeight: 600, fontVariantNumeric: 'tabular-nums', minWidth: 32, minHeight: isMobile ? 40 : undefined, padding: 0 }}
      >
        {Math.round(zoom * 100)}%
      </button>
      <button
        onClick={() => setTerminalZoom(zoom + ZOOM_STEP)}
        disabled={zoom >= ZOOM_MAX}
        aria-label={lang === 'pt' ? 'Aumentar fonte' : 'Larger font'}
        style={{ ...btn, opacity: zoom >= ZOOM_MAX ? 0.4 : 1, cursor: zoom >= ZOOM_MAX ? 'default' : 'pointer' }}
      >
        <ZoomIn size={13} />
      </button>
    </div>
  )
}

/** Direct-typing (keystroke channel) status strings. Kept apart from the line composer's COMPOSER_T. */
const TYPING_T = {
  pt: {
    live: 'Digitando direto na sessão — teclas (incl. Ctrl+C) chegam ao processo.',
    connecting: 'Conectando o teclado à sessão…',
    unavailable: 'Não foi possível abrir o canal de escrita.',
    notDelivered: 'Não entregue:',
  },
  en: {
    live: 'Typing straight into the session — keys (incl. Ctrl+C) reach the process.',
    connecting: 'Connecting the keyboard to the session…',
    unavailable: 'The write channel could not be opened.',
    notDelivered: 'Not delivered:',
  },
} as const

/**
 * EXPORTED so the sessions workspace's centre pane uses this very component rather than assembling
 * a second one from `useTerminalStream` + `SessionTerminal` + a composer. Those three have to agree
 * about reconnects, stall reporting, zoom and the consent gate on typing into a live session, and
 * two assemblies is two chances for them not to.
 */
export function TerminalRegion({ id, theme, lang, fill, onMaximize, row, act, authorName }: {
  id: string; theme: 'dark' | 'light'; lang: 'pt' | 'en'
  /** Fill the available height (in the modal) instead of a fixed card-sized box. */
  fill?: boolean
  /** When set, a maximize button opens the modal — where the box is wide enough to read a wide pane
   *  at a larger scale. Absent inside the modal itself (already maximized). */
  onMaximize?: () => void
  /** The live fleet row this terminal is showing. When present with `act`, the region becomes
   *  INTERACTIVE — a consent-gated line composer under the screen (see `TerminalComposer`). */
  row?: FleetRow
  act?: (req: { id: string; action: FleetActionId; text?: string; choice?: number })
    => Promise<{ ok: boolean; message: string; id?: string }>
  authorName?: string
}) {
  const isMobile = useIsMobile()
  const { state, reconnect } = useTerminalStream(id)
  const status = terminalStatus(state, lang === 'pt' ? 'pt' : 'en')
  const zoom = useTerminalZoom()
  const fixedHeight = isMobile ? 240 : 320
  const stalled = status.tone === 'stalled'

  // Phase 2b — DIRECT TYPING. The composer's consent (one opt-in) also opens the terminal's keystroke
  // channel. Direct typing is allowed for any LIVE, managed row — including one on a dialog: a sighted
  // single keystroke answers a prompt, unlike the blind line composer, which alone refuses a dialog.
  const [typingArmed, setTypingArmed] = useState(false)
  const rowBlock = row ? interactionBlock(row.state) : 'external'
  const canType = !!row && !!act && rowBlock !== 'external' && rowBlock !== 'not-running'
  const write = useTerminalWrite(id, typingArmed && canType, lang === 'pt' ? 'pt' : 'en')
  // The emulator accepts keys only once the channel is actually OPEN — so a captured keystroke can
  // always be delivered (no local echo; a key you can see was typed is a key that landed).
  const interactive = typingArmed && canType && write.ready
  const tw = TYPING_T[lang]
  // The one honest status for the keystroke channel: connecting → live, a drop, or a not-delivered.
  const typingNotice: { tone: 'live' | 'wait' | 'bad'; text: string } | null =
    !typingArmed || !canType ? null
    : write.state.undelivered && write.reason ? { tone: 'bad', text: `${tw.notDelivered} ${write.reason}` }
    : write.state.phase === 'closed' ? { tone: 'bad', text: write.reason ?? tw.unavailable }
    : write.ready ? { tone: 'live', text: tw.live }
    : { tone: 'wait', text: tw.connecting }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, height: fill ? '100%' : undefined, flex: fill ? 1 : undefined }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--anthropic-orange)', display: 'inline-flex' }}><Terminal size={14} /></span>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{lang === 'pt' ? 'Terminal ao vivo' : 'Live terminal'}</span>
        <span
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600,
            color: TERM_TONE_COLOR[status.tone], border: `1px solid ${TERM_TONE_COLOR[status.tone]}`,
            borderRadius: 999, padding: '2px 8px',
          }}
        >
          <span
            style={{
              width: 7, height: 7, borderRadius: '50%', background: TERM_TONE_COLOR[status.tone],
              // Pulse only while genuinely live; a still dot on a finished/gone screen would imply life.
              animation: status.tone === 'live' ? 'ag-term-pulse 1.6s ease-in-out infinite' : undefined,
            }}
          />
          {status.label}
        </span>
        <TerminalZoomControls lang={lang} />
        {onMaximize && (
          <button
            onClick={(e) => { e.stopPropagation(); onMaximize() }}
            title={lang === 'pt' ? 'Ampliar o terminal' : 'Enlarge the terminal'}
            aria-label={lang === 'pt' ? 'Ampliar o terminal' : 'Enlarge the terminal'}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: isMobile ? 40 : 26, height: isMobile ? 40 : 22, borderRadius: 6,
              border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
              color: 'var(--text-secondary)', cursor: 'pointer', padding: 0,
            }}
          >
            <Maximize2 size={13} />
          </button>
        )}
      </div>
      <div
        style={{
          height: fill ? undefined : fixedHeight, flex: fill ? 1 : undefined, minHeight: fill ? 0 : undefined,
          borderRadius: 8, overflow: 'hidden',
          border: '1px solid var(--border-subtle)', background: theme === 'light' ? '#ffffff' : '#0e1116',
        }}
      >
        <Suspense fallback={<div style={{ padding: 16, fontSize: 12, color: 'var(--text-tertiary)', fontFamily: 'monospace' }}>{lang === 'pt' ? 'Carregando o emulador…' : 'Loading the emulator…'}</div>}>
          {/* key={id}: a new session gets a brand-new emulator, so no content leaks across. */}
          <SessionTerminal key={id} frame={state.frame} theme={theme} showCursor={status.showCursor} zoom={zoom} interactive={interactive} onInput={write.send} />
        </Suspense>
      </div>
      {/* Phase 2b — the keystroke channel's honest status. It never echoes a key; this line is the one
          place a drop or a not-delivered is reported (A6), and where "you are typing live" is stated. */}
      {typingNotice && (
        <div
          role={typingNotice.tone === 'bad' ? 'status' : undefined}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, lineHeight: 1.5,
            color: typingNotice.tone === 'bad' ? '#ef4444' : typingNotice.tone === 'live' ? '#22c55e' : 'var(--text-tertiary)',
          }}
        >
          <Keyboard size={12} style={{ flexShrink: 0, opacity: 0.8 }} />
          <span>{typingNotice.tone === 'bad' ? <strong>{typingNotice.text}</strong> : typingNotice.text}</span>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5, flex: 1, minWidth: 0 }}>{status.detail}</div>
        {stalled && (
          <button
            onClick={(e) => { e.stopPropagation(); reconnect() }}
            title={lang === 'pt' ? 'Reconectar' : 'Reconnect'}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', flexShrink: 0,
              minHeight: isMobile ? 40 : 28, padding: isMobile ? '0 14px' : '4px 12px', borderRadius: 8,
              fontSize: isMobile ? 13 : 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
              border: `1px solid ${TERM_TONE_COLOR.stalled}`, background: 'transparent', color: TERM_TONE_COLOR.stalled,
            }}
          >
            <RotateCcw size={13} />
            <span>{lang === 'pt' ? 'Reconectar' : 'Reconnect'}</span>
          </button>
        )}
      </div>
      {/* Phase 2 — the WRITE half: a consent-gated line composer, present only when this region is
          driving a live fleet row the page can act on. Read-only terminals (history rows, or a page
          with no `act`) render no composer, so a field that does nothing is never shown. */}
      {row && act && (
        <TerminalComposer row={row} act={act} authorName={authorName} lang={lang} isMobile={isMobile} onArmedChange={setTypingArmed} />
      )}
      <style>{`@keyframes ag-term-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.35 } }`}</style>
    </div>
  )
}

/**
 * TerminalComposer — the interactive write channel under the live terminal.
 *
 * It renders the four decisions of `lib/terminalInput.ts` (all localized here, the logic pure there):
 *  - CONSENT: read-only until you press "Type into this session"; a "Stop typing" revokes it.
 *  - BATCHED: a native input is the local line editor; ONE `prompt` request carries the finished line.
 *  - HONEST DELIVERY: the draft is a visibly-distinct LOCAL line; on submit it goes sending →
 *    delivered (cleared) | failed (kept verbatim, with the server's reason). A key is never accepted
 *    then lost — nothing is delivered per key, and the one line's outcome is always on screen.
 *  - AUDIT: the delivered-or-failed line is recorded through `recordPromptSend`; keystrokes are not.
 */
function TerminalComposer({ row, act, authorName, lang, isMobile, onArmedChange }: {
  row: FleetRow
  act: (req: { id: string; action: FleetActionId; text?: string; choice?: number })
    => Promise<{ ok: boolean; message: string; id?: string }>
  authorName?: string
  lang: 'pt' | 'en'
  isMobile: boolean
  /** The SAME consent arms direct terminal typing (Phase 2b) — the parent opens the keystroke
   *  channel when this turns true. One opt-in, not two. */
  onArmedChange?: (armed: boolean) => void
}) {
  const [composer, dispatch] = useReducer(composerReducer, INITIAL_COMPOSER)
  // A brief "delivered" confirmation; the durable record lives in the audit panel below the card.
  const [flash, setFlash] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const t = COMPOSER_T[lang]

  // Tell the parent whenever consent changes, so the terminal's own keystroke channel opens/closes
  // in lockstep with the line composer's arming.
  useEffect(() => { onArmedChange?.(composer.armed) }, [composer.armed, onArmedChange])

  // `external` / `not-running` are HARD blocks — no live process, nothing to type into either way, so
  // the composer is closed entirely. `awaiting-approval` is NOT a hard block for Phase 2b: a sighted
  // keystroke ANSWERS the dialog (the coordinator's decision), so consent survives it and direct
  // typing keeps working; only the blind LINE prompt is refused there, by the server, and its refusal
  // is reported honestly by the delivery banner below.
  const block = interactionBlock(row.state)
  const hardBlock = block === 'awaiting-approval' ? null : block
  const onDialog = block === 'awaiting-approval'
  useEffect(() => {
    if (hardBlock && composer.armed) dispatch({ type: 'disarm' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hardBlock])

  async function send() {
    if (!canSubmit(composer)) return
    const text = composer.draft
    dispatch({ type: 'submit' })
    setFlash(false)
    const out = await act({ id: row.id, action: 'prompt', text })
    // AUDIT the atomic line — accepted or refused — through the one write-channel record. Local edits
    // reached here as nothing; only this send is a record (decision 4).
    recordPromptSend({
      author: resolveAuthor({ accountName: authorName, operatorId: operatorId() }),
      sessionId: row.id,
      sessionTitle: row.title,
      harness: row.harness,
      text,
      ok: out.ok,
      message: out.message,
    })
    dispatch({ type: 'sent', ok: out.ok, message: out.message })
    if (out.ok) {
      setFlash(true)
      inputRef.current?.focus()
    }
  }

  // A row with no live process says why, in one sentence, and offers no arming button — the same rule
  // the session menu applies: a control that does nothing is worse than an honest refusal. A dialog is
  // NOT such a case any more (direct typing answers it), so it falls through to the normal composer.
  if (hardBlock) {
    return (
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <Keyboard size={12} style={{ opacity: 0.6 }} />
        <span>{t.block[hardBlock]}</span>
      </div>
    )
  }

  if (!composer.armed) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button
          onClick={(e) => { e.stopPropagation(); dispatch({ type: 'arm' }); setFlash(false); setTimeout(() => inputRef.current?.focus(), 0) }}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', flexShrink: 0,
            minHeight: isMobile ? 44 : 28, padding: isMobile ? '0 16px' : '4px 12px', borderRadius: 8,
            fontSize: isMobile ? 13 : 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
            border: '1px solid var(--anthropic-orange)', background: 'transparent', color: 'var(--anthropic-orange)',
          }}
        >
          <Keyboard size={13} /> <span>{t.arm}</span>
        </button>
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{t.readonly}</span>
      </div>
    )
  }

  const sending = composer.status === 'sending'
  const failed = composer.status === 'failed'
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0,
        // A LOCAL DRAFT, drawn distinctly from the session's own output so local echo is never
        // mistaken for the session having received it.
        borderLeft: '2px solid var(--anthropic-orange)', paddingLeft: 10,
      }}
    >
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, fontSize: 11, fontWeight: 600, color: 'var(--anthropic-orange)' }}>
        <Send size={11} style={{ flexShrink: 0 }} />
        <span style={{ color: 'var(--text-tertiary)', fontWeight: 500, flexShrink: 0 }}>{t.writingTo}</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${row.title} · ${row.id}`}>{row.title}</span>
        <code style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 10, opacity: 0.75, flexShrink: 0 }}>{row.id}</code>
      </div>
      {/* On a dialog the blind LINE prompt is refused by the server; the sighted keystroke path (the
          terminal above) is how you answer it. Say so rather than let the line send fail silently. */}
      {onDialog && (
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>{t.onDialogHint}</div>
      )}
      <form
        onSubmit={(e) => { e.preventDefault(); void send() }}
        style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', minWidth: 0 }}
      >
        <span style={{ color: 'var(--anthropic-orange)', fontFamily: 'var(--font-mono, monospace)', fontWeight: 700, flexShrink: 0 }}>›</span>
        <input
          ref={inputRef}
          value={composer.draft}
          disabled={sending}
          onChange={(e) => dispatch({ type: 'edit', draft: e.target.value })}
          placeholder={t.placeholder}
          aria-label={t.arm}
          // No inline font-size: index.css guarantees >= 16px on mobile; overriding it zooms iOS.
          style={{
            flex: '1 1 220px', minWidth: 0, minHeight: isMobile ? 44 : 28, padding: '0 10px', borderRadius: 8,
            border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)',
            fontFamily: 'var(--font-mono, monospace)', outline: 'none', opacity: sending ? 0.6 : 1,
          }}
        />
        <button
          type="submit"
          disabled={!canSubmit(composer)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', flexShrink: 0,
            minHeight: isMobile ? 44 : 28, padding: isMobile ? '0 16px' : '4px 12px', borderRadius: 8,
            fontSize: isMobile ? 13 : 12, fontWeight: 600, fontFamily: 'inherit',
            cursor: canSubmit(composer) ? 'pointer' : 'default', opacity: canSubmit(composer) ? 1 : 0.5,
            border: '1px solid var(--anthropic-orange)', background: 'var(--anthropic-orange)', color: '#fff',
          }}
        >
          <Send size={13} /> <span>{sending ? t.sending : t.send}</span>
        </button>
        <button
          type="button"
          onClick={() => dispatch({ type: 'disarm' })}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', flexShrink: 0,
            minHeight: isMobile ? 44 : 28, padding: isMobile ? '0 14px' : '4px 10px', borderRadius: 8,
            fontSize: isMobile ? 13 : 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
            border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-secondary)',
          }}
        >
          <Hand size={13} /> <span>{t.stop}</span>
        </button>
      </form>
      {/* HONEST DELIVERY — the one place the line's fate is reported. */}
      {sending && <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{t.delivering}</div>}
      {failed && (
        <div role="status" style={{ fontSize: 11, color: '#ef4444', lineHeight: 1.5 }}>
          <strong>{t.notDelivered}</strong> {composer.error} <span style={{ color: 'var(--text-tertiary)' }}>· {t.retryHint}</span>
        </div>
      )}
      {flash && !sending && !failed && (
        <div role="status" style={{ fontSize: 11, color: '#22c55e', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Check size={12} /> {t.delivered}
        </div>
      )}
    </div>
  )
}

const COMPOSER_T = {
  pt: {
    arm: 'Digitar nesta sessão',
    readonly: 'Somente leitura até você começar a digitar. Ao ligar, as teclas (incl. Ctrl+C) vão direto ao processo.',
    stop: 'Parar',
    onDialogHint: 'Esta sessão está num diálogo — responda digitando direto no terminal acima; enviar uma linha aqui é recusado.',
    writingTo: 'Escrevendo em',
    placeholder: 'Uma linha para enviar a esta sessão…',
    send: 'Enviar',
    sending: 'Enviando…',
    delivering: 'Entregando a linha…',
    delivered: 'Entregue à sessão.',
    notDelivered: 'Não entregue:',
    retryHint: 'a linha foi mantida; revise e reenvie.',
    block: {
      external: 'Esta sessão não foi iniciada pelo agentop — nada aqui pode escrever nela.',
      'not-running': 'Esta sessão não está rodando — não há processo para receber o que você digitar.',
      'awaiting-approval': 'Esta sessão está esperando uma resposta numa caixa de diálogo. Responda o diálogo — não dá para digitar por cima dele.',
    } as Record<string, string>,
  },
  en: {
    arm: 'Type into this session',
    readonly: 'Read-only until you start typing. Once on, keys (incl. Ctrl+C) go straight to the process.',
    stop: 'Stop',
    onDialogHint: 'This session is on a dialog — answer it by typing directly in the terminal above; sending a line here is refused.',
    writingTo: 'Writing to',
    placeholder: 'One line to send to this session…',
    send: 'Send',
    sending: 'Sending…',
    delivering: 'Delivering the line…',
    delivered: 'Delivered to the session.',
    notDelivered: 'Not delivered:',
    retryHint: 'the line was kept; edit and resend.',
    block: {
      external: 'This session was not started by agentop — nothing here can write to it.',
      'not-running': 'This session is not running — there is no process to receive what you type.',
      'awaiting-approval': 'This session is waiting on a dialog answer. Answer the dialog — you cannot type past it.',
    } as Record<string, string>,
  },
}

// ---- the primary lead action ---------------------------------------------------------------------

/** The one action the row leads with. 'watch' just opens the terminal; the verbs run through the
 *  shared controller. `Answer its question` is rendered as a HUMAN action — a person answers it, so
 *  it carries a hand glyph and a plain-language note, and (like every verb) it is never automated. */
function PrimaryButton({ primary, lang, onExpand, onPick }: {
  primary: PrimaryAction; lang: 'pt' | 'en'; onExpand: () => void; onPick: (v: FleetVerb) => void
}) {
  const isMobile = useIsMobile()
  let label: string
  let icon: React.ReactNode
  let title: string | undefined
  const human = primary.human
  switch (primary.kind) {
    case 'watch':
      label = lang === 'pt' ? 'Ver ao vivo' : 'Watch'
      icon = <Eye size={13} />
      break
    case 'approve':
      label = primary.verb?.label ?? (lang === 'pt' ? 'Responder' : 'Answer its question')
      icon = <Hand size={13} />
      title = lang === 'pt' ? 'Uma pessoa responde — nada aqui responde por ela.' : 'A person answers this — nothing here answers for you.'
      break
    case 'prompt':
      label = primary.verb?.label ?? (lang === 'pt' ? 'Enviar prompt' : 'Send a prompt')
      icon = <Send size={13} />
      break
    case 'resume':
      label = primary.verb?.label ?? (lang === 'pt' ? 'Reabrir' : 'Reopen')
      icon = <RotateCcw size={13} />
      break
  }
  const filled = primary.kind === 'approve' || primary.kind === 'prompt'
  const disabled = primary.verb ? !primary.verb.enabled : false
  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        onExpand()
        if (primary.verb) onPick(primary.verb)
      }}
      title={title ?? label}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap',
        minHeight: isMobile ? 40 : 30, padding: isMobile ? '0 14px' : '5px 12px', borderRadius: 8,
        fontSize: isMobile ? 13 : 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
        border: filled ? '1px solid var(--anthropic-orange)' : '1px solid var(--border-subtle)',
        background: filled ? 'var(--anthropic-orange)' : 'var(--bg-surface)',
        color: filled ? '#fff' : 'var(--anthropic-orange)',
        opacity: disabled ? 0.55 : 1,
      }}
    >
      {icon}
      <span>{label}</span>
      {human && <span aria-hidden style={{ fontSize: 10, opacity: 0.85, fontWeight: 500 }}>· {lang === 'pt' ? 'você' : 'you'}</span>}
    </button>
  )
}

// ---- pin to top -----------------------------------------------------------------------------------

/** The page-wide, persisted set of pinned session ids, shared live across the list. */
function usePinnedIds(): string[] {
  return useSyncExternalStore(subscribePinnedSessions, getPinnedIds, pinnedServerSnapshot)
}

/** Which session's card modal is open — held outside the card so a live re-render (which remounts a
 *  card) cannot close a maximized terminal under the user. */
function useOpenModalSession(): string | null {
  return useSyncExternalStore(subscribeOpenModalSession, getOpenModalSession, () => null)
}

/** The pin toggle on a card. Solid = pinned (click to unpin); outline = pin it. The fourth pin is
 *  REFUSED (never a silent swap), and the refusal is said in a brief tooltip. */
function PinButton({ sessionId, lang }: { sessionId: string; lang: 'pt' | 'en' }) {
  const pinnedIds = usePinnedIds()
  const pinned = pinnedIds.includes(sessionId)
  const isMobile = useIsMobile()
  const [refused, setRefused] = useState(false)
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }} onClick={e => e.stopPropagation()}>
      <button
        onClick={() => {
          const r = togglePinnedSession(sessionId)
          if (!r.ok) { setRefused(true); setTimeout(() => setRefused(false), 2600) }
        }}
        title={pinned
          ? (lang === 'pt' ? 'Desafixar do topo' : 'Unpin from top')
          : (lang === 'pt' ? `Fixar no topo (até ${MAX_PINNED})` : `Pin to top (up to ${MAX_PINNED})`)}
        aria-label={pinned ? (lang === 'pt' ? 'Desafixar' : 'Unpin') : (lang === 'pt' ? 'Fixar' : 'Pin')}
        aria-pressed={pinned}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: isMobile ? 40 : 30, height: isMobile ? 40 : 30, borderRadius: 8,
          border: pinned ? '1px solid var(--anthropic-orange)' : '1px solid var(--border-subtle)',
          background: pinned ? 'rgba(232,105,11,0.1)' : 'transparent',
          color: pinned ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
          cursor: 'pointer', padding: 0, flexShrink: 0,
        }}
      >
        {pinned ? <Pin size={15} fill="currentColor" /> : <Pin size={15} />}
      </button>
      {refused && (
        <div
          role="status"
          style={{
            position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 300, width: 200,
            fontSize: 11, lineHeight: 1.4, color: 'var(--text-primary)', background: 'var(--bg-surface)',
            border: '1px solid var(--anthropic-orange)', borderRadius: 8, padding: '8px 10px',
            boxShadow: '0 8px 20px -6px rgba(0,0,0,0.5)',
          }}
        >
          {lang === 'pt'
            ? `Máximo de ${MAX_PINNED} sessões fixadas. Desafixe uma para fixar outra.`
            : `At most ${MAX_PINNED} pinned sessions. Unpin one to pin another.`}
        </div>
      )}
    </span>
  )
}

// ---- the modal (grid card-open + terminal maximize) ----------------------------------------------

/** One overlay, used for two things the coordinator kept as one: opening a card in the GRID (so the
 *  grid never stretches when a card expands) and MAXIMIZING the terminal (where the box is wide
 *  enough to read a 200+ column pane at a larger scale). `esc` or a click outside closes it. */
function CardModal({ statusPill, harness, title, meta, lang, onClose, children }: {
  statusPill: React.ReactNode
  harness?: string
  title: string
  meta: React.ReactNode
  lang: 'pt' | 'en'
  onClose: () => void
  children: React.ReactNode
}) {
  const isMobile = useIsMobile()
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => { document.body.style.overflow = prev; document.removeEventListener('keydown', onKey) }
  }, [onClose])

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 9998, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: isMobile ? 'stretch' : 'center', justifyContent: 'center', padding: isMobile ? OVERLAY_TOP : 24,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: isMobile ? '100%' : 'min(1400px, 95vw)', height: isMobile ? '100%' : '92vh',
          background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)',
          borderRadius: isMobile ? 0 : 12, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '14px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            {statusPill}
            <HarnessBadge harness={harness} />
            <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }} title={title}>
              {title}
            </span>
            <button
              onClick={onClose}
              title={lang === 'pt' ? 'Fechar' : 'Close'}
              aria-label={lang === 'pt' ? 'Fechar' : 'Close'}
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                width: isMobile ? 40 : 30, height: isMobile ? 40 : 30, borderRadius: 8,
                border: '1px solid var(--border-subtle)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', padding: 0,
              }}
            >
              <X size={16} />
            </button>
          </div>
          {meta}
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {children}
        </div>
      </div>
    </div>
  )
}

// ---- the two card variants -----------------------------------------------------------------------

function LiveSessionCard({ s, lang, onSelect, isPinned, state, fleetRow, onFleetAction, theme, viewMode, authorName }: SessionCardProps & {
  fleetRow: FleetRow
  onFleetAction: NonNullable<SessionCardProps['onFleetAction']>
}) {
  const isGrid = viewMode === 'grid'
  const [expanded, setExpanded] = useState(false)
  const modalOpen = useOpenModalSession() === s.session_id
  const setModalOpen = (open: boolean) => setOpenModalSession(open ? s.session_id : null)
  const [showResumeModal, setShowResumeModal] = useState(false)
  const ctrl = useSessionActionsController(fleetRow, lang, onFleetAction, authorName)
  // The state indicator reads the FLEET — the same source the primary action reads — so the pill,
  // the accent and the lead action can never contradict each other.
  const accent = fleetStateColor(fleetRow.state)
  const primary = primaryAction(fleetRow)
  const watchable = isWatchable(fleetRow.state)

  // In the GRID, opening never expands inline (that would stretch the whole row to the tallest card)
  // — it opens the modal, so the layout never moves. In the LIST there is no grid to break, so it
  // expands inline. The primary action and the menu route through the same door.
  const openCard = () => { if (isGrid) setModalOpen(true); else setExpanded(v => !v) }

  const statusPill = <StatusPill color={accent} label={fleetRow.stateLabel} />
  const meta = <CardMeta s={s} fleetRow={fleetRow} lang={lang} />

  // The card is session CONTROL, not a session dossier: only the metric chips stay on it. The first
  // prompt / latest-messages block and the "Session metrics" button moved off — the deep-dive lives
  // one click away, in the drilldown reached from the kebab.
  // The inline terminal is mounted whenever the row is watchable — do NOT gate it on `!modalOpen`.
  // Unmounting the inline `TerminalRegion` each time the modal opens/closes DISPOSES its xterm on
  // every fullscreen toggle, and an xterm dispose schedules a viewport sync that reads `dimensions`
  // off a torn-down render service — an async, uncatchable throw once per toggle (invisible in dev
  // under StrictMode, real in the production build). The duplicate SSE the modal briefly holds is the
  // lesser cost, and it is bounded by the connecting stall/reconnect above.
  const body = (large: boolean) => (
    <>
      {watchable && <TerminalRegion id={fleetRow.id} theme={theme ?? 'dark'} lang={lang} fill={large} onMaximize={large ? undefined : () => setModalOpen(true)} row={fleetRow} act={onFleetAction} authorName={authorName} />}
      <SessionActionsPanel ctrl={ctrl} />
      <CardChips s={s} lang={lang} />
      <CardFooterButtons s={s} lang={lang} onResume={() => setShowResumeModal(true)} />
    </>
  )

  return (
    <>
      {showResumeModal && <ResumeCommandModal s={s} lang={lang} onClose={() => setShowResumeModal(false)} />}
      {modalOpen && (
        <CardModal statusPill={statusPill} harness={s.harness} title={titleOf(s)} meta={meta} lang={lang} onClose={() => setModalOpen(false)}>
          {body(true)}
        </CardModal>
      )}
      <CardShell
        accent={accent}
        expanded={isGrid ? false : expanded}
        onToggle={openCard}
        statusPill={statusPill}
        harness={s.harness}
        title={titleOf(s)}
        right={
          <>
            <PinButton sessionId={s.session_id} lang={lang} />
            {primary && <PrimaryButton primary={primary} lang={lang} onExpand={openCard} onPick={ctrl.pick} />}
            <SessionActionsMenu
              ctrl={ctrl}
              onActivate={openCard}
              extraItems={onSelect ? [{
                key: 'metrics',
                label: lang === 'pt' ? 'Métricas da sessão' : 'Session metrics',
                onClick: () => onSelect(s),
              }] : undefined}
            />
          </>
        }
        meta={meta}
        affordance={isGrid ? <Maximize2 size={15} /> : (expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />)}
      >
        {body(false)}
      </CardShell>
    </>
  )
}

function HistorySessionCard({ s, lang, onSelect, isPinned, state, viewMode }: SessionCardProps) {
  const isGrid = viewMode === 'grid'
  const [expanded, setExpanded] = useState(false)
  const modalOpen = useOpenModalSession() === s.session_id
  const setModalOpen = (open: boolean) => setOpenModalSession(open ? s.session_id : null)
  const [showResumeModal, setShowResumeModal] = useState(false)
  const status = getStatusInfo(state, isPinned)
  const time = s.start_time ? format(parseISO(s.start_time), 'MMM d, HH:mm') : ''
  const openCard = () => { if (isGrid) setModalOpen(true); else setExpanded(v => !v) }

  const statusPill = <StatusPill color={status.color} label={lang === 'pt' ? status.labelPt : status.labelEn} />
  const meta = <CardMeta s={s} lang={lang} />
  // History rows have no fleet controller, so no kebab to move "Session metrics" into — it stays a
  // footer button here (unlike the live card, which routes it through SessionActionsMenu).
  const body = () => (
    <>
      <CardChips s={s} lang={lang} />
      <CardFooterButtons s={s} lang={lang} onSelect={onSelect} onResume={() => setShowResumeModal(true)} />
    </>
  )

  return (
    <>
      {showResumeModal && <ResumeCommandModal s={s} lang={lang} onClose={() => setShowResumeModal(false)} />}
      {modalOpen && (
        <CardModal statusPill={statusPill} harness={s.harness} title={titleOf(s)} meta={meta} lang={lang} onClose={() => setModalOpen(false)}>
          {body()}
        </CardModal>
      )}
      <CardShell
        accent={status.color}
        expanded={isGrid ? false : expanded}
        onToggle={openCard}
        statusPill={statusPill}
        harness={s.harness}
        title={titleOf(s)}
        right={
          <>
            <PinButton sessionId={s.session_id} lang={lang} />
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums' }}>{time}</span>
          </>
        }
        meta={meta}
        affordance={isGrid ? <Maximize2 size={15} /> : (expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />)}
      >
        {body()}
      </CardShell>
    </>
  )
}
