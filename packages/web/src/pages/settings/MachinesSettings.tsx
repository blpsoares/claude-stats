import React, { useState, useEffect, useCallback } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Plus, Copy, Check, RotateCw, Trash2, Pencil, X, Loader2, MonitorSmartphone } from 'lucide-react'
import type { AppContext } from '../../lib/app-context'
import { ConnectionsPanel } from '../../components/team/ConnectionsPanel'
import { SectionHeader, Section, Select, Checkbox, ConfirmModal, RecordCard, RecordCardAction, SaveBar, runSaveSteps } from './primitives'
import { Drawer } from './Drawer'
import { useIsMobile } from '../../hooks/useIsMobile'
import { machineConsentView } from './machineConsentView'
import { MachineFleetDrawer } from './MachineFleetDrawer'
import { ToggleSwitch } from '../../components/ToggleSwitch'
import { OVERLAY_TOP } from '../../lib/mobileOverlay'

// interfaces
interface MachineInfo {
  id: string
  machineName: string
  user: string
  teamId?: string
  teamIds?: string[]
  accountId?: string
  accountIds?: string[]
  /**
   * The accounts allowed to reach this machine's SESSIONS.
   *
   * The server sends it ONLY to a principal who may change it (the machine's owner), so its
   * PRESENCE is the permission signal — absent means "you may not grant here", and the switches
   * are withheld rather than drawn disabled. See `@agentistics/core/machineSessions`.
   */
  sessionAccountIds?: string[]
  accountName?: string
  accountEmail?: string
  owners?: { id: string; name: string; email: string }[]
  createdAt: string
  lastSeenAt: string | null
  online?: boolean
  latencyMs?: number | null
  /**
   * What this machine has announced about session management from here — present ONLY when the
   * viewer is one of the machine's own accounts (`machineOwnedBy` server-side), which is narrower
   * than the `canManageMachine` that decided the row is visible at all.
   *
   * `undefined` (may not ask) and `null` (has not said) are DIFFERENT and both meaningful; see
   * `machineConsentView`.
   */
  remoteConsent?: { sessions: boolean; screens: boolean; atMs: number } | null
}

interface PublicAccount {
  id: string
  name: string
  email: string
  role: 'owner' | 'member'
  memberships: { teamId: string; role: 'manager' | 'user' }[]
}

interface Team {
  _id: string
  name: string
}

// shared inline styles
const input: React.CSSProperties = {
  padding: '9px 11px', background: 'var(--bg-elevated)', border: '1px solid var(--border)',
  borderRadius: 7, fontSize: 13, color: 'var(--text-primary)', fontFamily: 'inherit',
  outline: 'none', width: '100%', boxSizing: 'border-box',
}
const primaryBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  padding: '8px 14px', borderRadius: 7, border: '1px solid var(--anthropic-orange)',
  background: 'var(--anthropic-orange-dim)', color: 'var(--anthropic-orange)',
  fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
}
const ghostBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 7,
  border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)',
  fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
}
const th: React.CSSProperties = {
  textAlign: 'left', fontSize: 10.5, fontWeight: 700, color: 'var(--text-tertiary)',
  letterSpacing: '0.06em', textTransform: 'uppercase', padding: '0 10px 8px', whiteSpace: 'nowrap',
}
const td: React.CSSProperties = {
  fontSize: 12.5, color: 'var(--text-secondary)', padding: '9px 10px',
  borderTop: '1px solid var(--border-subtle)', verticalAlign: 'middle',
}
const trashBtn: React.CSSProperties = {
  border: 'none', background: 'transparent', color: '#ef4444', cursor: 'pointer',
  display: 'inline-flex', padding: 4,
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)' }}>{label}</span>
      {children}
    </label>
  )
}

// Read-only labelled value used in the read-first drawer sections.
function ReadField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
      <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>{value}</span>
    </div>
  )
}

// solo/member fallback — the second (easily-missed) `ConnectionsPanel` call site (Task 10).
function SoloMemberMachinesView({ pt }: { pt: boolean }) {
  const ctx = useOutletContext<AppContext>()

  return (
    <>
      <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6, margin: '0 0 18px' }}>
        {pt
          ? 'Máquinas de membros registradas — tokens, presença, rotação e revogação.'
          : 'Registered member machines — tokens, presence, rotate/revoke.'}
      </p>
      <ConnectionsPanel sessions={ctx.data.sessions} projects={ctx.data.projects} modelUsage={ctx.data.statsCache.modelUsage} lang={pt ? 'pt' : 'en'} onConnectionsChanged={ctx.refreshDeniedRepoLabels} />
    </>
  )
}

// central machines governance
function CentralMachinesView({ pt }: { pt: boolean }) {
  const { me } = useOutletContext<AppContext>()
  const isMobile = useIsMobile()
  const [machines, setMachines] = useState<MachineInfo[]>([])
  const [accounts, setAccounts] = useState<PublicAccount[]>([])
  const [teams, setTeams] = useState<Team[]>([])
  const [err, setErr] = useState<string | null>(null)

  // Add machine drawer state
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [machineRows, setMachineRows] = useState<{ name: string; teamIds: string[]; accountIds: string[] }[]>([{ name: '', teamIds: [], accountIds: [] }])
  const [drawerErr, setDrawerErr] = useState<string | null>(null)
  const [created, setCreated] = useState<null | { machines: { name: string; token: string }[] }>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [copyFailed, setCopyFailed] = useState<string | null>(null)

  // Rotate state.
  // `rotateConfirmId` gates the act (a rotation invalidates the token the machine is using RIGHT
  // NOW — that is a question, not a toolbar toggle) and `rotatingId` is the in-flight guard. The
  // button used to fire on click with no confirmation and no visible state, so an impatient second
  // click sent a second rotation of the same machine — which the central then turned into a second
  // MACHINE. The server refuses the overlap now (rotate-claim.ts); this is what stops it being
  // asked in the first place.
  const [rotateConfirmId, setRotateConfirmId] = useState<string | null>(null)
  const [rotatingId, setRotatingId] = useState<string | null>(null)
  const [rotateId, setRotateId] = useState<string | null>(null)
  const [rotatedToken, setRotatedToken] = useState<string | null>(null)

  // Revoke confirm state
  const [revokeConfirmId, setRevokeConfirmId] = useState<string | null>(null)

  // Bulk delete state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false)

  // Edit machine drawer state
  const [editMachineOpen, setEditMachineOpen] = useState(false)
  const [editingMachine, setEditingMachine] = useState<MachineInfo | null>(null)
  const [editName, setEditName] = useState('')
  const [editTeamIds, setEditTeamIds] = useState<string[]>([])
  const [editOwnerRows, setEditOwnerRows] = useState<string[]>([])
  /** Which linked accounts may manage sessions. Seeded from the machine when the drawer opens. */
  const [editSessionGrant, setEditSessionGrant] = useState<string[]>([])
  /** The account a confirmation is currently being asked about. Only ever for turning one ON. */
  const [grantAsking, setGrantAsking] = useState<string | null>(null)
  const [editErr, setEditErr] = useState<string | null>(null)
  // Per-section edit toggle inside the (read-first) edit drawer. Only one section edits at a time.
  // The WHOLE edit drawer is one form: it used to hold a per-section value ('details' | 'owners'),
  // which forced an Edit→Save cycle per field group. Now every section edits together and commits
  // once (see saveAll + SaveBar).
  const [editingAll, setEditingAll] = useState(false)
  const [saveBusy, setSaveBusy] = useState(false)
  /** Partial-save report: which parts failed. Empty means the last save was clean. */
  const [saveFailed, setSaveFailed] = useState<{ label: string; error: string }[]>([])

  // Central URL state
  const [publicUrl, setPublicUrl] = useState('')
  const [publicUrlSaving, setPublicUrlSaving] = useState(false)
  const [publicUrlSaved, setPublicUrlSaved] = useState(false)
  const [publicUrlEditing, setPublicUrlEditing] = useState(false)

  const load = useCallback(async () => {
    try {
      const [m, a, t] = await Promise.all([
        fetch('/api/iam/machines').then(r => r.json() as Promise<{ machines: MachineInfo[] }>),
        fetch('/api/iam/accounts').then(r => r.json() as Promise<{ accounts: PublicAccount[] }>),
        fetch('/api/iam/teams').then(r => r.json() as Promise<{ teams: Team[] }>),
      ])
      setMachines(m.machines ?? [])
      setAccounts(a.accounts ?? [])
      setTeams(t.teams ?? [])
      setSelectedIds(new Set())
      setBulkDeleteConfirm(false)
    } catch (e) {
      setErr(String(e))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // Load central config (public URL)
  useEffect(() => {
    fetch('/api/team/config')
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then((cfg: { publicUrl?: string }) => {
        if (typeof cfg.publicUrl === 'string') {
          setPublicUrl(cfg.publicUrl)
        }
      })
      .catch(() => { /* ignore — server may not have the field yet */ })
  }, [])

  async function savePublicUrl() {
    setPublicUrlSaving(true)
    setPublicUrlSaved(false)
    try {
      const res = await fetch('/api/team/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicUrl }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setPublicUrlSaved(true)
      setPublicUrlEditing(false)
      setTimeout(() => setPublicUrlSaved(false), 2000)
    } catch (e) {
      setErr(String(e))
    } finally {
      setPublicUrlSaving(false)
    }
  }

  // Build team lookup
  const teamNameById = new Map<string, string>()
  teams.forEach(t => teamNameById.set(t._id, t.name))

  // Resolve a machine's full team set (prefer teamIds, fall back to the single teamId). Drop ids
  // that no longer resolve to a live team (a deleted team) so a raw _id never shows — defensive on
  // top of the server-side detach cascade, which also cleans any already-orphaned refs.
  const machineTeamIds = (m: MachineInfo): string[] =>
    (m.teamIds ?? (m.teamId ? [m.teamId] : [])).filter(id => teamNameById.has(id))
  const teamNamesLabel = (ids: string[]): string =>
    ids.length === 0 ? '—' : ids.map(id => teamNameById.get(id) ?? id).join(', ')

  // copy helper (reused from UsersSettings)
  async function copy(label: string, text: string) {
    setCopyFailed(null)
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text)
        setCopied(label)
        setTimeout(() => setCopied(c => c === label ? null : c), 1500)
        return
      } catch { /* fallback below */ }
    }
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    try {
      const ok = document.execCommand('copy')
      if (ok) {
        setCopied(label)
        setTimeout(() => setCopied(c => c === label ? null : c), 1500)
      } else {
        setCopyFailed(label)
      }
    } catch {
      setCopyFailed(label)
    } finally {
      document.body.removeChild(ta)
    }
  }

  function openDrawer() {
    setMachineRows([{ name: '', teamIds: [], accountIds: [] }])
    setDrawerErr(null)
    setCreated(null)
    setCopied(null)
    setCopyFailed(null)
    setDrawerOpen(true)
  }

  function addMachineRow() {
    setMachineRows(rs => [...rs, { name: '', teamIds: [], accountIds: [] }])
  }

  function removeMachineRow(i: number) {
    setMachineRows(rs => rs.length > 1 ? rs.filter((_, idx) => idx !== i) : rs)
  }

  function updateMachineRow(i: number, patch: { name?: string; teamIds?: string[]; accountIds?: string[] }) {
    setMachineRows(rs => rs.map((r, idx) => idx === i ? { ...r, ...patch } : r))
  }

  function addTeamToMachineRow(machineIdx: number) {
    setMachineRows(rs => rs.map((r, i) => i === machineIdx ? { ...r, teamIds: [...r.teamIds, ''] } : r))
  }

  function removeTeamFromMachineRow(machineIdx: number, teamIdx: number) {
    setMachineRows(rs => rs.map((r, i) => i === machineIdx ? { ...r, teamIds: r.teamIds.filter((_, idx) => idx !== teamIdx) } : r))
  }

  function updateTeamInMachineRow(machineIdx: number, teamIdx: number, teamId: string) {
    setMachineRows(rs => rs.map((r, i) => i === machineIdx ? { ...r, teamIds: r.teamIds.map((id, idx) => idx === teamIdx ? teamId : id) } : r))
  }

  function addOwnerToMachineRow(machineIdx: number) {
    setMachineRows(rs => rs.map((r, i) => i === machineIdx ? { ...r, accountIds: [...r.accountIds, ''] } : r))
  }

  function removeOwnerFromMachineRow(machineIdx: number, ownerIdx: number) {
    setMachineRows(rs => rs.map((r, i) => {
      if (i !== machineIdx) return r
      const newAccountIds = r.accountIds.filter((_, idx) => idx !== ownerIdx)
      return { ...r, accountIds: newAccountIds }
    }))
  }

  function updateOwnerInMachineRow(machineIdx: number, ownerIdx: number, accountId: string) {
    setMachineRows(rs => rs.map((r, i) => {
      if (i !== machineIdx) return r
      const newAccountIds = r.accountIds.map((id, idx) => idx === ownerIdx ? accountId : id)
      return { ...r, accountIds: newAccountIds }
    }))
  }

  async function addMachine() {
    const validRows = machineRows.filter(r => r.name.trim())
    if (validRows.length === 0) {
      setDrawerErr(pt ? 'Informe ao menos um nome de máquina.' : 'Provide at least one machine name.')
      return
    }
    // Non-owner must provide a team for every machine (scope enforcement).
    const isOwner = me?.role === 'owner'
    if (!isOwner) {
      const hasUnteamed = validRows.some(r => r.teamIds.filter(id => id.trim()).length === 0)
      if (hasUnteamed) {
        setDrawerErr(pt ? 'Selecione ao menos um time que você gerencia.' : 'Select at least one team you manage.')
        return
      }
    }
    const results: { name: string; token: string }[] = []
    for (const row of validRows) {
      const uniqueAccountIds = [...new Set(row.accountIds.filter(id => id.trim()))]
      const uniqueTeamIds = [...new Set(row.teamIds.filter(id => id.trim()))]
      const body: Record<string, unknown> = { name: row.name.trim() }
      if (uniqueAccountIds.length > 0) body.accountIds = uniqueAccountIds
      if (uniqueTeamIds.length > 0) body.teamIds = uniqueTeamIds
      const res = await fetch('/api/iam/machines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const d = await res.json() as { error?: string }
        setDrawerErr(d.error || `HTTP ${res.status}`)
        return
      }
      const d = await res.json() as { token: string }
      results.push({ name: row.name.trim(), token: d.token })
    }
    setCreated({ machines: results })
    void load()
  }

  async function revokeMachine(id: string) {
    try {
      const res = await fetch('/api/iam/machines', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setRevokeConfirmId(null)
      void load()
    } catch (e) {
      setErr(String(e))
    }
  }

  /** One rotation at a time, and never two of the same machine: a rotation mints a NEW identity
   *  (the machine id is the token's hash), so a second one fired before the first answered is a
   *  second identity for one machine — which is exactly how the fleet list grew duplicate rows. */
  async function rotateMachine(id: string) {
    if (rotatingId) return
    setRotatingId(id)
    setErr(null)
    try {
      const res = await fetch('/api/iam/machines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rotateId: id }),
      })
      if (!res.ok) {
        // 409 is the central saying this id was rotated out from under us (another tab, another
        // admin) — a stale row, not a failure of the machine, so it asks for a reload by name.
        if (res.status === 409) {
          throw new Error(pt
            ? 'Esta máquina já foi rotacionada em outro lugar. Recarregue a lista e tente de novo.'
            : 'This machine was already rotated elsewhere. Reload the list and try again.')
        }
        throw new Error(`HTTP ${res.status}`)
      }
      const d = await res.json() as { token: string }
      setRotateId(id)
      setRotatedToken(d.token)
      void load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setRotatingId(null)
    }
  }


  function openEditMachine(m: MachineInfo) {
    setEditingMachine(m)
    setEditName(m.machineName)
    setEditTeamIds(machineTeamIds(m))
    // Prefill owners from accountIds, or use accountId as fallback, or start with one empty row
    const ids = m.accountIds ?? (m.accountId ? [m.accountId] : [])
    setEditOwnerRows(ids.length > 0 ? ids : [''])
    setEditSessionGrant(m.sessionAccountIds ?? [])
    setGrantAsking(null)
    setEditErr(null)
    // Always open read-first, with any previous partial-save report cleared.
    setEditingAll(false)
    setSaveFailed([])
    setEditMachineOpen(true)
  }

  function addEditOwnerRow() {
    setEditOwnerRows(rs => [...rs, ''])
  }

  function removeEditOwnerRow(i: number) {
    setEditOwnerRows(rs => rs.length > 1 ? rs.filter((_, idx) => idx !== i) : rs)
  }

  function updateEditOwnerRow(i: number, accountId: string) {
    setEditOwnerRows(rs => rs.map((r, idx) => idx === i ? accountId : r))
  }

  function addEditTeamRow() {
    setEditTeamIds(rs => [...rs, ''])
  }

  function removeEditTeamRow(i: number) {
    setEditTeamIds(rs => rs.filter((_, idx) => idx !== i))
  }

  function updateEditTeamRow(i: number, teamId: string) {
    setEditTeamIds(rs => rs.map((r, idx) => idx === i ? teamId : r))
  }

  // Per-section saves (read-first drawer): each Section saves only its own fields.
  /** POST /api/iam/machines with one of its payload shapes; throws on a non-2xx. */
  async function postMachine(body: Record<string, unknown>): Promise<void> {
    const res = await fetch('/api/iam/machines', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  }

  /** What the edit drawer would change, per part. Also drives the Save button's enabled state, so
   *  an untouched form cannot fire a single request. */
  function editDiff() {
    const m = editingMachine
    if (!m) {
      return {
        name: false, teams: false, owners: false, grant: false, any: false,
        newTeamIds: [] as string[], newOwners: [] as string[],
        newGrant: undefined as string[] | undefined,
      }
    }
    const newTeamIds = [...new Set(editTeamIds.filter(id => id.trim()))]
    const newOwners = [...new Set(editOwnerRows.filter(id => id.trim()))]
    const sameSet = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
    const name = editName.trim() !== m.machineName
    const teams = !sameSet(machineTeamIds(m), newTeamIds)
    const owners = !sameSet(m.accountIds ?? (m.accountId ? [m.accountId] : []), newOwners)
    // Only meaningful when the server told us the current grant — i.e. when we may change it.
    const newGrant = m.sessionAccountIds === undefined
      ? undefined
      : editSessionGrant.filter(id => newOwners.includes(id))
    const grant = newGrant !== undefined && !sameSet(m.sessionAccountIds ?? [], newGrant)
    return {
      name, teams, owners, grant,
      any: name || teams || owners || grant,
      newTeamIds, newOwners, newGrant,
    }
  }

  /**
   * Commit the whole drawer in one go.
   *
   * Every part is attempted even if an earlier one fails: these are three separate requests with no
   * transaction behind them, so once the rename has committed there is nothing to roll back — and
   * stopping would leave the same partial state while silently dropping the rest of what the user
   * asked for. Whatever fails is named back to them instead.
   */
  async function saveAll() {
    if (!editingMachine) return
    if (!editName.trim()) {
      setEditErr(pt ? 'O nome não pode ficar vazio.' : 'Name cannot be empty.')
      return
    }
    const d = editDiff()
    if (!d.any) { setEditingAll(false); return }
    setSaveBusy(true)
    setEditErr(null)
    setSaveFailed([])
    const { failed } = await runSaveSteps([
      { label: pt ? 'nome' : 'name', dirty: d.name, run: () => postMachine({ renameId: editingMachine.id, name: editName.trim() }) },
      { label: pt ? 'times' : 'teams', dirty: d.teams, run: () => postMachine({ reassignId: editingMachine.id, teamIds: d.newTeamIds }) },
      // The grant rides WITH the account list: they are one document and one request, so a link
      // added in the same edit cannot land without the decision that was made about it.
      {
        label: pt ? 'contas' : 'owners',
        dirty: d.owners || d.grant,
        run: () => postMachine({
          ownerId: editingMachine.id,
          accountIds: d.newOwners,
          ...(d.newGrant !== undefined ? { sessionAccountIds: d.newGrant } : {}),
        }),
      },
    ])
    setSaveBusy(false)
    setSaveFailed(failed)
    // Stay in edit mode when something failed, so the unsaved values are still on screen to retry.
    if (failed.length === 0) setEditingAll(false)
    void load()
  }

  /** Reload every draft field from the machine as it currently is. */
  function resetEditDrafts() {
    setEditName(editMachine?.machineName ?? '')
    setEditTeamIds(editMachine ? machineTeamIds(editMachine) : [])
    const ids = editMachine?.accountIds ?? (editMachine?.accountId ? [editMachine.accountId] : [])
    setEditOwnerRows(ids.length > 0 ? ids : [''])
    setEditSessionGrant(editMachine?.sessionAccountIds ?? [])
    setGrantAsking(null)
  }

  function toggleSelectAll() {
    if (selectedIds.size === machines.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(machines.map(m => m.id)))
    }
  }

  function toggleSelect(id: string) {
    const newSet = new Set(selectedIds)
    if (newSet.has(id)) {
      newSet.delete(id)
    } else {
      newSet.add(id)
    }
    setSelectedIds(newSet)
  }

  async function bulkDelete() {
    try {
      for (const id of selectedIds) {
        const res = await fetch('/api/iam/machines', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
      }
    } catch (e) {
      setErr(String(e))
    } finally {
      // Always resync — a partial failure otherwise leaves already-deleted rows on screen.
      setBulkDeleteConfirm(false)
      void load()
    }
  }

  // Team picker options: for owner viewers, all teams; for managers, only managed teams.
  const isOwner = me?.role === 'owner'
  const managerTeams = isOwner
    ? teams
    : teams.filter(t => me?.memberships.some(m => m.teamId === t._id && m.role === 'manager'))

  // Build connect commands based on token type (composite vs raw)
  const connectCmdFor = (token: string) => {
    const isComposite = token.startsWith('act1_')
    if (isComposite) {
      return `agentop member connect --token ${token}`
    }
    const endpoint = publicUrl || window.location.origin
    return `agentop member connect --endpoint ${endpoint} --token ${token}`
  }

  const rotateConnectCmd = rotatedToken ? connectCmdFor(rotatedToken) : ''

  const drawerErrPanel = (m: string | null) => m && (
    <div style={{ fontSize: 12, color: '#ef4444', background: 'color-mix(in srgb, #ef4444 12%, transparent)', border: '1px solid color-mix(in srgb, #ef4444 35%, transparent)', borderRadius: 7, padding: '8px 10px' }}>
      {m}
    </div>
  )

  const canManageFleet = me?.role === 'owner' || me?.memberships.some(m => m.role === 'manager')

  // Per-machine display values shared by the desktop row and the mobile card, so the two
  // renderings cannot drift apart.
  // Which machine's relayed fleet is open. Only ever set for a machine whose row carries a
  // consent, which the server sends only to the machine's OWN accounts.
  const [fleetMachine, setFleetMachine] = useState<MachineInfo | null>(null)

  const machineView = (m: MachineInfo) => {
    const ownerIds = m.accountIds ?? (m.accountId ? [m.accountId] : [])
    const owners = m.owners ?? []
    // The SAME test the server runs (`machineOwnedBy`): is the viewer one of the machine's own
    // accounts? It is deliberately narrower than `canManage` — an instance owner administers every
    // machine and owns only the ones linked to their account — and it is what turns the absent
    // consent field from silence into a sentence.
    const viewerOwnsMachine = ownerIds.includes(me?.id ?? '')
    return {
      canManage: canManageFleet || viewerOwnsMachine,
      ownerDisplay: owners.length === 0 ? '—' : (owners[0]?.name ?? '') + (owners.length > 1 ? ` +${owners.length - 1}` : ''),
      ownerEmailDisplay: owners.length > 0 ? (owners[0]?.email ?? '') : (pt ? 'sem conta' : 'no account'),
      teamNames: machineTeamIds(m).map(id => teamNameById.get(id) ?? id),
      statusColor: m.online ? '#10b981' : '#6b7280',
      statusLabel: m.online ? 'online' : 'offline',
      // Resolved HERE so the desktop row and the mobile card cannot say different things about
      // the same machine — the same reason every other value on this object is shared.
      consent: machineConsentView(m.remoteConsent, m.online ?? false, pt ? 'pt' : 'en', viewerOwnsMachine),
    }
  }

  // Edit-drawer derived data (read-first sections). Re-derive the machine from the
  // fresh list by id so the read view reflects the latest data after a section save.
  const editMachine = editingMachine ? (machines.find(m => m.id === editingMachine.id) ?? editingMachine) : null
  const editCanManage = editMachine
    ? (canManageFleet || (editMachine.accountIds ?? (editMachine.accountId ? [editMachine.accountId] : [])).includes(me?.id ?? ''))
    : false
  const sectionLabels = {
    edit: pt ? 'Editar' : 'Edit',
    save: pt ? 'Salvar' : 'Save',
    cancel: pt ? 'Cancelar' : 'Cancel',
  }

  return (
    <>
      <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6, margin: '0 0 14px' }}>
        {pt
          ? 'Máquinas conectadas ao central — adicione tokens de máquina vinculados a contas.'
          : 'Machines connected to central — add machine tokens tied to accounts.'}
      </p>

      {err && <div style={{ fontSize: 12, color: '#ef4444', marginBottom: 12 }}>{err}</div>}

      {/* Central URL setting — only for owner/manager */}
      {canManageFleet && (
        <div style={{ marginBottom: 20, padding: '12px 14px', borderRadius: 8, background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-secondary)', letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: 6 }}>
            {pt ? 'URL Central' : 'Central URL'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 8, lineHeight: 1.5 }}>
            {pt
              ? 'Quando definida, o token gerado já embute esta URL — a máquina preenche o endpoint sozinha ao colar o token.'
              : 'When set, generated tokens embed this URL — the machine auto-fills the endpoint when the token is pasted.'}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {!publicUrlEditing && publicUrl ? (
              <>
                <code style={{
                  flex: 1,
                  fontSize: 12.5,
                  fontFamily: 'var(--font-mono, monospace)',
                  color: 'var(--text-tertiary)',
                  padding: '9px 11px',
                }}>
                  {publicUrl}
                </code>
                <button
                  onClick={() => setPublicUrlEditing(true)}
                  style={{
                    ...ghostBtn,
                    padding: '8px 12px',
                    fontSize: 12,
                  }}
                  title={pt ? 'Editar' : 'Edit'}
                >
                  <Pencil size={14} />
                </button>
              </>
            ) : (
              <>
                <input
                  type="text"
                  value={publicUrl}
                  onChange={e => setPublicUrl(e.target.value)}
                  placeholder="http://198.51.100.199:48080"
                  style={{
                    ...input,
                    flex: 1,
                    fontSize: 12.5,
                  }}
                />
                {publicUrlEditing && (
                  <button
                    onClick={() => {
                      setPublicUrlEditing(false)
                      // Reload the original value (reset changes)
                      fetch('/api/team/config')
                        .then(r => r.ok ? r.json() : Promise.reject())
                        .then((cfg: { publicUrl?: string }) => {
                          if (typeof cfg.publicUrl === 'string') {
                            setPublicUrl(cfg.publicUrl)
                          }
                        })
                        .catch(() => { /* ignore */ })
                    }}
                    style={{
                      ...ghostBtn,
                      padding: '8px 16px',
                      fontSize: 12,
                    }}
                  >
                    {pt ? 'Cancelar' : 'Cancel'}
                  </button>
                )}
                <button
                  onClick={() => void savePublicUrl()}
                  disabled={publicUrlSaving}
                  style={{
                    ...primaryBtn,
                    padding: '8px 16px',
                    fontSize: 12,
                    opacity: publicUrlSaving ? 0.6 : 1,
                    cursor: publicUrlSaving ? 'default' : 'pointer',
                  }}
                >
                  {publicUrlSaving ? (pt ? 'Salvando…' : 'Saving…') : publicUrlSaved ? '✓' : (pt ? 'Salvar' : 'Save')}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{pt ? 'Máquinas' : 'Machines'}</div>
        {canManageFleet && (
          <button style={primaryBtn} onClick={openDrawer}>
            <Plus size={14} /> {pt ? 'Adicionar máquina' : 'Add machine'}
          </button>
        )}
      </div>

      <p style={{ fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.5, margin: '0 0 14px' }}>
        {pt
          ? 'Perdeu o token de uma máquina? Use Rotacionar para gerar um novo (o token só é exibido uma vez).'
          : 'Lost a machine\'s token? Use Rotate to generate a new one (tokens are shown only once).'}
      </p>

      {selectedIds.size > 0 && (
        <div style={{ marginBottom: 12 }}>
          <button
            style={{
              ...primaryBtn,
              background: 'color-mix(in srgb, #ef4444 12%, transparent)',
              borderColor: '#ef4444',
              color: '#ef4444',
              ...(isMobile ? { width: '100%', minHeight: 44, justifyContent: 'center' } : {}),
            }}
            onClick={() => setBulkDeleteConfirm(true)}
          >
            <Trash2 size={14} />
            {pt ? `Excluir selecionados (${selectedIds.size})` : `Delete selected (${selectedIds.size})`}
          </button>
        </div>
      )}

      {machines.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)', padding: '20px 0' }}>
          {pt ? 'Nenhuma máquina registrada.' : 'No machines registered.'}
        </div>
      ) : isMobile ? (
        <>
          {/* Select-all lives in a <th> on desktop; on mobile it becomes its own row above the cards. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 44, padding: '0 4px', marginBottom: 8 }}>
            <Checkbox
              checked={selectedIds.size === machines.length}
              onChange={toggleSelectAll}
              label={pt ? 'Selecionar tudo' : 'Select all'}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {machines.map(m => {
              const v = machineView(m)
              return (
                <RecordCard
                  key={m.id}
                  title={m.machineName}
                  subtitle={v.ownerEmailDisplay}
                  onClick={v.canManage ? () => openEditMachine(m) : undefined}
                  leading={<Checkbox checked={selectedIds.has(m.id)} onChange={() => toggleSelect(m.id)} label="" />}
                  badge={
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-secondary)' }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: v.statusColor }} />
                      {v.statusLabel}
                      {m.latencyMs != null && <span style={{ color: 'var(--text-tertiary)' }}>· {m.latencyMs}ms</span>}
                    </span>
                  }
                  fields={[
                    // Owner is the machine's only person-facing identity — the raw push-identity
                    // `user` field used to be shown here too, under a redundant "User" row; for an
                    // ownerless machine that duplicated the machine's own name and read as if the
                    // machine WERE a person ("User: <machine name>"). Owner already says "—" /
                    // "no account" when there is none, so the extra row added nothing but the bug.
                    { label: pt ? 'Conta' : 'Owner', value: v.ownerDisplay },
                    // The card has vertical room the table cell did not, so print every team
                    // instead of the desktop's truncated chip + "+N" pill.
                    { label: pt ? 'Time' : 'Team', value: v.teamNames.length === 0 ? '—' : v.teamNames.join(', ') },
                    { label: pt ? 'Último acesso' : 'Last seen', value: m.lastSeenAt ? new Date(m.lastSeenAt).toLocaleString() : (pt ? 'nunca' : 'never') },
                    // The card has the room the table cell does not, so it prints the SENTENCE.
                    // The desktop row's chip carries it as a title, which a touch device cannot
                    // reach at all — a fact only reachable by hovering is not on a phone.
                    ...(v.consent ? [{ label: pt ? 'Sessões' : 'Sessions', value: v.consent.text }] : []),
                  ]}
                  actions={
                    <>
                      {v.consent?.tone === 'granted' && (
                        <RecordCardAction label="View sessions" onClick={() => setFleetMachine(m)}>
                          <MonitorSmartphone size={14} /> {pt ? 'Sessões' : 'Sessions'}
                        </RecordCardAction>
                      )}
                      {v.canManage && (
                        <RecordCardAction label="Edit machine" onClick={() => openEditMachine(m)}>
                          <Pencil size={14} /> {pt ? 'Editar' : 'Edit'}
                        </RecordCardAction>
                      )}
                      <RecordCardAction
                        label="Rotate token"
                        disabled={rotatingId !== null}
                        onClick={() => setRotateConfirmId(m.id)}
                      >
                        {rotatingId === m.id
                          ? <><Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> {pt ? 'Rotacionando…' : 'Rotating…'}</>
                          : <><RotateCw size={14} /> {pt ? 'Rotacionar' : 'Rotate'}</>}
                      </RecordCardAction>
                      <RecordCardAction label="Revoke machine" danger onClick={() => setRevokeConfirmId(m.id)}>
                        <Trash2 size={14} /> {pt ? 'Revogar' : 'Revoke'}
                      </RecordCardAction>
                    </>
                  }
                />
              )
            })}
          </div>
        </>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...th, width: 40 }}>
                  <Checkbox
                    checked={selectedIds.size === machines.length}
                    onChange={toggleSelectAll}
                    label=""
                  />
                </th>
                <th style={th}>{pt ? 'Máquina' : 'Machine'}</th>
                <th style={th}>{pt ? 'Conta' : 'Owner'}</th>
                <th style={th}>{pt ? 'Time' : 'Team'}</th>
                <th style={th}>Status</th>
                <th style={th}>{pt ? 'Último acesso' : 'Last seen'}</th>
                <th style={th}>{pt ? 'Ações' : 'Actions'}</th>
              </tr>
            </thead>
            <tbody>
              {machines.map(m => {
                const { statusColor, statusLabel, canManage, ownerDisplay, ownerEmailDisplay, consent } = machineView(m)
                return (
                  <tr key={m.id}
                    onClick={canManage ? () => openEditMachine(m) : undefined}
                    style={{ cursor: canManage ? 'pointer' : 'default' }}
                    onMouseEnter={canManage ? e => { e.currentTarget.style.background = 'var(--bg-elevated)' } : undefined}
                    onMouseLeave={canManage ? e => { e.currentTarget.style.background = '' } : undefined}>
                    <td style={td} onClick={e => e.stopPropagation()}>
                      <Checkbox
                        checked={selectedIds.has(m.id)}
                        onChange={() => toggleSelect(m.id)}
                        label=""
                      />
                    </td>
                    <td style={{ ...td, fontWeight: 600, color: 'var(--text-primary)' }}>
                      {m.machineName}
                    </td>
                    <td style={td}>
                      <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
                        <span style={{ fontWeight: 600 }}>{ownerDisplay}</span>
                        <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{ownerEmailDisplay}</span>
                      </div>
                    </td>
                    <td style={td}>
                      {(() => {
                        const ids = machineTeamIds(m)
                        if (ids.length === 0) return '—'
                        const names = ids.map(id => teamNameById.get(id) ?? id)
                        const chip: React.CSSProperties = {
                          display: 'inline-block', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap', verticalAlign: 'middle',
                          padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600,
                          color: 'var(--text-secondary)', background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                        }
                        // One chip (truncated) + a "+N" pill; full list on hover. Never wraps → scales to many teams.
                        return (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'nowrap', minWidth: 0 }} title={names.join(', ')}>
                            <span style={chip}>{names[0]}</span>
                            {names.length > 1 && (
                              <span style={{ ...chip, maxWidth: 'none', flexShrink: 0, color: 'var(--text-tertiary)' }}>+{names.length - 1}</span>
                            )}
                          </div>
                        )
                      })()}
                    </td>
                    <td style={td}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                        <div style={{ width: 6, height: 6, borderRadius: '50%', background: statusColor }} />
                        <span>{statusLabel}</span>
                        {m.latencyMs != null && <span style={{ color: 'var(--text-tertiary)' }}>· {m.latencyMs}ms</span>}
                        {/* Only ever drawn for the machine's OWN accounts — the server omits the
                            field for everyone else, so there is nothing here to gate again. It
                            rides the status cell rather than taking a column: the column would be
                            empty on every row for most viewers, and a header naming a fact the
                            table never shows is worse than no header. */}
                        {consent && (
                          <span
                            title={consent.text}
                            style={{
                              padding: '1px 7px', borderRadius: 999, fontSize: 10, fontWeight: 700,
                              whiteSpace: 'nowrap',
                              border: `1px solid ${consent.tone === 'granted' ? 'var(--accent-green)' : 'var(--border)'}`,
                              color: consent.tone === 'granted' ? 'var(--accent-green)' : 'var(--text-tertiary)',
                            }}
                          >
                            {consent.short}
                          </span>
                        )}
                      </div>
                    </td>
                    <td style={td}>
                      {m.lastSeenAt ? new Date(m.lastSeenAt).toLocaleString() : (pt ? 'nunca' : 'never')}
                    </td>
                    <td style={td} onClick={e => e.stopPropagation()}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {/* Only for a machine that has AGREED. A row that has not said, or that
                            says no, gets no button — the state is already spelled out in the
                            status cell, and a control whose only outcome is a refusal is a
                            control that reads as broken. */}
                        {consent?.tone === 'granted' && (
                          <button
                            style={{ ...ghostBtn, padding: '4px 8px' }}
                            onClick={e => { e.stopPropagation(); setFleetMachine(m) }}
                            title={pt ? 'Ver sessões' : 'View sessions'}
                          >
                            <MonitorSmartphone size={12} />
                          </button>
                        )}
                        {canManage && (
                          <button
                            style={{ ...ghostBtn, padding: '4px 8px' }}
                            onClick={e => { e.stopPropagation(); openEditMachine(m) }}
                            title={pt ? 'Editar' : 'Edit'}
                          >
                            <Pencil size={12} />
                          </button>
                        )}
                        <button
                          style={{
                            ...ghostBtn, padding: '4px 8px',
                            cursor: rotatingId ? 'not-allowed' : 'pointer', opacity: rotatingId ? 0.5 : 1,
                          }}
                          disabled={rotatingId !== null}
                          aria-busy={rotatingId === m.id || undefined}
                          onClick={e => { e.stopPropagation(); setRotateConfirmId(m.id) }}
                          title={rotatingId === m.id
                            ? (pt ? 'Rotacionando…' : 'Rotating…')
                            : (pt ? 'Rotacionar token' : 'Rotate token')}
                        >
                          {rotatingId === m.id
                            ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />
                            : <RotateCw size={12} />}
                        </button>
                        <button
                          style={{ ...ghostBtn, padding: '4px 8px', color: '#ef4444' }}
                          onClick={e => { e.stopPropagation(); setRevokeConfirmId(m.id) }}
                          title={pt ? 'Revogar' : 'Revoke'}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* One machine's relayed session fleet — a READ, for its owning account only. Mounted only
          while a machine is selected, so no request travels behind a closed panel. */}
      {/* Granting session access NAMES what is being handed over. It is the one direction that
          needs it: withdrawing is safe, and a confirmation people meet in both directions is one
          they clear without reading. */}
      {grantAsking && (() => {
        const acct = accounts.find(a => a.id === grantAsking)
        return (
          <div
            role="dialog"
            aria-modal="true"
            onClick={() => setGrantAsking(null)}
            style={{
              position: 'fixed', inset: 0, zIndex: 4000, background: 'rgba(0,0,0,0.6)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: isMobile ? OVERLAY_TOP : 24,
            }}
          >
            <div onClick={e => e.stopPropagation()} style={{
              width: '100%', maxWidth: 460, background: 'var(--bg-card)',
              border: '1px solid var(--border)', borderRadius: 12, padding: 20,
              display: 'flex', flexDirection: 'column', gap: 12,
            }}>
              <strong style={{ fontSize: 14 }}>
                {pt ? 'Dar acesso às sessões desta máquina?' : 'Grant access to this machine’s sessions?'}
              </strong>
              <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-secondary)' }}>
                {pt
                  ? `${acct ? `${acct.name} (${acct.email})` : 'Esta conta'} vai poder ver a lista de sessões desta máquina e agir sobre elas: renomear, anotar, marcar tarefa, interromper, encerrar e reabrir.`
                  : `${acct ? `${acct.name} (${acct.email})` : 'This account'} will be able to see this machine’s session list and act on it: rename, note, task, interrupt, kill and reopen.`}
              </p>
              <p style={{ margin: 0, fontSize: 11.5, lineHeight: 1.6, color: 'var(--text-tertiary)' }}>
                {pt
                  ? 'A tela e a conversa das sessões continuam sem sair da máquina, e a própria máquina segue podendo recusar tudo isso no switch dela.'
                  : 'A session’s screen and conversation still never leave the machine, and the machine itself can still refuse all of this at its own switch.'}
              </p>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                <button type="button" style={ghostBtn} onClick={() => setGrantAsking(null)}>
                  {pt ? 'Cancelar' : 'Cancel'}
                </button>
                <button
                  type="button"
                  style={primaryBtn}
                  onClick={() => {
                    setEditSessionGrant(g => (g.includes(grantAsking) ? g : [...g, grantAsking]))
                    setGrantAsking(null)
                  }}
                >
                  {pt ? 'Dar acesso' : 'Grant access'}
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {fleetMachine && (
        <MachineFleetDrawer
          open
          machineId={fleetMachine.id}
          machineName={fleetMachine.machineName}
          lang={pt ? 'pt' : 'en'}
          onClose={() => setFleetMachine(null)}
        />
      )}

      {/* Add machine drawer */}
      <Drawer open={drawerOpen} onClose={() => { if (!created) setDrawerOpen(false) }} title={pt ? 'Adicionar máquinas' : 'Add machines'}
        lang={pt ? 'pt' : 'en'}
        dirty={!created && machineRows.some(r => r.name.trim() !== '' || r.teamIds.length > 0 || r.accountIds.some(a => a.trim() !== ''))}>
        {drawerErrPanel(drawerErr)}

        {!created && (<>
          <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.5, marginBottom: 14 }}>
            {pt
              ? 'Crie máquinas sem proprietário (loose), com time, com proprietário(s), ou ambos. Apenas o nome é obrigatório.'
              : 'Create machines with no owner (loose), team-only, owner(s)-only, or both. Only the name is required.'}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)' }}>
              {pt ? 'Máquinas' : 'Machines'}
            </span>
            <button type="button" style={ghostBtn} onClick={addMachineRow}>
              <Plus size={13} /> {pt ? 'Adicionar outra máquina' : 'Add another machine'}
            </button>
          </div>

          {machineRows.map((row, machineIdx) => (
            <div key={machineIdx} style={{
              marginBottom: 20,
              padding: 12,
              border: '1px solid var(--border-subtle)',
              borderRadius: 8,
              background: 'var(--bg-elevated)',
            }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', marginBottom: 12 }}>
                <Field label={pt ? 'Nome da máquina *' : 'Machine name *'}>
                  <input
                    style={input}
                    value={row.name}
                    onChange={e => updateMachineRow(machineIdx, { name: e.target.value })}
                    placeholder={pt ? 'ex.: laptop-trabalho' : 'e.g. work-laptop'}
                  />
                </Field>

                <button
                  type="button"
                  onClick={() => removeMachineRow(machineIdx)}
                  disabled={machineRows.length === 1}
                  style={{
                    ...trashBtn,
                    opacity: machineRows.length === 1 ? 0.35 : 1,
                    cursor: machineRows.length === 1 ? 'not-allowed' : 'pointer',
                  }}
                  aria-label={pt ? 'Remover máquina' : 'Remove machine'}
                >
                  <Trash2 size={14} />
                </button>
              </div>

              {/* Teams section */}
              <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 10, marginBottom: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    {pt ? (isOwner ? 'Times (opcional)' : 'Times') : (isOwner ? 'Teams (optional)' : 'Teams')}
                  </span>
                  <button type="button" style={{ ...ghostBtn, padding: '4px 8px', fontSize: 11 }} onClick={() => addTeamToMachineRow(machineIdx)}>
                    <Plus size={11} /> {pt ? 'Adicionar' : 'Add'}
                  </button>
                </div>

                {row.teamIds.length === 0 ? (
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
                    {isOwner
                      ? (pt ? 'Sem time (loose) — clique "Adicionar" para vincular times.' : 'No team (loose) — click "Add" to link teams.')
                      : (pt ? 'Clique "Adicionar" para vincular ao menos um time.' : 'Click "Add" to link at least one team.')}
                  </div>
                ) : (
                  row.teamIds.map((teamId, teamIdx) => (
                    <div key={teamIdx} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
                      <div style={{ flex: 1 }}>
                        <Select
                          value={teamId}
                          onChange={v => updateTeamInMachineRow(machineIdx, teamIdx, v)}
                          options={[
                            { value: '', label: pt ? 'Selecione o time…' : 'Select team…' },
                            ...managerTeams.map(t => ({ value: t._id, label: t.name })),
                          ]}
                          placeholder={pt ? 'Selecione o time…' : 'Select team…'}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => removeTeamFromMachineRow(machineIdx, teamIdx)}
                        style={trashBtn}
                        aria-label={pt ? 'Remover time' : 'Remove team'}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))
                )}
              </div>

              {/* Owners section */}
              <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    {pt ? 'Proprietários (opcional)' : 'Owners (optional)'}
                  </span>
                  <button type="button" style={{ ...ghostBtn, padding: '4px 8px', fontSize: 11 }} onClick={() => addOwnerToMachineRow(machineIdx)}>
                    <Plus size={11} /> {pt ? 'Adicionar' : 'Add'}
                  </button>
                </div>

                {row.accountIds.length === 0 ? (
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
                    {pt ? 'Sem proprietários — clique "Adicionar" para vincular contas.' : 'No owners — click "Add" to link accounts.'}
                  </div>
                ) : (
                  row.accountIds.map((accountId, ownerIdx) => (
                    <div key={ownerIdx} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
                      <div style={{ flex: 1 }}>
                        <Select
                          value={accountId}
                          onChange={v => updateOwnerInMachineRow(machineIdx, ownerIdx, v)}
                          options={[
                            { value: '', label: pt ? 'Selecione a conta…' : 'Select account…' },
                            // Any account can own a machine — including owner accounts (an owner owns
                            // their own machines). Matches the edit-machine owners picker below.
                            ...accounts.map(a => ({ value: a.id, label: `${a.name} — ${a.email}` })),
                          ]}
                          placeholder={pt ? 'Selecione a conta…' : 'Select account…'}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => removeOwnerFromMachineRow(machineIdx, ownerIdx)}
                        style={trashBtn}
                        aria-label={pt ? 'Remover proprietário' : 'Remove owner'}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          ))}
        </>)}

        {created ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)' }}>
              {pt ? 'Máquinas criadas — copie os dados agora' : 'Machines created — copy these now'}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
              {pt ? 'Estes valores não serão exibidos novamente.' : 'These values will not be shown again.'}
            </div>

            {created.machines.map((machine, idx) => (
              <React.Fragment key={idx}>
                <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)', marginTop: idx > 0 ? 12 : 0 }}>
                  {pt ? 'Máquina:' : 'Machine:'} {machine.name}
                </div>

                {/* Machine token */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    {pt ? 'Token' : 'Token'}
                  </span>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <code style={{ flex: 1, fontSize: 11.5, fontFamily: 'var(--font-mono, monospace)', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 9px', wordBreak: 'break-all', color: 'var(--text-primary)' }}>
                      {machine.token}
                    </code>
                    <button type="button" style={ghostBtn} onClick={e => { e.stopPropagation(); void copy(`token-${idx}`, machine.token) }} aria-label="Copy token">
                      {copied === `token-${idx}` ? <Check size={13} /> : <Copy size={13} />}
                    </button>
                  </div>
                  {copyFailed === `token-${idx}` && (
                    <span style={{ fontSize: 10, color: '#ef4444', lineHeight: 1.4 }}>
                      {pt ? 'falha ao copiar — selecione manualmente' : 'copy failed — select manually'}
                    </span>
                  )}
                </div>

                {/* Connect command */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    {pt ? 'Comando de conexão' : 'Connect command'}
                  </span>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <code style={{ flex: 1, fontSize: 11.5, fontFamily: 'var(--font-mono, monospace)', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 9px', wordBreak: 'break-all', color: 'var(--text-secondary)' }}>
                      {connectCmdFor(machine.token)}
                    </code>
                    <button type="button" style={ghostBtn} onClick={e => { e.stopPropagation(); void copy(`connect-${idx}`, connectCmdFor(machine.token)) }} aria-label="Copy connect command">
                      {copied === `connect-${idx}` ? <Check size={13} /> : <Copy size={13} />}
                    </button>
                  </div>
                  {copyFailed === `connect-${idx}` && (
                    <span style={{ fontSize: 10, color: '#ef4444', lineHeight: 1.4 }}>
                      {pt ? 'falha ao copiar — selecione manualmente' : 'copy failed — select manually'}
                    </span>
                  )}
                </div>
              </React.Fragment>
            ))}

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
              <button style={primaryBtn} onClick={() => setDrawerOpen(false)}>
                <Check size={14} /> {pt ? 'Concluir' : 'Done'}
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
            <button style={ghostBtn} onClick={() => setDrawerOpen(false)}>{pt ? 'Cancelar' : 'Cancel'}</button>
            <button style={primaryBtn} onClick={() => void addMachine()}>
              <Plus size={14} /> {pt ? 'Adicionar' : 'Add'}
            </button>
          </div>
        )}
      </Drawer>

      {/* Rotate token drawer */}
      {rotateId && rotatedToken && (
        <Drawer open onClose={() => { setRotateId(null); setRotatedToken(null) }} title={pt ? 'Token rotacionado' : 'Token rotated'}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)' }}>
              {pt ? 'Novo token — copie agora' : 'New token — copy now'}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
              {pt ? 'Este valor não será exibido novamente.' : 'This value will not be shown again.'}
            </div>
            {/* The consequence nobody would guess: this machine's id on the central IS the hash of
                its token, so rotating renames it. Its history follows, its identity does not. */}
            <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
              {pt
                ? 'O histórico acompanhou a máquina — sessões, estatísticas, workflows e tags. A identidade dela aqui vem do token, então as outras máquinas da conta a verão como uma máquina nova e a anunciarão.'
                : 'History moved with the machine — sessions, stats, workflows and tags. Its identity here is derived from the token, so the account\'s other machines will see it as a new machine and announce it.'}
            </div>

            {/* Rotated token */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {pt ? 'Novo token' : 'New token'}
              </span>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <code style={{ flex: 1, fontSize: 11.5, fontFamily: 'var(--font-mono, monospace)', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 9px', wordBreak: 'break-all', color: 'var(--text-primary)' }}>
                  {rotatedToken}
                </code>
                <button type="button" style={ghostBtn} onClick={e => { e.stopPropagation(); void copy('rotated-token', rotatedToken) }} aria-label="Copy token">
                  {copied === 'rotated-token' ? <Check size={13} /> : <Copy size={13} />}
                </button>
              </div>
              {copyFailed === 'rotated-token' && (
                <span style={{ fontSize: 10, color: '#ef4444', lineHeight: 1.4 }}>
                  {pt ? 'falha ao copiar — selecione manualmente' : 'copy failed — select manually'}
                </span>
              )}
            </div>

            {/* Connect command */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {pt ? 'Comando de conexão' : 'Connect command'}
              </span>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <code style={{ flex: 1, fontSize: 11.5, fontFamily: 'var(--font-mono, monospace)', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 9px', wordBreak: 'break-all', color: 'var(--text-secondary)' }}>
                  {rotateConnectCmd}
                </code>
                <button type="button" style={ghostBtn} onClick={e => { e.stopPropagation(); void copy('rotated-connect', rotateConnectCmd) }} aria-label="Copy connect command">
                  {copied === 'rotated-connect' ? <Check size={13} /> : <Copy size={13} />}
                </button>
              </div>
              {copyFailed === 'rotated-connect' && (
                <span style={{ fontSize: 10, color: '#ef4444', lineHeight: 1.4 }}>
                  {pt ? 'falha ao copiar — selecione manualmente' : 'copy failed — select manually'}
                </span>
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
              <button style={primaryBtn} onClick={() => { setRotateId(null); setRotatedToken(null) }}>
                <Check size={14} /> {pt ? 'Concluir' : 'Done'}
              </button>
            </div>
          </div>
        </Drawer>
      )}

      {/* Edit machine drawer — read-first with a per-section Edit toggle. */}
      <Drawer open={editMachineOpen} onClose={() => setEditMachineOpen(false)} title={pt ? 'Editar máquina' : 'Edit machine'}
        lang={pt ? 'pt' : 'en'}
        dirty={editingAll && editDiff().any}>
        {drawerErrPanel(editErr)}

        {/* DETAILS SECTION (name + team) — read-first */}
        <Section
          title={pt ? 'Detalhes' : 'Details'}
          editing={editingAll}
          canEdit={editCanManage}
          hideActions
          onEdit={() => {}}
          onCancel={() => {}}
          onSave={() => {}}
          labels={sectionLabels}
          editChildren={
            <>
              <Field label={pt ? 'Nome da máquina' : 'Machine name'}>
                <input
                  style={input}
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  placeholder={pt ? 'ex.: laptop-trabalho' : 'e.g. work-laptop'}
                />
              </Field>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)' }}>
                    {pt ? 'Times' : 'Teams'}
                  </span>
                  <button type="button" style={{ ...ghostBtn, padding: '4px 8px', fontSize: 11 }} onClick={addEditTeamRow}>
                    <Plus size={11} /> {pt ? 'Adicionar time' : 'Add team'}
                  </button>
                </div>
                {editTeamIds.length === 0 ? (
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
                    {pt ? 'Sem time — clique "Adicionar time" para vincular.' : 'No teams — click "Add team" to link one.'}
                  </div>
                ) : (
                  editTeamIds.map((teamId, i) => (
                    <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <div style={{ flex: 1 }}>
                        <Select
                          value={teamId}
                          onChange={v => updateEditTeamRow(i, v)}
                          options={[
                            { value: '', label: pt ? 'Selecione o time…' : 'Select team…' },
                            ...teams.map(t => ({ value: t._id, label: t.name })),
                          ]}
                          placeholder={pt ? 'Selecione o time…' : 'Select team…'}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => removeEditTeamRow(i)}
                        style={trashBtn}
                        aria-label={pt ? 'Remover time' : 'Remove team'}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <ReadField label={pt ? 'Nome da máquina' : 'Machine name'} value={editMachine?.machineName ?? '—'} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>{pt ? 'Times' : 'Teams'}</span>
              {(() => {
                const ids = editMachine ? machineTeamIds(editMachine) : []
                if (ids.length === 0) return <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{pt ? '— sem time' : '— no team'}</span>
                return (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {ids.map(id => (
                      <span key={id} style={{
                        display: 'inline-flex', alignItems: 'center', padding: '5px 10px', borderRadius: 6,
                        background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                        fontSize: 12, fontWeight: 600, color: 'var(--text-primary)',
                      }}>{teamNameById.get(id) ?? id}</span>
                    ))}
                  </div>
                )
              })()}
            </div>
          </div>
        </Section>

        {/* OWNERS SECTION — read-first */}
        <Section
          title={pt ? 'Contas (owners)' : 'Owners'}
          editing={editingAll}
          canEdit={editCanManage}
          hideActions
          onEdit={() => {}}
          onCancel={() => {}}
          onSave={() => {}}
          labels={sectionLabels}
          editChildren={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)' }}>
                  {pt ? 'Contas (owners)' : 'Owners'}
                </span>
                <button type="button" style={ghostBtn} onClick={addEditOwnerRow}>
                  <Plus size={13} /> {pt ? 'Adicionar conta' : 'Add owner'}
                </button>
              </div>
              {editOwnerRows.map((accountId, i) => (
                <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <div style={{ flex: 1 }}>
                    <Select
                      value={accountId}
                      onChange={v => updateEditOwnerRow(i, v)}
                      options={[
                        { value: '', label: pt ? 'Selecione a conta…' : 'Select account…' },
                        ...accounts.map(a => ({ value: a.id, label: `${a.name} — ${a.email}` })),
                      ]}
                      placeholder={pt ? 'Selecione a conta…' : 'Select account…'}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => removeEditOwnerRow(i)}
                    disabled={editOwnerRows.length === 1}
                    style={{
                      ...trashBtn,
                      opacity: editOwnerRows.length === 1 ? 0.35 : 1,
                      cursor: editOwnerRows.length === 1 ? 'not-allowed' : 'pointer',
                    }}
                    aria-label={pt ? 'Remover conta' : 'Remove owner'}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>

                {/* THE SESSION GRANT, per linked account.
                    Withheld entirely — not drawn disabled — when the server did not send the
                    current grant, which is exactly when this viewer may not change it: a control
                    that explains nothing is indistinguishable from a broken one. Absent too for
                    the machine's OWNER, whose access comes with the machine and cannot be revoked
                    by an edit, and for an empty row that names no account yet. */}
                {editMachine?.sessionAccountIds !== undefined && accountId.trim() !== '' && (
                  editOwnerRows[0] === accountId ? (
                    <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)', paddingLeft: 2 }}>
                      {pt
                        ? 'Dona da máquina — gerencia as sessões por definição.'
                        : 'The machine’s owner — manages its sessions by definition.'}
                    </span>
                  ) : (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 2, cursor: 'pointer' }}>
                      <ToggleSwitch
                        on={editSessionGrant.includes(accountId)}
                        label={pt ? 'Permitir gerenciar sessões' : 'Allow session management'}
                        onToggle={() => {
                          // Turning it OFF needs no confirmation: withdrawing access is not the
                          // dangerous direction. Turning it ON names what is handed over first.
                          if (editSessionGrant.includes(accountId)) {
                            setEditSessionGrant(g => g.filter(id => id !== accountId))
                          } else {
                            setGrantAsking(accountId)
                          }
                        }}
                      />
                      <span style={{ fontSize: 11, lineHeight: 1.4, color: 'var(--text-secondary)' }}>
                        {pt
                          ? 'Permitir que esta conta gerencie e interaja com as sessões desta máquina'
                          : 'Allow this account to manage and interact with this machine’s sessions'}
                      </span>
                    </label>
                  )
                )}
                </div>
              ))}
            </div>
          }
        >
          {(() => {
            const owners = editMachine?.owners ?? []
            if (owners.length === 0) {
              return <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{pt ? '— sem conta / loose' : '— no account / loose'}</span>
            }
            return (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {owners.map(o => (
                  <span key={o.id} style={{
                    display: 'inline-flex', flexDirection: 'column', gap: 1, padding: '5px 9px', borderRadius: 6,
                    background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                  }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{o.name}</span>
                    <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}>{o.email}</span>
                  </span>
                ))}
              </div>
            )
          })()}
        </Section>

        {/* Partial-save report. Every part is attempted, so naming what failed is the only honest
            outcome — the rest of the form DID save. */}
        {saveFailed.length > 0 && (
          <div style={{
            marginTop: 14, padding: '9px 11px', borderRadius: 8, fontSize: 12, lineHeight: 1.5,
            border: '1px solid #ef4444', background: 'rgba(239,68,68,0.08)', color: '#ef4444',
          }}>
            {pt
              ? `Não foi possível salvar: ${saveFailed.map(f => f.label).join(', ')}. O restante foi salvo.`
              : `Could not save: ${saveFailed.map(f => f.label).join(', ')}. Everything else was saved.`}
          </div>
        )}

        <SaveBar
          editing={editingAll}
          canEdit={editCanManage}
          dirty={editDiff().any}
          busy={saveBusy}
          onEdit={() => { setEditErr(null); setSaveFailed([]); resetEditDrafts(); setEditingAll(true) }}
          onCancel={() => { setSaveFailed([]); resetEditDrafts(); setEditingAll(false) }}
          onSave={() => void saveAll()}
          labels={{
            edit: pt ? 'Editar' : 'Edit',
            save: pt ? 'Salvar' : 'Save',
            cancel: pt ? 'Cancelar' : 'Cancel',
            saving: pt ? 'Salvando…' : 'Saving…',
          }}
        />

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button style={ghostBtn} onClick={() => setEditMachineOpen(false)}>{pt ? 'Fechar' : 'Close'}</button>
        </div>
      </Drawer>

      {/* Rotate token confirm — the act is not undoable and it disconnects a working machine, so
          it is asked rather than fired. Closing on confirm is also the first of the two guards
          against a second rotation (the second is `rotatingId`, which disables every Rotate). */}
      <ConfirmModal
        open={rotateConfirmId !== null}
        title={pt ? 'Rotacionar o token?' : 'Rotate the token?'}
        message={(() => {
          const name = machines.find(m => m.id === rotateConfirmId)?.machineName ?? ''
          return pt
            ? `O token atual de "${name}" para de valer imediatamente. A máquina só volta a enviar dados depois de reconectar com o novo token (mostrado uma única vez). O histórico é preservado.`
            : `The current token for "${name}" stops working immediately. The machine only reports again once it reconnects with the new token (shown once). Its history is preserved.`
        })()}
        confirmLabel={pt ? 'Rotacionar' : 'Rotate'}
        cancelLabel={pt ? 'Cancelar' : 'Cancel'}
        onConfirm={() => {
          const id = rotateConfirmId
          setRotateConfirmId(null)
          if (id) void rotateMachine(id)
        }}
        onCancel={() => setRotateConfirmId(null)}
      />

      {/* Revoke machine confirm */}
      <ConfirmModal
        open={revokeConfirmId !== null}
        title={pt ? 'Revogar máquina?' : 'Revoke machine?'}
        message={(() => {
          const name = machines.find(m => m.id === revokeConfirmId)?.machineName ?? ''
          return pt
            ? `A máquina "${name}" será revogada e suas sessões removidas. Esta ação não pode ser desfeita.`
            : `Machine "${name}" will be revoked and its sessions removed. This action cannot be undone.`
        })()}
        confirmLabel={pt ? 'Revogar' : 'Revoke'}
        cancelLabel={pt ? 'Cancelar' : 'Cancel'}
        onConfirm={() => { if (revokeConfirmId) void revokeMachine(revokeConfirmId) }}
        onCancel={() => setRevokeConfirmId(null)}
      />

      {/* Bulk delete confirm */}
      <ConfirmModal
        open={bulkDeleteConfirm}
        title={pt ? `Excluir ${selectedIds.size} máquinas?` : `Delete ${selectedIds.size} machines?`}
        message={pt
          ? `${selectedIds.size} máquina(s) serão excluídas e suas sessões removidas. Esta ação não pode ser desfeita.`
          : `${selectedIds.size} machine(s) will be deleted and their sessions removed. This action cannot be undone.`}
        confirmLabel={pt ? 'Excluir' : 'Delete'}
        cancelLabel={pt ? 'Cancelar' : 'Cancel'}
        onConfirm={() => void bulkDelete()}
        onCancel={() => setBulkDeleteConfirm(false)}
      />

      <style>{'@keyframes spin { to { transform: rotate(360deg); } }'}</style>
    </>
  )
}

// main component
export default function MachinesSettings() {
  const ctx = useOutletContext<AppContext>()
  const pt = ctx.lang === 'pt'

  return (
    <div>
      <SectionHeader label={pt ? 'Máquinas' : 'Machines'} />
      {ctx.isCentral ? <CentralMachinesView pt={pt} /> : <SoloMemberMachinesView pt={pt} />}
    </div>
  )
}
