import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useOutletContext } from 'react-router-dom'
import { Plus, Trash2, X, CalendarRange } from 'lucide-react'
import { fmt, fmtCost, formatProjectName, canonicalProjectPath, totalTokens, totalTokensExplained } from '@agentistics/core'
import type { AppContext } from '../lib/app-context'
import type { TokenBreakdown } from '@agentistics/core'
import { HARNESS_LABELS } from '../lib/harness'
import { Drawer } from './settings/Drawer'
import { Section, Select, TabSelect, MultiPicker } from './settings/primitives'
import { useIsMobile } from '../hooks/useIsMobile'
import { DatePicker } from '../components/DatePicker'

// /api/tags response shapes. Aggregate-only by design (spec rule 2): the server never sends the
// session rows behind a tag, so everything rendered here is a number the server already computed.
import { tagSourceTypes, type TagSourceType } from '../lib/tagSourceTypes'
import { createSharedPref } from '../lib/sharedPref'

/** SHARED: how a person reads their tags is about the work, not about the screen. */
const tagsLayoutStore = createSharedPref<'grid' | 'list'>({
  key: 'agentistics-tags-layout',
  prefKey: 'tagsLayout',
  fallback: 'grid',
  parse: raw => (raw === 'grid' || raw === 'list' ? raw : null),
})
interface TagSource { type: TagSourceType; value: string }
interface TagAggregate {
  sessions: number
  costUSD: number
  /** The two conversational counters. NOT the total — read `tokens`. */
  inputTokens: number
  outputTokens: number
  /** All four billed counters, as the server's `TagAggregate` now sends them. */
  tokens: TokenBreakdown
  topProject: string | null
  topModel: string | null
  topHarness: string | null
}
/** Optional period the tag is pinned to — inclusive `yyyy-MM-dd`, each side independent. */
interface TagWindow { start?: string; end?: string }
interface Tag {
  _id: string
  name: string
  color?: string
  sources: TagSource[]
  filters?: TagSource[]
  window?: TagWindow
  sharedWith: string[]
  createdBy: string
  aggregate: TagAggregate
}
// IAM lookups used to turn a source's opaque id into a readable label and to populate the pickers.
interface IamTeam { _id: string; name: string }
interface IamAccount { id: string; name: string; email: string }
interface IamMachine { id: string; machineName: string }

const SWATCHES: string[] = [
  '#f59e0b', '#ef4444', '#ec4899', '#a855f7',
  '#3b82f6', '#06b6d4', '#22c55e', '#84cc16',
]
// Explicit, not SWATCHES[0]: noUncheckedIndexedAccess types an index read as `string | undefined`,
// which would leak `undefined` into every consumer of the selected colour.
const DEFAULT_COLOR = '#f59e0b'
/** Mirrors LOCAL_MACHINE_ID in packages/server/server/tags-handlers.ts — the single machine a
 *  non-central instance knows about, which every local session is attributed to. */
const LOCAL_MACHINE_ID = 'local'
/** Source types that only exist where there is IAM. Hidden off a central, and refused there too. */

/** A label/value pair inside a grid card. */
function MiniStat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <span style={{ minWidth: 0 }} title={title}>
      <span style={{ display: 'block', fontSize: 9.5, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
      <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
    </span>
  )
}

/** A rounded tag-ish chip for the "top X" facts on a grid card. */
function Pill({ text }: { text: string }) {
  return (
    <span style={{
      display: 'inline-block', maxWidth: '100%', padding: '2px 8px', borderRadius: 999, fontSize: 10.5,
      background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-tertiary)',
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    }}>{text}</span>
  )
}

/** Human-readable period, e.g. "04/07/26 → 18/07/26", "desde 04/07/26", "até 18/07/26".
 *  Returns null when the tag has no period, which is what hides the chip entirely. */
function windowLabel(w: TagWindow | undefined, pt: boolean): string | null {
  if (!w || (!w.start && !w.end)) return null
  const d = (iso: string) => {
    const [y, m, day] = iso.split('-')
    return pt ? `${day}/${m}/${y?.slice(2)}` : `${m}/${day}/${y?.slice(2)}`
  }
  if (w.start && w.end) return `${d(w.start)} → ${d(w.end)}`
  if (w.start) return `${pt ? 'desde' : 'from'} ${d(w.start)}`
  return `${pt ? 'até' : 'until'} ${d(w.end!)}`
}

/** One column of the list layout. The label is always rendered so the row stays readable when it
 *  reflows to a single column on mobile, where there is no header row to name the values. */
function Cell({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <span style={{ minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 6 }}>
      <span style={{ fontSize: 9.5, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', flexShrink: 0 }}>{label}</span>
      <span style={{
        fontSize: 12.5, fontWeight: accent ? 700 : 600,
        color: accent ? 'var(--anthropic-orange)' : 'var(--text-secondary)',
        fontVariantNumeric: 'tabular-nums', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{value}</span>
    </span>
  )
}

const input: React.CSSProperties = {
  padding: '9px 11px', background: 'var(--bg-elevated)', border: '1px solid var(--border)',
  borderRadius: 7, fontSize: 13, color: 'var(--text-primary)', fontFamily: 'inherit',
  outline: 'none', width: '100%', boxSizing: 'border-box',
}
const primaryBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  padding: '0 14px', minHeight: 44, borderRadius: 7, border: '1px solid var(--anthropic-orange)',
  background: 'var(--anthropic-orange-dim)', color: 'var(--anthropic-orange)',
  fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
}
const trashBtn: React.CSSProperties = {
  border: 'none', background: 'transparent', color: '#ef4444', cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 44, height: 44, flexShrink: 0,
}

/**
 * Read a JSON response, refusing anything that is not JSON.
 *
 * The route used to 404 with the PLAIN-TEXT body "Not found" on a non-central instance, and this
 * page called `r.json()` on it unconditionally — so the page died with
 * `SyntaxError: Unexpected token 'N'` instead of showing anything. Every tags fetch goes through
 * here now: status and content-type are checked first, and a non-JSON body becomes a readable
 * message rather than a thrown parse error.
 */
async function readJson<T>(r: Response): Promise<T & { error?: string }> {
  if (!(r.headers.get('content-type') ?? '').includes('application/json')) {
    const text = (await r.text().catch(() => '')).slice(0, 200).trim()
    throw new Error(text || `HTTP ${r.status}`)
  }
  const body = await r.json().catch(() => null) as (T & { error?: string }) | null
  if (!body) throw new Error(`HTTP ${r.status}`)
  // A JSON error body is RETURNED, not thrown — the caller renders `error` itself.
  if (!r.ok && !body.error) throw new Error(`HTTP ${r.status}`)
  return body
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)' }}>{label}</span>
      {children}
    </label>
  )
}

export default function TagsPage() {
  const { lang, currency, brlRate, data, me, isCentral } = useOutletContext<AppContext>()
  const pt = lang === 'pt'
  const isMobile = useIsMobile()
  const navigate = useNavigate()
  const location = useLocation()

  const [tags, setTags] = useState<Tag[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  // IAM lookups (labels + picker options). Failures are non-fatal: the pickers just come up empty.
  const [teams, setTeams] = useState<IamTeam[]>([])
  const [accounts, setAccounts] = useState<IamAccount[]>([])
  const [machines, setMachines] = useState<IamMachine[]>([])

  const loadTags = useCallback(async () => {
    try {
      const r = await fetch('/api/tags')
      const d = await readJson<{ tags?: Tag[] }>(r)
      if (d.error) { setErr(d.error); setTags([]) } else { setErr(null); setTags(d.tags ?? []) }
    } catch (e) { setErr(errText(e)); setTags([]) } finally { setLoaded(true) }
  }, [])

  useEffect(() => { void loadTags() }, [loadTags])

  // IAM only exists on a central. Off one there is a single machine and no teams or accounts at
  // all, so the endpoints are not called (they are central-only and would answer with a non-JSON
  // 404) and the machine list is the one synthetic entry the server resolves `machine` sources to.
  useEffect(() => {
    if (!isCentral) {
      setTeams([]); setAccounts([])
      setMachines([{ id: LOCAL_MACHINE_ID, machineName: pt ? 'Esta máquina' : 'This machine' }])
      return
    }
    void (async () => {
      const [t, a, m] = await Promise.all([
        fetch('/api/iam/teams').then(r => r.ok ? r.json() as Promise<{ teams?: IamTeam[] }> : { teams: [] }).catch(() => ({ teams: [] })),
        fetch('/api/iam/accounts').then(r => r.ok ? r.json() as Promise<{ accounts?: IamAccount[] }> : { accounts: [] }).catch(() => ({ accounts: [] })),
        fetch('/api/iam/machines').then(r => r.ok ? r.json() as Promise<{ machines?: IamMachine[] }> : { machines: [] }).catch(() => ({ machines: [] })),
      ])
      setTeams(t.teams ?? []); setAccounts(a.accounts ?? []); setMachines(m.machines ?? [])
    })()
  }, [isCentral, pt])

  // repo / project options come from the data the page already has — no extra endpoint.
  const repoOptions = useMemo(() => {
    const set = new Set<string>()
    for (const s of data.sessions) if (s.git_remote) set.add(s.git_remote)
    return [...set].sort().map(v => ({ value: v, label: v }))
  }, [data.sessions])
  // Worktrees are checkouts of a project, not projects: offering them split one codebase into a
  // handful of near-identical rows. They fold into their owner, which is also what resolution does.
  const projectOptions = useMemo(() => {
    const set = new Set<string>()
    for (const s of data.sessions) if (s.project_path) set.add(canonicalProjectPath(s.project_path))
    return [...set].sort().map(v => ({ value: v, label: formatProjectName(v) }))
  }, [data.sessions])
  // Harness is a closed, known set (data.harnesses lists only harnesses actually present, per
  // the harness-selector convention elsewhere in the app). Model has no such registry — every
  // model that appears on any session is a valid option.
  const harnessOptions = useMemo(
    () => (data.harnesses ?? []).map(h => ({ value: h, label: HARNESS_LABELS[h] ?? h })),
    [data.harnesses],
  )
  const modelOptions = useMemo(() => {
    const set = new Set<string>()
    for (const s of data.sessions) if (s.model) set.add(s.model)
    return [...set].sort().map(v => ({ value: v, label: v }))
  }, [data.sessions])
  // `user` only ever has values in team mode (SessionMeta.user is unset on a solo session — see
  // tagSourceTypes.ts) — the empty list on a machine is correct, not a bug.
  const userOptions = useMemo(() => {
    const set = new Set<string>()
    for (const s of data.sessions) if (s.user) set.add(s.user)
    return [...set].sort().map(v => ({ value: v, label: v }))
  }, [data.sessions])

  /** Which repo each project belongs to, so the picker can say a path is already covered by one. */
  const repoByProject = useMemo(() => {
    const map = new Map<string, string>()
    for (const s of data.sessions) {
      if (!s.project_path || !s.git_remote) continue
      map.set(canonicalProjectPath(s.project_path), s.git_remote)
    }
    return map
  }, [data.sessions])

  const teamName = useCallback((id: string) => teams.find(t => t._id === id)?.name ?? id, [teams])
  const accountName = useCallback((id: string) => accounts.find(a => a.id === id)?.name ?? id, [accounts])
  const machineName = useCallback((id: string) => machines.find(m => m.id === id)?.machineName ?? id, [machines])

  const sourceTypeLabel = useCallback((t: TagSourceType): string => ({
    repo: pt ? 'Repositório' : 'Repository',
    project: pt ? 'Projeto' : 'Project',
    machine: pt ? 'Máquina' : 'Machine',
    team: pt ? 'Time' : 'Team',
    account: pt ? 'Conta' : 'Account',
    harness: pt ? 'Harness' : 'Harness',
    model: pt ? 'Modelo' : 'Model',
    user: pt ? 'Pessoa' : 'Person',
  }[t]), [pt])

  const sourceValueLabel = useCallback((s: TagSource) => {
    switch (s.type) {
      case 'team': return teamName(s.value)
      case 'account': return accountName(s.value)
      case 'machine': return machineName(s.value)
      case 'project': return formatProjectName(s.value)
      case 'harness': return HARNESS_LABELS[s.value as keyof typeof HARNESS_LABELS] ?? s.value
      default: return s.value
    }
  }, [teamName, accountName, machineName])

  /** Which dimensions can be picked here — see `tagSourceTypes`. */
  const sourceTypes = useMemo<TagSourceType[]>(() => tagSourceTypes(isCentral), [isCentral])

  const optionsForType = useCallback((t: TagSourceType) => {
    switch (t) {
      case 'repo': return repoOptions
      case 'project': return projectOptions
      case 'machine': return machines.map(m => ({ value: m.id, label: m.machineName }))
      case 'team': return teams.map(t2 => ({ value: t2._id, label: t2.name }))
      case 'account': return accounts.map(a => ({ value: a.id, label: `${a.name} (${a.email})` }))
      case 'harness': return harnessOptions
      case 'model': return modelOptions
      case 'user': return userOptions
      default: return []
    }
  }, [repoOptions, projectOptions, machines, teams, accounts, harnessOptions, modelOptions, userOptions])

  /** The read-only detail is a page of its own (/tags/:id) — a card click navigates there. */
  const openDetail = useCallback((id: string) => {
    navigate(`/tags/${encodeURIComponent(id)}`)
  }, [navigate])

  // editor drawer (create + edit share one form)
  const [editorOpen, setEditorOpen] = useState(false)
  // Grid (compact cards) vs list (dense rows with more metrics). Persisted across reloads.
  const [layout, setLayout] = useState<'grid' | 'list'>(() => {
    try { return tagsLayoutStore.get() === 'list' ? 'list' : 'grid' } catch { return 'grid' }
  })
  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [color, setColor] = useState(DEFAULT_COLOR)
  const [sources, setSources] = useState<TagSource[]>([])
  /** Narrowing applied on top of the union: OR within a type, AND across types. */
  const [filters, setFilters] = useState<TagSource[]>([])
  const [filterType, setFilterType] = useState<TagSourceType>('project')
  const [filtersEditing, setFiltersEditing] = useState(true)
  /** The period the tag is pinned to. Empty string = that end is open. */
  const [winStart, setWinStart] = useState('')
  const [winEnd, setWinEnd] = useState('')
  const [windowEditing, setWindowEditing] = useState(true)
  // True when the chosen colour is not one of the presets — drives the custom circle's ring.
  const isCustomColor = !SWATCHES.some(c => c.toLowerCase() === color.toLowerCase())
  const [sharedWith, setSharedWith] = useState<string[]>([])
  const [draftType, setDraftType] = useState<TagSourceType>('repo')
  const [draftValue, setDraftValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState<string | null>(null)
  const [sourcesEditing, setSourcesEditing] = useState(true)
  const [shareEditing, setShareEditing] = useState(true)

  const openCreate = useCallback(() => {
    setEditingId(null); setName(''); setColor(DEFAULT_COLOR); setSources([]); setFilters([]); setSharedWith([])
    setWinStart(''); setWinEnd('')
    setDraftType('repo'); setDraftValue(''); setSaveErr(null)
    setSourcesEditing(true); setShareEditing(true); setWindowEditing(true)
    setEditorOpen(true)
  }, [])

  const openEdit = useCallback((t: Tag) => {
    setEditingId(t._id); setName(t.name); setColor(t.color || DEFAULT_COLOR)
    setSources(t.sources); setFilters(t.filters ?? []); setSharedWith(t.sharedWith)
    setWinStart(t.window?.start ?? ''); setWinEnd(t.window?.end ?? '')
    setDraftType('repo'); setDraftValue(''); setSaveErr(null)
    setSourcesEditing(true); setShareEditing(true); setWindowEditing(true)
    setEditorOpen(true)
  }, [])

  // The Drawer's unsaved-changes guard: anything typed or added counts as dirty.
  const original = editingId ? tags.find(t => t._id === editingId) : undefined
  const dirty = editingId
    ? !!original && (
      name.trim() !== original.name
      || color !== (original.color || DEFAULT_COLOR)
      || JSON.stringify(sources) !== JSON.stringify(original.sources)
      || JSON.stringify(filters) !== JSON.stringify(original.filters ?? [])
      || winStart !== (original.window?.start ?? '')
      || winEnd !== (original.window?.end ?? '')
      || JSON.stringify([...sharedWith].sort()) !== JSON.stringify([...original.sharedWith].sort())
    )
    : name.trim().length > 0 || sources.length > 0 || !!winStart || !!winEnd

  /** Commit a picked value as a source. Called straight from the value Select's onChange so a
   *  single click adds it — the old two-step (pick, then press "Add") silently dropped the pick
   *  when the user pressed Done instead, saving a tag with no sources at all. */
  /** Adding a repo supersedes any project already picked from inside it. Blocking the project
   *  picker only covers picking them in one order; picking the project first and the repo second
   *  produced exactly the double-counted breakdown this is meant to prevent. */
  const dropCoveredProjects = useCallback((list: TagSource[]): TagSource[] => {
    const repos = new Set(list.filter(s => s.type === 'repo').map(s => s.value))
    if (repos.size === 0) return list
    return list.filter(s => {
      if (s.type !== 'project') return true
      const remote = repoByProject.get(canonicalProjectPath(s.value))
      return !remote || !repos.has(remote)
    })
  }, [repoByProject])

  const addSource = (value: string) => {
    if (!value) return
    setDraftValue('')
    if (sources.some(s => s.type === draftType && s.value === value)) return
    setSources(prev => dropCoveredProjects([...prev, { type: draftType, value }]))
  }

  /** Repos already picked as sources — a project inside one of them is redundant. */
  const pickedRepos = useMemo(
    () => new Set(sources.filter(s => s.type === 'repo').map(s => s.value)),
    [sources],
  )

  /** Options of the current type that are not already sources — shared by both pickers so neither
   *  can offer a duplicate. A project whose repo is already a source stays visible but disabled:
   *  adding both counted the same sessions twice in the per-source breakdown, and hiding it
   *  silently would read as "that project does not exist". */
  const availableOptions = useMemo(
    () => optionsForType(draftType)
      .filter(o => !sources.some(s => s.type === draftType && s.value === o.value))
      .map(o => {
        if (draftType !== 'project') return o
        const remote = repoByProject.get(o.value)
        if (!remote || !pickedRepos.has(remote)) return o
        return {
          ...o,
          disabled: true,
          hint: pt ? `já coberto por ${remote}` : `already covered by ${remote}`,
        }
      }),
    [optionsForType, draftType, sources, repoByProject, pickedRepos, pt],
  )
  /** Commit every checked value at once. */
  /** Values offered for the filter picker: same catalogue as sources, minus what is already a
   *  filter of that type. A filter can name anything — narrowing to a project OUTSIDE the tag's
   *  repos simply yields nothing, which is the honest result rather than a hidden option. */
  const filterOptions = useMemo(
    () => optionsForType(filterType).filter(o => !filters.some(f => f.type === filterType && f.value === o.value)),
    [optionsForType, filterType, filters],
  )

  const addPickedFilters = (values: string[]) => {
    setFilters(prev => [
      ...prev,
      ...values
        .filter(v => !prev.some(f => f.type === filterType && f.value === v))
        .map(v => ({ type: filterType, value: v })),
    ])
  }

  const addPickedSources = (values: string[]) => {
    setSources(prev => dropCoveredProjects([
      ...prev,
      ...values
        .filter(v => !prev.some(s => s.type === draftType && s.value === v))
        .map(v => ({ type: draftType, value: v })),
    ]))
  }

  const save = async () => {
    if (!name.trim()) { setSaveErr(pt ? 'Informe um nome.' : 'A name is required.'); return }
    // Caught here as well as server-side: an inverted period is the one mistake a date pair invites,
    // and a 400 after pressing Save reads as a bug rather than as a correction.
    if (winStart && winEnd && winStart > winEnd) {
      setSaveErr(pt ? 'A data inicial não pode ser depois da final.' : 'The start date cannot be after the end date.')
      return
    }
    setSaving(true); setSaveErr(null)
    try {
      // Always SENT, even when empty: `null` is how the server is told the period was removed,
      // whereas omitting the field means "leave whatever is stored alone".
      const window = winStart || winEnd
        ? { ...(winStart ? { start: winStart } : {}), ...(winEnd ? { end: winEnd } : {}) }
        : null
      const body = { id: editingId ?? undefined, name: name.trim(), color, sources, filters, window, sharedWith }
      const res = await fetch('/api/tags', {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await readJson<{ error?: string }>(res)
      if (!res.ok || d.error) { setSaveErr(d.error ?? `HTTP ${res.status}`); return }
      setEditorOpen(false)
      await loadTags()
    } catch (e) { setSaveErr(errText(e)) } finally { setSaving(false) }
  }

  // Anyone signed in may create a tag; what differs is the REACH, enforced server-side by
  // canWriteTagSources — owner: anything, manager: what their teams reach, user: what their own
  // account owns. Hiding the button from a plain user would block "tag my own machines" while
  // adding no protection, since the source check already refuses everything else.
  // Off a central nobody signs in at all (there is one user), so `me` is absent and writing is
  // always allowed — the server runs those requests as a single-user owner.
  const mayWrite = !isCentral || !!me

  // The detail page's pencil navigates back here carrying the tag to edit. Open the editor once the
  // list has loaded, then clear the history state so a reload does not reopen it.
  const editTagId = (location.state as { editTagId?: string } | null)?.editTagId
  useEffect(() => {
    if (!editTagId || !loaded) return
    const t = tags.find(x => x._id === editTagId)
    if (t) openEdit(t)
    navigate('/tags', { replace: true, state: null })
  }, [editTagId, loaded, tags, openEdit, navigate])

  // "Create tag with these filters" (the FiltersBar button, see filtersToTag.ts) hands off a
  // precomputed draft via router state exactly the way the detail page's pencil hands off
  // `editTagId` above — same mechanism, opens the SAME drawer, so central-only sections (sharing,
  // etc.) show up for free. Does not wait on `loaded`: unlike editing, there is no existing tag to
  // find first.
  const draftFromFilters = (location.state as { draftFromFilters?: { sources: TagSource[]; filters: TagSource[]; window?: TagWindow } } | null)?.draftFromFilters
  useEffect(() => {
    if (!draftFromFilters) return
    openCreate()
    setSources(draftFromFilters.sources)
    setFilters(draftFromFilters.filters)
    setWinStart(draftFromFilters.window?.start ?? '')
    setWinEnd(draftFromFilters.window?.end ?? '')
    navigate('/tags', { replace: true, state: null })
  }, [draftFromFilters, openCreate, navigate])

  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 12, flexWrap: 'wrap', margin: '0 0 18px',
      }}>
        <div style={{ minWidth: 0 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>Tags</h1>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4 }}>
            {isCentral
              ? (pt
                ? 'Agrupamentos salvos de repositórios, projetos, máquinas, times e contas.'
                : 'Saved groupings of repositories, projects, machines, teams and accounts.')
              : (pt
                ? 'Agrupamentos salvos de repositórios e projetos desta máquina.'
                : 'Saved groupings of this machine’s repositories and projects.')}
          </div>
        </div>
        {mayWrite && (
          <button type="button" onClick={openCreate} style={{ ...primaryBtn, width: isMobile ? '100%' : undefined }}>
            <Plus size={14} /> {pt ? 'Nova tag' : 'New tag'}
          </button>
        )}
      </div>

      {err && <div style={{ fontSize: 12.5, color: '#ef4444', marginBottom: 14 }}>{err}</div>}

      {loaded && !err && tags.length === 0 && (
        <div style={{
          border: '1px dashed var(--border)', borderRadius: 12, padding: 24,
          fontSize: 12.5, color: 'var(--text-tertiary)', textAlign: 'center',
        }}>
          {pt ? 'Nenhuma tag ainda.' : 'No tags yet.'}
        </div>
      )}

      {/* Grid = compact cards (6 facts). List = a dense row per tag (10 facts) using the horizontal
          room a card does not have. The choice persists so it survives a reload. */}
      {tags.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
          <TabSelect
            value={layout}
            onChange={v => { setLayout(v); try { tagsLayoutStore.set(v) } catch { /* ignore */ } }}
            options={[
              { value: 'grid', label: pt ? 'Grade' : 'Grid' },
              { value: 'list', label: pt ? 'Lista' : 'List' },
            ]}
          />
        </div>
      )}

      {layout === 'grid' ? (
        <div className="ag-grid cols-3">
          {tags.map(t => (
            <button
              key={t._id}
              type="button"
              onClick={() => void openDetail(t._id)}
              style={{
                border: '1px solid var(--border)', borderRadius: 12, background: 'var(--bg-card)',
                padding: 16, display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0,
                textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span style={{
                  width: 10, height: 10, borderRadius: '50%',
                  background: t.color || 'var(--anthropic-orange)', flexShrink: 0,
                }} />
                <span style={{
                  fontSize: 14, fontWeight: 700, color: 'var(--text-primary)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{t.name}</span>
                <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--text-tertiary)', flexShrink: 0 }}>
                  {t.sources.length} {t.sources.length === 1 ? (pt ? 'fonte' : 'source') : (pt ? 'fontes' : 'sources')}
                </span>
              </div>
              {/* Without this the card is unexplainable: two tags over the same sources, one
                  pinned to a period, are otherwise identical and show different money. */}
              {windowLabel(t.window, pt) && (
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4, alignSelf: 'flex-start',
                  padding: '2px 8px', borderRadius: 999, fontSize: 10.5,
                  background: 'var(--anthropic-orange-dim)', border: '1px solid rgba(217,119,6,0.35)',
                  color: 'var(--anthropic-orange)', fontVariantNumeric: 'tabular-nums',
                }}>
                  <CalendarRange size={11} />
                  {windowLabel(t.window, pt)}
                </span>
              )}
              <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--anthropic-orange)', wordBreak: 'break-word' }}>
                {fmtCost(t.aggregate.costUSD, currency, brlRate)}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 10px' }}>
                <MiniStat label={pt ? 'Sessões' : 'Sessions'} value={t.aggregate.sessions.toLocaleString()} />
                <MiniStat label="Tokens" value={fmt(totalTokens(t.aggregate.tokens))} title={totalTokensExplained(t.aggregate.tokens, pt ? 'pt' : 'en')} />
                <MiniStat label={pt ? 'Entrada' : 'Input'} value={fmt(t.aggregate.inputTokens)} />
                <MiniStat label={pt ? 'Saída' : 'Output'} value={fmt(t.aggregate.outputTokens)} />
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 2 }}>
                {/* The project pill is a filesystem path. On a MACHINE that is meaningful — you
                    recognise your own folder. On a CENTRAL it is some other machine's local path,
                    which identifies nothing about the tag, so it is omitted there. Same rule the
                    repositories view already follows. */}
                {!isCentral && t.aggregate.topProject && <Pill text={`${pt ? 'Projeto' : 'Project'}: ${formatProjectName(t.aggregate.topProject)}`} />}
                {t.aggregate.topModel && <Pill text={`${pt ? 'Modelo' : 'Model'}: ${t.aggregate.topModel}`} />}
                {t.aggregate.topHarness && <Pill text={`Harness: ${HARNESS_LABELS[t.aggregate.topHarness as keyof typeof HARNESS_LABELS] ?? t.aggregate.topHarness}`} />}
              </div>
            </button>
          ))}
        </div>
      ) : (
        <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
          {tags.map((t, i) => (
            <button
              key={t._id}
              type="button"
              onClick={() => void openDetail(t._id)}
              style={{
                display: 'grid',
                gridTemplateColumns: isMobile ? '1fr' : 'minmax(140px, 1.4fr) repeat(4, minmax(70px, 0.8fr)) minmax(110px, 1.2fr) minmax(90px, 1fr) minmax(70px, 0.7fr) minmax(60px, 0.6fr)',
                gap: isMobile ? 6 : 12, alignItems: 'center', width: '100%',
                padding: isMobile ? '12px 14px' : '11px 14px', minHeight: 48,
                background: 'var(--bg-card)', border: 'none',
                borderTop: i === 0 ? 'none' : '1px solid var(--border-subtle)',
                textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: t.color || 'var(--anthropic-orange)', flexShrink: 0 }} />
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
                {windowLabel(t.window, pt) && (
                  <span
                    title={windowLabel(t.window, pt)!}
                    style={{
                      display: 'inline-flex', alignItems: 'center', flexShrink: 0,
                      color: 'var(--anthropic-orange)', opacity: 0.85,
                    }}
                  >
                    <CalendarRange size={12} />
                  </span>
                )}
              </span>
              <Cell label={pt ? 'Custo' : 'Cost'} value={fmtCost(t.aggregate.costUSD, currency, brlRate)} accent />
              <Cell label={pt ? 'Sessões' : 'Sessions'} value={t.aggregate.sessions.toLocaleString()} />
              <Cell label={pt ? 'Entrada' : 'Input'} value={fmt(t.aggregate.inputTokens)} />
              <Cell label={pt ? 'Saída' : 'Output'} value={fmt(t.aggregate.outputTokens)} />
              {!isCentral && <Cell label={pt ? 'Projeto' : 'Project'} value={t.aggregate.topProject ? formatProjectName(t.aggregate.topProject) : '—'} />}
              <Cell label={pt ? 'Modelo' : 'Model'} value={t.aggregate.topModel ?? '—'} />
              <Cell label="Harness" value={t.aggregate.topHarness ? (HARNESS_LABELS[t.aggregate.topHarness as keyof typeof HARNESS_LABELS] ?? t.aggregate.topHarness) : '—'} />
              <Cell label={pt ? 'Fontes' : 'Sources'} value={String(t.sources.length)} />
            </button>
          ))}
        </div>
      )}

      {/* ---- create / edit ---- */}
      <Drawer
        open={editorOpen}
        title={editingId ? (pt ? 'Editar tag' : 'Edit tag') : (pt ? 'Nova tag' : 'New tag')}
        onClose={() => setEditorOpen(false)}
        lang={lang}
        dirty={dirty}
        footer={
          <button type="button" style={{ ...primaryBtn, opacity: saving ? 0.6 : 1 }} disabled={saving} onClick={() => void save()}>
            {saving ? (pt ? 'Salvando…' : 'Saving…') : (pt ? 'Salvar' : 'Save')}
          </button>
        }
      >
        {saveErr && <div style={{ fontSize: 12.5, color: '#ef4444' }}>{saveErr}</div>}

        <Field label={pt ? 'Nome' : 'Name'}>
          <input
            style={input}
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={pt ? 'Cliente X' : 'Client X'}
          />
        </Field>

        {/* Colour picker: bare circles with a selection RING rather than boxed squares — the boxes
            competed with the swatch for attention and read as disabled buttons. Each circle keeps a
            44px hit area while drawing at 26px, so touch targets survive without visual bulk. The
            ring is drawn with two stacked box-shadows (a gap in the card background, then the
            colour), the same treatment the rest of the app uses for focus affordances. */}
        <Field label={pt ? 'Cor' : 'Colour'}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2 }}>
            {SWATCHES.map(c => {
              const selected = color.toLowerCase() === c.toLowerCase()
              return (
                <button
                  key={c}
                  type="button"
                  aria-label={c}
                  aria-pressed={selected}
                  onClick={() => setColor(c)}
                  style={{
                    width: 44, height: 44, padding: 0, border: 'none', background: 'transparent',
                    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  <span style={{
                    width: 26, height: 26, borderRadius: '50%', background: c, display: 'block',
                    boxShadow: selected ? `0 0 0 3px var(--bg-card), 0 0 0 5px ${c}` : 'none',
                    transition: 'box-shadow 0.15s, transform 0.15s',
                    transform: selected ? 'scale(1)' : 'scale(0.92)',
                  }} />
                </button>
              )
            })}

            <span style={{ width: 1, height: 22, background: 'var(--border)', margin: '0 6px', flexShrink: 0 }} />

            {/* Custom colour. The native input is the only control giving a full gamut without
                shipping a picker; it is kept invisible over a styled circle so the row stays
                consistent instead of showing the OS swatch chrome. */}
            <label
              title={pt ? 'Cor personalizada' : 'Custom colour'}
              style={{
                width: 44, height: 44, cursor: 'pointer', position: 'relative',
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}
            >
              <span style={{
                width: 26, height: 26, borderRadius: '50%', display: 'block',
                background: 'conic-gradient(#ef4444, #f59e0b, #84cc16, #22c55e, #06b6d4, #3b82f6, #a855f7, #ec4899, #ef4444)',
                boxShadow: isCustomColor ? `0 0 0 3px var(--bg-card), 0 0 0 5px ${color}` : 'none',
                transition: 'box-shadow 0.15s, transform 0.15s',
                transform: isCustomColor ? 'scale(1)' : 'scale(0.92)',
              }} />
              <input
                type="color"
                value={color}
                onChange={e => setColor(e.target.value)}
                style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
              />
            </label>

            {/* Live readout so the chosen value is legible and copyable, mono like the rest of the
                app's identifier chips. */}
            <span style={{
              marginLeft: 4, padding: '3px 9px', borderRadius: 999, flexShrink: 0,
              background: `color-mix(in srgb, ${color} 14%, transparent)`,
              border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`,
              color, fontSize: 11, fontWeight: 600,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', textTransform: 'uppercase',
            }}>{color}</span>
          </div>
        </Field>

        <Section
          title={pt ? 'Fontes' : 'Sources'}
          editing={sourcesEditing}
          onEdit={() => setSourcesEditing(true)}
          onCancel={() => setSourcesEditing(false)}
          onSave={() => setSourcesEditing(false)}
          hideActions
          labels={{ edit: pt ? 'Editar' : 'Edit', save: pt ? 'Pronto' : 'Done', cancel: pt ? 'Fechar' : 'Close' }}
          editChildren={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
                {isCentral
                  ? (pt
                    ? 'A tag reúne as sessões de qualquer uma das fontes (união). Time e conta resolvem dinamicamente.'
                    : 'The tag covers sessions matching any of its sources (union). Team and account resolve dynamically.')
                  : (pt
                    ? 'A tag reúne as sessões de qualquer uma das fontes (união).'
                    : 'The tag covers sessions matching any of its sources (union).')}
              </div>
              <Field label={pt ? 'Tipo' : 'Type'}>
                <Select
                  value={draftType}
                  onChange={v => { setDraftType(v as TagSourceType); setDraftValue('') }}
                  options={sourceTypes.map(t => ({ value: t, label: sourceTypeLabel(t) }))}
                />
              </Field>
              {/* One control for both cases: opening it gives search plus checkboxes, so the user
                  decides after seeing the list whether they wanted one item or several. The old
                  pairing of a single-value Select with a separate "several" button forced that
                  decision before the list was even visible. */}
              <Field label={pt ? 'Valor' : 'Value'}>
                <MultiPicker
                  options={availableOptions}
                  onCommit={addPickedSources}
                  placeholder={pt ? 'Buscar e selecionar…' : 'Search and select…'}
                  searchPlaceholder={pt ? 'Buscar…' : 'Search…'}
                  confirmLabel={n => (pt ? `Adicionar ${n}` : `Add ${n}`)}
                  selectAllLabel={pt ? 'Selecionar tudo' : 'Select all'}
                  emptyLabel={pt ? 'Nada disponível.' : 'Nothing available.'}
                  disabled={availableOptions.length === 0}
                />
              </Field>
              <SourceList
                sources={sources}
                typeLabel={sourceTypeLabel}
                valueLabel={sourceValueLabel}
                emptyLabel={pt ? 'Nenhuma fonte adicionada.' : 'No sources added.'}
                onRemove={i => setSources(prev => prev.filter((_, j) => j !== i))}
              />
            </div>
          }
        >
          <SourceList
            sources={sources}
            typeLabel={sourceTypeLabel}
            valueLabel={sourceValueLabel}
            emptyLabel={pt ? 'Nenhuma fonte adicionada.' : 'No sources added.'}
          />
        </Section>

        {/* Narrowing only means something once there is a union to narrow: with no sources the tag
            covers nothing, and a filter would be a control that cannot change any number. */}
        {sources.length > 0 && (
        <Section
          title={pt ? 'Restringir a' : 'Restrict to'}
          editing={filtersEditing}
          onEdit={() => setFiltersEditing(true)}
          onCancel={() => setFiltersEditing(false)}
          onSave={() => setFiltersEditing(false)}
          hideActions
          labels={{ edit: pt ? 'Editar' : 'Edit', save: pt ? 'Pronto' : 'Done', cancel: pt ? 'Fechar' : 'Close' }}
          editChildren={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
                {pt
                  ? 'Opcional. Estreita a tag sem ampliá-la: dentro de um mesmo tipo vale QUALQUER um, e entre tipos vale TODOS. Ex.: contas A e B + projetos C e D = só o que A ou B fizeram, e só em C ou D.'
                  : 'Optional. Narrows the tag without widening it: within one type ANY value counts, across types ALL must. E.g. accounts A and B + projects C and D = only what A or B did, and only in C or D.'}
              </div>
              <Field label={pt ? 'Tipo' : 'Type'}>
                <Select
                  value={filterType}
                  onChange={v => setFilterType(v as TagSourceType)}
                  options={sourceTypes.map(t => ({ value: t, label: sourceTypeLabel(t) }))}
                />
              </Field>
              <Field label={pt ? 'Valor' : 'Value'}>
                <MultiPicker
                  options={filterOptions}
                  onCommit={addPickedFilters}
                  placeholder={pt ? 'Buscar e selecionar…' : 'Search and select…'}
                  searchPlaceholder={pt ? 'Buscar…' : 'Search…'}
                  confirmLabel={n => (pt ? `Adicionar ${n}` : `Add ${n}`)}
                  selectAllLabel={pt ? 'Selecionar tudo' : 'Select all'}
                  emptyLabel={pt ? 'Nada disponível.' : 'Nothing available.'}
                  disabled={filterOptions.length === 0}
                />
              </Field>
              <SourceList
                sources={filters}
                typeLabel={sourceTypeLabel}
                valueLabel={sourceValueLabel}
                emptyLabel={pt ? 'Sem restrição — a tag cobre tudo das fontes.' : 'No restriction — the tag covers everything from its sources.'}
                onRemove={i => setFilters(prev => prev.filter((_, j) => j !== i))}
              />
            </div>
          }
        >
          <SourceList
            sources={filters}
            typeLabel={sourceTypeLabel}
            valueLabel={sourceValueLabel}
            emptyLabel={pt ? 'Sem restrição — a tag cobre tudo das fontes.' : 'No restriction — the tag covers everything from its sources.'}
          />
        </Section>
        )}

        {/* A period turns the tag from "these sources" into "these sources, during that run" —
            the shape of question a tag is actually asked ("I tried harness X on this project from
            the 4th to the 18th; what did it cost?"). Unlike the global date filter it belongs to
            the tag, so the number is the same for everyone who opens it. */}
        <Section
          title={pt ? 'Período' : 'Period'}
          editing={windowEditing}
          onEdit={() => setWindowEditing(true)}
          onCancel={() => setWindowEditing(false)}
          onSave={() => setWindowEditing(false)}
          hideActions
          labels={{ edit: pt ? 'Editar' : 'Edit', save: pt ? 'Pronto' : 'Done', cancel: pt ? 'Fechar' : 'Close' }}
          editChildren={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
                {pt
                  ? 'Opcional. Prende a tag a um intervalo — as duas datas entram na conta. Deixe um lado em branco para "a partir de" ou "até". Sem período, a tag cobre todo o histórico.'
                  : 'Optional. Pins the tag to a range — both dates are included. Leave one side blank for "from" or "until". With no period the tag covers the whole history.'}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 2, minHeight: 44, padding: '0 4px',
                  background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 7,
                }}>
                  <DatePicker
                    value={winStart}
                    onChange={setWinStart}
                    label={pt ? 'De' : 'From'}
                    placeholder="DD/MM/YY"
                    max={winEnd || undefined}
                    rangeStart={winStart}
                    rangeEnd={winEnd}
                    lang={lang}
                  />
                  <div style={{ width: 14, height: 1, background: 'var(--border)', flexShrink: 0 }} />
                  <DatePicker
                    value={winEnd}
                    onChange={setWinEnd}
                    label={pt ? 'Até' : 'To'}
                    placeholder="DD/MM/YY"
                    min={winStart || undefined}
                    rangeStart={winStart}
                    rangeEnd={winEnd}
                    lang={lang}
                    align="right"
                  />
                </div>
                {(winStart || winEnd) && (
                  <button
                    type="button"
                    onClick={() => { setWinStart(''); setWinEnd('') }}
                    style={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                      minHeight: 44, padding: '0 12px', borderRadius: 7,
                      border: '1px solid var(--border)', background: 'transparent',
                      color: 'var(--text-tertiary)', fontSize: 12, fontFamily: 'inherit', cursor: 'pointer',
                    }}
                  >
                    <X size={13} />
                    {pt ? 'Limpar' : 'Clear'}
                  </button>
                )}
              </div>
            </div>
          }
        >
          <div style={{ fontSize: 12.5, color: windowLabel({ start: winStart, end: winEnd }, pt) ? 'var(--text-secondary)' : 'var(--text-tertiary)' }}>
            {windowLabel({ start: winStart, end: winEnd }, pt)
              ?? (pt ? 'Todo o histórico.' : 'The whole history.')}
          </div>
        </Section>

        {/* Sharing is an IAM act — it grants a tag's numbers to another ACCOUNT. Off a central
            there are no other accounts, so the whole section is hidden (and the server ignores
            `sharedWith` there) rather than shown as a control that can never do anything. */}
        {isCentral && (
        <Section
          title={pt ? 'Compartilhar com' : 'Share with'}
          editing={shareEditing}
          onEdit={() => setShareEditing(true)}
          onCancel={() => setShareEditing(false)}
          onSave={() => setShareEditing(false)}
          hideActions
          labels={{ edit: pt ? 'Editar' : 'Edit', save: pt ? 'Pronto' : 'Done', cancel: pt ? 'Fechar' : 'Close' }}
          editChildren={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
                {pt
                  ? 'Quem receber a tag vê os números completos dela. Owners e o criador já têm acesso.'
                  : 'Anyone granted the tag sees its full numbers. Owners and the creator already have access.'}
              </div>
              {accounts.length === 0 && (
                <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>
                  {pt ? 'Nenhuma conta disponível.' : 'No accounts available.'}
                </div>
              )}
              {/* Type-to-filter picker rather than a checkbox list: on a central with many accounts
                  the list is unscannable, and picking adds immediately (same one-click rule as
                  sources). Granted accounts show as removable chips below. */}
              {accounts.length > 0 && (
                <Field label={pt ? 'Adicionar conta' : 'Add account'}>
                  <MultiPicker
                    options={accounts
                      .filter(a => a.id !== me?.id && !sharedWith.includes(a.id))
                      .map(a => ({ value: a.id, label: `${a.name} (${a.email})` }))}
                    onCommit={ids => setSharedWith(prev => [...prev, ...ids.filter(id => !prev.includes(id))])}
                    placeholder={pt ? 'Buscar e selecionar…' : 'Search and select…'}
                    searchPlaceholder={pt ? 'Buscar…' : 'Search…'}
                    confirmLabel={n => (pt ? `Adicionar ${n}` : `Add ${n}`)}
                    selectAllLabel={pt ? 'Selecionar tudo' : 'Select all'}
                    emptyLabel={pt ? 'Nenhuma conta disponível.' : 'No accounts available.'}
                  />
                </Field>
              )}
              {sharedWith.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {sharedWith.map(id => {
                    const a = accounts.find(x => x.id === id)
                    return (
                      <span key={id} style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 8px 5px 10px',
                        borderRadius: 999, fontSize: 11.5, background: 'var(--bg-elevated)',
                        border: '1px solid var(--border)', color: 'var(--text-secondary)',
                      }}>
                        {a ? a.name : id}
                        <button
                          type="button"
                          onClick={() => setSharedWith(prev => prev.filter(x => x !== id))}
                          aria-label={pt ? 'Remover' : 'Remove'}
                          style={{ border: 'none', background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer', display: 'inline-flex', padding: 2 }}
                        >
                          <X size={12} />
                        </button>
                      </span>
                    )
                  })}
                </div>
              )}
            </div>
          }
        >
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
            {sharedWith.length === 0
              ? (pt ? 'Somente você e os owners.' : 'Only you and the owners.')
              : sharedWith.map(accountName).join(', ')}
          </div>
        </Section>
        )}
      </Drawer>
    </div>
  )
}

/** Committed source list; rows are removable only when `onRemove` is given (edit mode). */
function SourceList({ sources, typeLabel, valueLabel, emptyLabel, onRemove }: {
  sources: TagSource[]
  typeLabel: (t: TagSourceType) => string
  valueLabel: (s: TagSource) => string
  emptyLabel: string
  onRemove?: (index: number) => void
}) {
  if (sources.length === 0) {
    return <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>{emptyLabel}</div>
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {sources.map((s, i) => (
        <div key={`${s.type}:${s.value}:${i}`} style={{
          display: 'flex', alignItems: 'center', gap: 8, minWidth: 0,
          border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '4px 4px 4px 10px',
        }}>
          <span style={{
            fontSize: 10.5, fontWeight: 700, color: 'var(--text-tertiary)',
            textTransform: 'uppercase', letterSpacing: '0.05em', flexShrink: 0,
          }}>{typeLabel(s.type)}</span>
          <span style={{
            fontSize: 12.5, color: 'var(--text-primary)', minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
          }}>{valueLabel(s)}</span>
          {onRemove && (
            <button type="button" style={trashBtn} aria-label="Remove" onClick={() => onRemove(i)}>
              <Trash2 size={14} />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
