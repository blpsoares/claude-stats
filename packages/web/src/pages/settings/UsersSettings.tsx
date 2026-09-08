import React, { useEffect, useState, useCallback } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Plus, Trash2, Copy, Check, Dice5, KeyRound, Pencil, X } from 'lucide-react'
import { generatePassword } from '../../lib/password'
import { PasswordHint } from '../../components/PasswordHint'
import type { AppContext } from '../../lib/app-context'
import { SectionHeader, Section, Checkbox, Select, ConfirmModal, RecordCard, RecordCardAction, SaveBar, runSaveSteps } from './primitives'
import { Drawer } from './Drawer'
import { useIsMobile } from '../../hooks/useIsMobile'
import { stepUpFetch } from '../../lib/stepup'
import { Revealable, REVEAL_PAD } from '../../components/PasswordReveal'
import { validateAccountDraft, showsTeamlessHint, initialMembershipRows, type AccountDraft } from './accountForm'
import type { IamScope } from '@agentistics/core'

/** `orgTeam` marks the single team a central creates for its organisation at bootstrap — the one
 *  the create drawer pre-selects. It is provenance, not a kind: the team is ordinary otherwise. */
interface Team { _id: string; name: string; orgTeam?: boolean }
interface Membership { teamId: string; role: 'manager' | 'user' }
interface Account { id: string; name: string; email: string; role: 'owner' | 'member'; memberships: Membership[] }
interface MachineRow { name: string; teamId: string }
/** An open "please reset my password" request, already scoped by the server to accounts this
 *  principal may reset. */
interface ResetRequest { id: string; accountId: string; email: string; name: string; reason?: string; createdAt: string }
interface LinkedMachine { id: string; machineName: string; teamId?: string; accountId?: string; accountIds?: string[]; lastSeenAt: string | null }
// The slice of GET /api/tags this page needs. Tag visibility is an explicit account list
// (`sharedWith`), so onboarding a new hire means granting the tags here instead of opening every
// tag one by one. Aggregates are ignored on purpose — this page never renders tag numbers.
interface TagLite { _id: string; name: string; color?: string; sharedWith: string[]; createdBy: string }

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

// A tag chip, mirroring the "share with" chips of the Tags page so the two places read the same.
// The remove control grows to a 44px touch target on mobile; on desktop it stays the compact X.
function TagChip({ label, color, isMobile, onRemove, removeLabel }: {
  label: string
  color?: string
  isMobile: boolean
  onRemove?: () => void
  removeLabel: string
}) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: onRemove ? '5px 4px 5px 10px' : '5px 10px',
      boxSizing: 'border-box',
      // No 44px here and no `.ag-tap`: this is a LABEL, not a control — the only thing to press is
      // the X inside it, and an overlay on the wrapper would sit on top of that button and take
      // its clicks. At `borderRadius: 999` the 44px it used to carry also made it an ellipse.
      borderRadius: 999, fontSize: 11.5, background: 'var(--bg-elevated)',
      border: '1px solid var(--border)', color: 'var(--text-secondary)',
    }}>
      <span style={{
        width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
        background: color || 'var(--anthropic-orange)',
      }} />
      {label}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel}
          // The chip's only control, so it is the one that carries the finger target — as an
          // invisible box, or a 44x44 X turns a 12px chip into a button with a label stuck to it.
          className="ag-tap-icon"
          style={{
            border: 'none', background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0, flexShrink: 0,
            width: 20, height: 20,
          }}
        >
          <X size={12} />
        </button>
      )}
    </span>
  )
}

const ROLE_BADGE_COLORS: Record<string, string> = {
  owner: '#a855f7', manager: 'var(--anthropic-orange)', user: '#3b82f6',
}
function RoleBadge({ role }: { role: string }) {
  const color = ROLE_BADGE_COLORS[role] ?? 'var(--text-tertiary)'
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontSize: 10.5,
      fontWeight: 700, color, background: `color-mix(in srgb, ${color} 16%, transparent)`,
      border: `1px solid color-mix(in srgb, ${color} 40%, transparent)`, textTransform: 'capitalize',
    }}>
      {role}
    </span>
  )
}

// page
export default function UsersSettings() {
  const { lang, me } = useOutletContext<AppContext>()
  const pt = lang === 'pt'
  const isMobile = useIsMobile()
  const viewerIsOwner = me?.role === 'owner'

  const [teams, setTeams] = useState<Team[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [machines, setMachines] = useState<LinkedMachine[]>([])
  const [err, setErr] = useState<string | null>(null)
  // Tags the viewer can see. Loaded on drawer open (not with the page) — the account drawers are
  // the only consumers, and a failure here must never break the accounts list.
  const [tags, setTags] = useState<TagLite[]>([])

  const load = useCallback(async () => {
    try {
      const [t, a, m] = await Promise.all([
        fetch('/api/iam/teams').then(r => r.json() as Promise<{ teams: Team[] }>),
        fetch('/api/iam/accounts').then(r => r.json() as Promise<{ accounts: Account[] }>),
        fetch('/api/iam/machines').then(r => r.json() as Promise<{ machines: LinkedMachine[] }>),
      ])
      setTeams(t.teams ?? []); setAccounts(a.accounts ?? []); setMachines(m.machines ?? [])
    } catch (e) { setErr(String(e)) }
  }, [])
  useEffect(() => { void load() }, [load])

  const loadTags = useCallback(async () => {
    try {
      const r = await fetch('/api/tags')
      if (!r.ok) { setTags([]); return }
      const d = await r.json() as { tags?: TagLite[] }
      setTags(d.tags ?? [])
    } catch { setTags([]) }
  }, [])

  // Scoping helpers
  const managedTeamIds = new Set((me?.memberships ?? []).filter(m => m.role === 'manager').map(m => m.teamId))
  const assignableTeams = viewerIsOwner ? teams : teams.filter(t => managedTeamIds.has(t._id))

  // Only tags the viewer may actually write are offered: the server accepts a PATCH from the tag's
  // creator or an owner, so offering anything else would just produce a 403 on save.
  const mayGrantTag = (t: TagLite) => viewerIsOwner || t.createdBy === me?.id
  const grantableTags = tags.filter(mayGrantTag)

  // account drawer
  const [accountOpen, setAccountOpen] = useState(false)
  const [an, setAn] = useState(''); const [ae, setAe] = useState(''); const [ap, setAp] = useState('')
  const [accountType, setAccountType] = useState<'owner' | 'member'>('member')
  const [rows, setRows] = useState<Membership[]>([{ teamId: '', role: 'user' }])
  const [machineRows, setMachineRows] = useState<MachineRow[]>([])
  // Tags to grant the account being created. Applied AFTER the account exists (it has no id until
  // then), one PATCH per tag.
  const [newTagIds, setNewTagIds] = useState<string[]>([])
  const [accountErr, setAccountErr] = useState<string | null>(null)
  const [mustChange, setMustChange] = useState(true)
  const [pwVisible, setPwVisible] = useState(false)
  // one-time result after a successful create (credentials + machine tokens shown once)
  const [created, setCreated] = useState<null | { email: string; password: string; machineTokens?: { name: string; token: string }[] }>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [copyFailed, setCopyFailed] = useState<string | null>(null)

  // The create drawer as the PURE rule sees it. `me` absent degrades to a scope that can create
  // nothing, exactly as `viewerIsOwner` / `managedTeamIds` above already degrade.
  const viewerScope: IamScope = { role: me?.role ?? 'member', memberships: me?.memberships ?? [] }
  const accountDraft: AccountDraft = {
    scope: viewerScope,
    accountType,
    name: an,
    email: ae,
    password: ap,
    // An owner-type account carries no team scope at all; a blank row is not a membership.
    memberships: accountType === 'owner' ? [] : rows.filter(r => r.teamId),
  }
  const teamlessHint = showsTeamlessHint(accountDraft)

  // edit drawer
  const [editOpen, setEditOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [editIsOwner, setEditIsOwner] = useState(false)
  const [en, setEn] = useState('')
  const [eRows, setERows] = useState<Membership[]>([{ teamId: '', role: 'user' }])
  const [linkedMachines, setLinkedMachines] = useState<LinkedMachine[]>([])
  // Bulk link: ids of the ownerless machines ticked in the drawer's link list.
  const [linkMachineIds, setLinkMachineIds] = useState<string[]>([])
  const [linking, setLinking] = useState(false)
  const [loadingMachines, setLoadingMachines] = useState(false)
  const [editErr, setEditErr] = useState<string | null>(null)
  const [tempPassword, setTempPassword] = useState<string | null>(null)
  /** Open "please reset me" requests this principal may act on — the server scopes the list. */
  const [resetRequests, setResetRequests] = useState<ResetRequest[]>([])
  // Per-section edit toggle inside the (read-first) edit drawer. Only one section edits at a time.
  // The edit drawer is ONE form. This held a per-section value, which forced an Edit→Save cycle
  // per field group — four of them on this screen. Everything now edits together (saveAll+SaveBar).
  const [editingAll, setEditingAll] = useState(false)
  const [saveBusy, setSaveBusy] = useState(false)
  /** Partial-save report: which parts failed. Empty means the last save was clean. */
  const [saveFailed, setSaveFailed] = useState<{ label: string; error: string }[]>([])
  // Tag grants being edited for this account (ids). Saved as a diff against what each tag's
  // sharedWith currently says, so a partially-applied save can simply be retried.
  const [eTagIds, setETagIds] = useState<string[]>([])
  // Add machine inline form in edit drawer
  const [addMachineName, setAddMachineName] = useState('')
  const [addMachineTeam, setAddMachineTeam] = useState('')
  const [addedMachineToken, setAddedMachineToken] = useState<string | null>(null)
  const [addedMachineName, setAddedMachineName] = useState<string | null>(null)
  // Rename machine in edit drawer
  const [renamingMachineId, setRenamingMachineId] = useState<string | null>(null)
  const [renameMachineValue, setRenameMachineValue] = useState('')
  // destructive-action confirmations (no silent delete/revoke/reset)
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string; email: string } | null>(null)
  const [confirmUnlink, setConfirmUnlink] = useState<{ id: string; name: string } | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)

  function openAccountDrawer() {
    setAn(''); setAe(''); setAp(''); setAccountType('member')
    setRows(initialMembershipRows(viewerScope, assignableTeams))
    setMachineRows([]); setNewTagIds([]); setAccountErr(null)
    setMustChange(true); setPwVisible(false); setCreated(null); setCopied(null); setCopyFailed(null)
    setAccountOpen(true)
    void loadTags()
  }
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
    // fallback: execCommand via temp textarea
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
  function updateRow(i: number, patch: Partial<Membership>) {
    setRows(rs => rs.map((r, idx) => idx === i ? { ...r, ...patch } : r))
  }
  function addRow() { setRows(rs => [...rs, { teamId: '', role: 'user' }]) }
  // No `length > 1` floor: an owner may create an account with no team, so the last row has to be
  // removable. A manager who empties the list is stopped by `validateAccountDraft` with a sentence
  // that says why — not by a disabled bin icon that says nothing.
  function removeRow(i: number) { setRows(rs => rs.filter((_, idx) => idx !== i)) }

  function addMachineRow() { setMachineRows(rs => [...rs, { name: '', teamId: '' }]) }
  function removeMachineRow(i: number) { setMachineRows(rs => rs.filter((_, idx) => idx !== i)) }
  function updateMachineRow(i: number, patch: Partial<MachineRow>) {
    setMachineRows(rs => rs.map((r, idx) => idx === i ? { ...r, ...patch } : r))
  }

  async function createAccount() {
    const issue = validateAccountDraft(accountDraft)
    if (issue === 'incomplete-fields') {
      setAccountErr(pt ? 'Preencha nome, email e senha (8+).' : 'Fill name, email and password (8+).')
      return
    }
    if (issue === 'team-required') {
      // Only a manager can reach this: an owner may create an account with no team at all. The
      // sentence therefore says WHY, rather than repeating "select a team" at someone who is
      // allowed to leave it blank.
      setAccountErr(pt
        ? 'Escolha um time que você gerencia — você só pode criar contas dentro do seu escopo.'
        : 'Pick a team you manage — you can only create accounts inside your own scope.')
      return
    }
    const memberships: Membership[] = accountDraft.memberships
    const machines = machineRows.filter(m => m.name.trim()).map(m => ({ name: m.name.trim(), teamId: m.teamId || undefined }))
    const body: Record<string, unknown> = {
      name: an.trim(), email: ae.trim(), password: ap, role: accountType, memberships,
      mustChangePassword: mustChange,
    }
    if (machines.length > 0) body.machines = machines
    const res = await stepUpFetch('/api/iam/accounts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) { const d = await res.json() as { error?: string }; setAccountErr(d.error || `HTTP ${res.status}`); return }
    const d = await res.json() as { account?: { id: string }; machineTokens?: { name: string; token: string }[] }
    setAccountErr(null) // clear any prior error (e.g. "email already exists") on success
    // The account exists now, so its id can be added to each selected tag. One PATCH per tag, in
    // order; the first failure stops the loop and is surfaced, exactly like the machine linking —
    // the grants already applied stay applied, and the account itself is never rolled back.
    const newAccountId = d.account?.id
    if (newAccountId && newTagIds.length > 0) {
      const grantErr = await grantTagsTo(newAccountId, newTagIds)
      if (grantErr) setAccountErr(grantErr)
      await loadTags()
    }
    setCreated({
      email: ae.trim(), password: ap,
      machineTokens: d.machineTokens,
    })
    void load()
  }

  /** Add `accountId` to each tag's sharedWith, sequentially. Returns the first error, or null. */
  async function grantTagsTo(accountId: string, tagIds: string[]): Promise<string | null> {
    for (const tagId of tagIds) {
      const t = tags.find(x => x._id === tagId)
      if (!t) continue
      if (t.sharedWith.includes(accountId)) continue
      const res = await fetch('/api/tags', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: tagId, sharedWith: [...t.sharedWith, accountId] }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string }
        return d.error || `HTTP ${res.status}`
      }
    }
    return null
  }
  async function deleteAccount(id: string) {
    await stepUpFetch('/api/iam/accounts', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
    void load()
  }

  async function openEditDrawer(a: Account) {
    setEditId(a.id); setEditIsOwner(a.role === 'owner'); setEn(a.name)
    // The account's memberships as they are — including none. A synthetic blank row here made a
    // teamless account look like one whose team was merely unsaved.
    setERows(a.memberships.map(m => ({ ...m })))
    setEditErr(null); setTempPassword(null); setAddMachineName(''); setAddMachineTeam(''); setAddedMachineToken(null); setAddedMachineName(null)
    setRenamingMachineId(null); setRenameMachineValue('')
    setLinkMachineIds([]); setLinking(false)
    setETagIds([])
    setEditingAll(false); setSaveFailed([])
    setEditOpen(true)
    void loadTags()
    // Fetch linked machines
    setLoadingMachines(true)
    try {
      const res = await fetch('/api/iam/machines')
      const d = await res.json() as { machines: LinkedMachine[] }
      setLinkedMachines((d.machines ?? []).filter(m => (m.accountIds ?? (m.accountId ? [m.accountId] : [])).includes(a.id)))
    } catch (e) {
      setEditErr(String(e))
    } finally {
      setLoadingMachines(false)
    }
  }
  function updateERow(i: number, patch: Partial<Membership>) { setERows(rs => rs.map((r, idx) => idx === i ? { ...r, ...patch } : r)) }
  function addERow() { setERows(rs => [...rs, { teamId: '', role: 'user' }]) }
  // Same as removeRow: an account is allowed to end up in no team, so the last row must go.
  function removeERow(i: number) { setERows(rs => rs.filter((_, idx) => idx !== i)) }


  /** What the edit drawer would change, per part. Drives the Save button's enabled state too. */
  function editDiff() {
    const nameChanged = en.trim() !== (editAccount?.name ?? '').trim()
    const baseline = (editAccount?.memberships ?? []).map(m => ({ t: m.teamId, r: m.role }))
    const membershipsChanged = !editIsOwner
      && JSON.stringify(eRows.map(r => ({ t: r.teamId, r: r.role }))) !== JSON.stringify(baseline)
    const tagsChanged = sortedIds(eTagIds) !== sortedIds(currentTagIds)
    return { nameChanged, membershipsChanged, tagsChanged, any: nameChanged || membershipsChanged || tagsChanged }
  }

  /**
   * Commit the whole drawer in one go.
   *
   * Name and memberships are the SAME endpoint, so they go in ONE request — two round trips for one
   * form was never necessary. Tag grants are a different resource (`/api/tags`, one PATCH per tag)
   * and stay a separate step. Every step is attempted even if an earlier one fails: there is no
   * transaction across these endpoints, so stopping would leave the same partial state while
   * silently dropping the rest. Whatever fails is named back to the user.
   */
  async function saveAll() {
    if (!editId) return
    if (!en.trim()) { setEditErr(pt ? 'O nome não pode ficar vazio.' : 'Name cannot be empty.'); return }
    const d = editDiff()
    if (!d.any) { setEditingAll(false); return }
    setSaveBusy(true)
    setEditErr(null)
    setSaveFailed([])

    const accountBody: Record<string, unknown> = { id: editId }
    if (d.nameChanged) accountBody.name = en.trim()
    if (d.membershipsChanged) accountBody.memberships = eRows.filter(r => r.teamId)

    const { failed } = await runSaveSteps([
      {
        label: d.nameChanged && d.membershipsChanged
          ? (pt ? 'nome e times' : 'name and teams')
          : d.nameChanged ? (pt ? 'nome' : 'name') : (pt ? 'times' : 'teams'),
        dirty: d.nameChanged || d.membershipsChanged,
        run: async () => {
          // stepUpFetch, not fetch: role and memberships live on this endpoint, so it is step-up
          // gated (see stepup.ts). Downgrading it to a bare fetch would break that gate.
          const res = await stepUpFetch('/api/iam/accounts', {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(accountBody),
          })
          if (!res.ok) {
            const body = await res.json().catch(() => ({})) as { error?: string }
            throw new Error(body.error || `HTTP ${res.status}`)
          }
        },
      },
      {
        label: pt ? 'tags' : 'tags',
        dirty: d.tagsChanged,
        run: async () => {
          for (const t of grantableTags) {
            const want = eTagIds.includes(t._id)
            const has = t.sharedWith.includes(editId)
            if (want === has) continue
            const sharedWith = want ? [...t.sharedWith, editId] : t.sharedWith.filter(x => x !== editId)
            const res = await fetch('/api/tags', {
              method: 'PATCH', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: t._id, sharedWith }),
            })
            if (!res.ok) {
              const body = await res.json().catch(() => ({})) as { error?: string }
              throw new Error(body.error || `HTTP ${res.status}`)
            }
          }
          await loadTags()
        },
      },
    ])

    setSaveBusy(false)
    setSaveFailed(failed)
    // Stay in edit mode on failure so the unsaved values are still on screen to retry.
    if (failed.length === 0) setEditingAll(false)
    void load()
  }

  /** Reload every draft field from the account as it currently is. */
  function resetEditDrafts() {
    setEn(editAccount?.name ?? '')
    setERows((editAccount?.memberships ?? []).map(m => ({ teamId: m.teamId, role: m.role })))
    setETagIds(currentTagIds)
  }


  const loadResetRequests = useCallback(() => {
    fetch('/api/iam/reset-requests')
      .then(r => (r.ok ? r.json() : { requests: [] }))
      .then((d: { requests?: ResetRequest[] }) => setResetRequests(d.requests ?? []))
      .catch(() => setResetRequests([]))
  }, [])
  useEffect(loadResetRequests, [loadResetRequests])

  async function dismissRequest(id: string) {
    await fetch(`/api/iam/reset-requests?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
    loadResetRequests()
  }

  async function resetPassword() {
    if (!editId) return
    const res = await stepUpFetch('/api/iam/accounts', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: editId, resetPassword: true }),
    })
    if (!res.ok) { const d = await res.json() as { error?: string }; setEditErr(d.error || `HTTP ${res.status}`); return }
    const d = await res.json() as { tempPassword?: string }
    setTempPassword(d.tempPassword ?? null)
    void load()
    loadResetRequests()
  }

  async function addMachine() {
    if (!editId || !addMachineName.trim()) return
    const body: Record<string, unknown> = { accountId: editId, name: addMachineName.trim() }
    if (addMachineTeam) body.teamId = addMachineTeam
    const res = await fetch('/api/iam/machines', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) { const d = await res.json() as { error?: string }; setEditErr(d.error || `HTTP ${res.status}`); return }
    const d = await res.json() as { token: string }
    setAddedMachineToken(d.token)
    setAddedMachineName(addMachineName.trim())
    setAddMachineName(''); setAddMachineTeam('')
    // Refetch machines
    const mRes = await fetch('/api/iam/machines')
    const mData = await mRes.json() as { machines: LinkedMachine[] }
    setLinkedMachines((mData.machines ?? []).filter(m => (m.accountIds ?? (m.accountId ? [m.accountId] : [])).includes(editId)))
  }

  /** Link one or more EXISTING machines to the account being edited. Only machines with no owner
   *  account are offered — a machine already owned by someone else must be re-assigned from the
   *  Machines page, so this can never silently steal another account's machine.
   *  Each selected machine is a separate POST; the first failure stops the loop and is surfaced,
   *  and the already-linked ones stay linked (the refetch below reflects exactly that). */
  async function linkExistingMachines() {
    if (!editId || linkMachineIds.length === 0 || linking) return
    setLinking(true)
    setEditErr(null)
    let failed = false
    try {
      for (const id of linkMachineIds) {
        const res = await fetch('/api/iam/machines', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ownerId: id, accountIds: [editId] }),
        })
        if (!res.ok) {
          const d = await res.json().catch(() => ({})) as { error?: string }
          setEditErr(d.error || `HTTP ${res.status}`)
          failed = true
          break
        }
      }
      const mRes = await fetch('/api/iam/machines')
      const mData = await mRes.json() as { machines: LinkedMachine[] }
      setMachines(mData.machines ?? [])
      // Keep ticked only what is still ownerless (i.e. did not get linked) — on success that is none.
      const stillFree = new Set((mData.machines ?? [])
        .filter(m => (m.accountIds ?? (m.accountId ? [m.accountId] : [])).length === 0)
        .map(m => m.id))
      setLinkMachineIds(ids => failed ? ids.filter(id => stillFree.has(id)) : [])
      setLinkedMachines((mData.machines ?? []).filter(m => (m.accountIds ?? (m.accountId ? [m.accountId] : [])).includes(editId)))
    } finally {
      setLinking(false)
    }
  }
  function toggleLinkMachine(id: string) {
    setLinkMachineIds(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id])
  }

  // Unlink a machine from THIS account only — the machine is NOT deleted, it just loses this
  // account from its owner set (POST setMachineOwners with the reduced list). If this was its last
  // owner, it becomes loose (owner-only visibility), which the server allows for an owner principal.
  async function unlinkMachine(id: string) {
    if (!editId) return
    const m = linkedMachines.find(x => x.id === id)
    const owners = (m?.accountIds ?? (m?.accountId ? [m.accountId] : [])).filter(a => a !== editId)
    const res = await fetch('/api/iam/machines', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ownerId: id, accountIds: owners }),
    })
    if (!res.ok) { setEditErr(`HTTP ${res.status}`); return }
    // Refetch machines — the unlinked one drops out of this account's list (no longer an owner).
    const mRes = await fetch('/api/iam/machines')
    const mData = await mRes.json() as { machines: LinkedMachine[] }
    setLinkedMachines((mData.machines ?? []).filter(mm => (mm.accountIds ?? (mm.accountId ? [mm.accountId] : [])).includes(editId)))
  }

  async function renameMachine(id: string, name: string) {
    const res = await fetch('/api/iam/machines', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ renameId: id, name }),
    })
    if (!res.ok) { setEditErr(`HTTP ${res.status}`); return }
    setRenamingMachineId(null)
    // Refetch machines
    if (editId) {
      const mRes = await fetch('/api/iam/machines')
      const mData = await mRes.json() as { machines: LinkedMachine[] }
      setLinkedMachines((mData.machines ?? []).filter(m => (m.accountIds ?? (m.accountId ? [m.accountId] : [])).includes(editId)))
    }
  }

  function startRenameMachine(id: string, currentName: string) {
    setRenamingMachineId(id)
    setRenameMachineValue(currentName)
  }

  function cancelRenameMachine() {
    setRenamingMachineId(null)
    setRenameMachineValue('')
  }

  function confirmRenameMachine() {
    if (renamingMachineId && renameMachineValue.trim()) {
      void renameMachine(renamingMachineId, renameMachineValue.trim())
    }
  }

  function handleRenameMachineKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault()
      confirmRenameMachine()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelRenameMachine()
    }
  }

  const teamNameOf = (id: string) => teams.find(t => t._id === id)?.name ?? id

  // Only show memberships whose team still exists (drop refs to deleted teams so a raw _id never
  // shows — defensive on top of the server purge cascade). Shared by the table and the card list.
  const liveTeamChips = (a: Account) => {
    const live = a.role === 'owner' ? [] : a.memberships.filter(m => teams.some(t => t._id === m.teamId))
    if (live.length === 0) return <span style={{ color: 'var(--text-tertiary)' }}>—</span>
    return (
      <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4, justifyContent: 'flex-end' }}>
        {live.map(m => (
          <span key={m.teamId} style={{
            display: 'inline-block', padding: '2px 7px', borderRadius: 6, fontSize: 10.5,
            background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-secondary)',
          }}>{teamNameOf(m.teamId)}</span>
        ))}
      </span>
    )
  }

  // Each entry carries the role key so the legend renders the SAME badge the table/cards show —
  // the legend is what teaches the colour, so it must not invent its own styling.
  const roleLegend: { role: string; desc: string }[] = pt
    ? [
      { role: 'owner', desc: 'controle total' },
      { role: 'manager', desc: 'gerencia usuários e tokens do seu time' },
      { role: 'user', desc: 'leitura restrita' },
    ]
    : [
      { role: 'owner', desc: 'full control' },
      { role: 'manager', desc: "manages their team's users & tokens" },
      { role: 'user', desc: 'scoped read' },
    ]

  const drawerErr = (m: string | null) => m && (
    <div style={{ fontSize: 12, color: '#ef4444', background: 'color-mix(in srgb, #ef4444 12%, transparent)', border: '1px solid color-mix(in srgb, #ef4444 35%, transparent)', borderRadius: 7, padding: '8px 10px' }}>{m}</div>
  )

  function canDeleteClient(a: Account): boolean {
    if (!me) return false
    if (a.id === me.id) return false                    // never yourself
    if (a.role === 'owner') return me.role === 'owner' && ownerCount > 1   // last-owner protected
    // target is a member:
    if (me.role === 'owner') return true
    const managed = new Set(me.memberships.filter(m => m.role === 'manager').map(m => m.teamId))
    return a.memberships.length > 0 && a.memberships.every(m => m.role === 'user' && managed.has(m.teamId))
  }
  // Mirror the server PATCH authz: self (rename) always; owner edits anyone; else same rule as delete.
  function canEditClient(a: Account): boolean {
    if (!me) return false
    if (a.id === me.id) return true            // self rename
    if (me.role === 'owner') return true
    return canDeleteClient(a)                  // manager → managed user-members
  }

  // Build connect commands based on token type (composite vs raw)
  const connectCmdFor = (token: string) => {
    const isComposite = token.startsWith('act1_')
    if (isComposite) {
      return `agentop member connect --token ${token}`
    }
    // For raw tokens, fallback to window.location.origin (no central URL available in UsersSettings)
    return `agentop member connect --endpoint ${window.location.origin} --token ${token}`
  }

  // Compute totals
  const totalAccounts = accounts.length
  const ownerCount = accounts.filter(a => a.role === 'owner').length
  const managerCount = accounts.filter(a => a.role === 'member' && a.memberships.some(m => m.role === 'manager')).length
  const userCount = accounts.filter(a => a.role === 'member' && !a.memberships.some(m => m.role === 'manager')).length

  // Helper to count machines per account
  // Machines with no owner account at all — the only ones an account drawer may claim. A machine
  // owned by someone else is re-assigned from the Machines page, never silently taken here.
  const unlinkedMachines = machines.filter(m => (m.accountIds ?? (m.accountId ? [m.accountId] : [])).length === 0)

  const machineCountFor = (accountId: string) => machines.filter(m => (m.accountIds ?? (m.accountId ? [m.accountId] : [])).includes(accountId)).length

  // Edit-drawer derived data (read-first sections)
  const editAccount = accounts.find(a => a.id === editId) ?? null
  const canEditEdit = editAccount ? canEditClient(editAccount) : false
  // Tags this account can already see. Includes tags the viewer cannot grant (created by someone
  // else) — hiding them would misrepresent the account's access; they just render without an X.
  const currentTags = editId ? tags.filter(t => t.sharedWith.includes(editId)) : []
  const currentTagIds = currentTags.map(t => t._id)
  const sortedIds = (ids: string[]) => JSON.stringify([...ids].sort())
  const sectionLabels = {
    edit: pt ? 'Editar' : 'Edit',
    save: pt ? 'Salvar' : 'Save',
    cancel: pt ? 'Cancelar' : 'Cancel',
  }

  // Team-role option labels (values stay 'user'/'manager'; only the display text clarifies the role).
  // A manager may now delegate WITHIN a team they manage, so the manager option is offered to them
  // too — the server still refuses any membership in a team the caller does not manage.
  const roleOptions = (canGrantManager: boolean) => [
    { value: 'user', label: pt ? 'Usuário (leitura)' : 'User (read)' },
    ...(canGrantManager ? [{ value: 'manager', label: pt ? 'Manager (gerencia o time)' : 'Manager (manages the team)' }] : []),
  ]

  return (
    <div>
      <SectionHeader label={pt ? 'Usuários' : 'Users'} />

      <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6, margin: '0 0 14px' }}>
        {pt
          ? 'Contas que acessam o painel central. Cada usuário pertence a um ou mais times.'
          : 'Accounts that sign in to the central dashboard. Each user belongs to one or more teams.'}
      </p>

      {resetRequests.length > 0 && (
        <div style={{ border: '1px solid var(--anthropic-orange)55', background: 'var(--anthropic-orange-dim)', borderRadius: 10, padding: 14, marginBottom: 16 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>
            {pt ? 'Pedidos de redefinição de senha' : 'Password reset requests'}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginBottom: 10, lineHeight: 1.5 }}>
            {pt
              ? 'Quem não tem segundo fator pede aqui. Redefinir gera uma senha temporária — entregue por um canal que você confie; ela força a troca no próximo login.'
              : 'People without a second factor ask here. Resetting mints a temporary password — hand it over on a channel you trust; it forces a change at their next sign-in.'}
          </div>
          {resetRequests.map(r => {
            const account = accounts.find(a => a.id === r.accountId)
            return (
              <div key={r.id} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderTop: '1px solid var(--border-subtle)' }}>
                <div style={{ minWidth: 200, flex: 1 }}>
                  <div style={{ fontSize: 12.5, color: 'var(--text-primary)', fontWeight: 600 }}>{r.name} <span style={{ fontWeight: 400, color: 'var(--text-tertiary)' }}>{r.email}</span></div>
                  {r.reason && <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.5 }}>“{r.reason}”</div>}
                  <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', marginTop: 2 }}>{new Date(r.createdAt).toLocaleString()}</div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {account && (
                    <button type="button" style={ghostBtn} onClick={() => { void openEditDrawer(account); setConfirmReset(true) }}>
                      {pt ? 'Redefinir senha' : 'Reset password'}
                    </button>
                  )}
                  <button type="button" style={ghostBtn} onClick={() => { void dismissRequest(r.id) }}>
                    {pt ? 'Dispensar' : 'Dismiss'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Role legend — each row leads with the role's real badge, so the colour seen here is the
          same one the accounts list uses. Rows wrap instead of sharing one line with dot
          separators, which crammed the three descriptions together on narrow screens. */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: '8px 18px', alignItems: 'center',
        fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5,
        border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '11px 13px', marginBottom: 18,
      }}>
        {roleLegend.map(({ role, desc }) => (
          <span key={role} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
            <RoleBadge role={role} />
            <span style={{ color: 'var(--text-tertiary)' }}>{desc}</span>
          </span>
        ))}
      </div>


      {err && <div style={{ fontSize: 12, color: '#ef4444', marginBottom: 12 }}>{err}</div>}

      {/* Accounts */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{pt ? 'Contas' : 'Accounts'}</div>
        <button style={primaryBtn} onClick={openAccountDrawer}><Plus size={14} /> {pt ? 'Nova conta' : 'New account'}</button>
      </div>

      {/* Totals summary */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{
          display: 'inline-block', padding: '4px 10px', borderRadius: 6, fontSize: 11.5, fontWeight: 600,
          background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-secondary)',
        }}>
          {pt ? 'Total' : 'Total'}: {totalAccounts}
        </span>
        {ownerCount > 0 && (
          <span style={{
            display: 'inline-block', padding: '4px 10px', borderRadius: 6, fontSize: 11.5, fontWeight: 600,
            background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-secondary)',
          }}>
            Owners: {ownerCount}
          </span>
        )}
        {managerCount > 0 && (
          <span style={{
            display: 'inline-block', padding: '4px 10px', borderRadius: 6, fontSize: 11.5, fontWeight: 600,
            background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-secondary)',
          }}>
            Managers: {managerCount}
          </span>
        )}
        {userCount > 0 && (
          <span style={{
            display: 'inline-block', padding: '4px 10px', borderRadius: 6, fontSize: 11.5, fontWeight: 600,
            background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-secondary)',
          }}>
            Users: {userCount}
          </span>
        )}
      </div>
      {isMobile ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {accounts.length === 0 && (
            <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)', padding: '16px 2px' }}>
              {pt ? 'Nenhuma conta.' : 'No accounts.'}
            </div>
          )}
          {accounts.map(a => (
            <RecordCard
              key={a.id}
              title={a.name}
              subtitle={a.email}
              badge={<RoleBadge role={a.role === 'owner' ? 'owner' : (a.memberships[0]?.role ?? 'user')} />}
              onClick={canEditClient(a) ? () => void openEditDrawer(a) : undefined}
              fields={[
                { label: pt ? 'Times' : 'Teams', value: liveTeamChips(a) },
                { label: pt ? 'Máquinas' : 'Machines', value: machineCountFor(a.id) },
              ]}
              actions={(canEditClient(a) || canDeleteClient(a)) ? (
                <>
                  {canEditClient(a) && (
                    <RecordCardAction label="Edit account" onClick={() => void openEditDrawer(a)}>
                      <Pencil size={14} /> {pt ? 'Editar' : 'Edit'}
                    </RecordCardAction>
                  )}
                  {canDeleteClient(a) && (
                    <RecordCardAction label="Delete account" danger onClick={() => setConfirmDelete({ id: a.id, name: a.name, email: a.email })}>
                      <Trash2 size={14} /> {pt ? 'Excluir' : 'Delete'}
                    </RecordCardAction>
                  )}
                </>
              ) : undefined}
            />
          ))}
        </div>
      ) : (
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>{pt ? 'Nome' : 'Name'}</th>
              <th style={th}>Email</th>
              <th style={th}>{pt ? 'Papel' : 'Role'}</th>
              <th style={th}>{pt ? 'Times' : 'Teams'}</th>
              <th style={th}>{pt ? 'Máquinas' : 'Machines'}</th>
              <th style={{ ...th, width: 40 }} />
            </tr>
          </thead>
          <tbody>
            {accounts.length === 0 && (
              <tr><td style={{ ...td, color: 'var(--text-tertiary)' }} colSpan={6}>{pt ? 'Nenhuma conta.' : 'No accounts.'}</td></tr>
            )}
            {accounts.map(a => {
              const clickable = canEditClient(a)
              return (
              <tr key={a.id}
                onClick={clickable ? () => void openEditDrawer(a) : undefined}
                style={{ cursor: clickable ? 'pointer' : 'default' }}
                onMouseEnter={clickable ? e => { e.currentTarget.style.background = 'var(--bg-elevated)' } : undefined}
                onMouseLeave={clickable ? e => { e.currentTarget.style.background = '' } : undefined}>
                <td style={{ ...td, color: 'var(--text-primary)', fontWeight: 500 }}>{a.name}</td>
                <td style={td}>{a.email}</td>
                <td style={td}><RoleBadge role={a.role === 'owner' ? 'owner' : (a.memberships[0]?.role ?? 'user')} /></td>
                <td style={td}>{liveTeamChips(a)}</td>
                <td style={td}>{machineCountFor(a.id)}</td>
                <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {canEditClient(a) && (
                    <button onClick={e => { e.stopPropagation(); void openEditDrawer(a) }} style={{ ...trashBtn, color: 'var(--text-tertiary)' }} aria-label="Edit account"><Pencil size={14} /></button>
                  )}
                  {canDeleteClient(a) && (
                    <button onClick={e => { e.stopPropagation(); setConfirmDelete({ id: a.id, name: a.name, email: a.email }) }} style={trashBtn} aria-label="Delete account"><Trash2 size={14} /></button>
                  )}
                </td>
              </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      )}

      {/* Account drawer — while showing shown-once secrets, only the explicit "Done" button closes it
          (backdrop/X are no-ops) so the machine token/command can't be lost to a stray click. */}
      <Drawer open={accountOpen} onClose={() => { if (!created) setAccountOpen(false) }} title={pt ? 'Nova conta' : 'New account'}
        lang={lang}
        dirty={!created && (an.trim() !== '' || ae.trim() !== '' || ap.trim() !== '' || machineRows.length > 0 || newTagIds.length > 0 || rows.some(r => r.teamId !== ''))}>
        {drawerErr(accountErr)}

        {!created && (<>
        {/* IDENTITY SECTION */}
        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-tertiary)', letterSpacing: '0.07em', textTransform: 'uppercase', marginTop: 4 }}>
          {pt ? 'Identidade' : 'Identity'}
        </div>

        {/* Account type — Owner is offered only to an owner viewer. */}
        {viewerIsOwner && (
          <Field label={pt ? 'Tipo de conta' : 'Account type'}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {([
                ['member', pt ? 'Membro com escopo' : 'Scoped member', pt ? 'Acesso restrito a times' : 'Access scoped to teams'],
                ['owner', pt ? 'Owner (acesso total)' : 'Owner (full access)', pt ? 'Controle total do painel' : 'Full dashboard control'],
              ] as const).map(([val, title, desc]) => {
                const selected = accountType === val
                return (
                  <button key={val} type="button" onClick={() => setAccountType(val)} style={{
                    display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-start', textAlign: 'left',
                    padding: '10px 12px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
                    border: `1px solid ${selected ? 'var(--anthropic-orange)' : 'var(--border)'}`,
                    background: selected ? 'var(--anthropic-orange-dim)' : 'var(--bg-elevated)',
                  }}>
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: selected ? 'var(--anthropic-orange)' : 'var(--text-primary)' }}>{title}</span>
                    <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)', lineHeight: 1.4 }}>{desc}</span>
                  </button>
                )
              })}
            </div>
          </Field>
        )}

        <Field label={pt ? 'Nome' : 'Name'}>
          <input style={input} value={an} onChange={e => setAn(e.target.value)} placeholder={pt ? 'Nome completo' : 'Full name'} />
        </Field>
        <Field label="Email">
          <input style={input} value={ae} onChange={e => setAe(e.target.value)} placeholder="name@example.com" />
        </Field>
        <Field label={pt ? 'Senha (8+)' : 'Password (8+)'}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {/* `pwVisible` existed here already, but only the Generate button ever set it — there
                was no way to look at a password you typed yourself. */}
            <div style={{ flex: 1 }}>
              <Revealable shown={pwVisible} onToggle={() => setPwVisible(v => !v)} lang={lang}>
                <input style={{ ...input, width: '100%', paddingRight: REVEAL_PAD }} type={pwVisible ? 'text' : 'password'} value={ap}
                  onChange={e => setAp(e.target.value)} placeholder="••••••••" />
              </Revealable>
            </div>
            <button type="button" style={ghostBtn} title={pt ? 'Gerar senha aleatória' : 'Generate random password'}
              onClick={() => { const p = generatePassword(16); setAp(p); setPwVisible(true) }}>
              <Dice5 size={13} /> {pt ? 'Gerar' : 'Generate'}
            </button>
          </div>
          <PasswordHint value={ap} lang={lang} />
        </Field>

        {/* SECURITY SECTION */}
        <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 18, marginTop: 6 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-tertiary)', letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 14 }}>
            {pt ? 'Segurança' : 'Security'}
          </div>
          <Checkbox checked={mustChange} onChange={setMustChange} label={pt ? 'Exigir troca de senha no primeiro login' : 'Require password change on first login'} />
        </div>

        {/* ACCESS (TEAMS) SECTION */}
        <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 18, marginTop: 6 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-tertiary)', letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 14 }}>
            {pt ? 'Acesso' : 'Access'}
          </div>

          {accountType === 'owner' ? (
            <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.5, background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: 7, padding: '9px 11px' }}>
              {pt
                ? 'Owners têm acesso total a todos os times e máquinas — sem escopo de times.'
                : 'Owners have full access to all teams and machines — no team scope.'}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)' }}>{pt ? 'Escopo (times)' : 'Scope (teams)'}</span>
                <button type="button" style={ghostBtn} onClick={addRow}><Plus size={13} /> {pt ? 'Adicionar time' : 'Add team'}</button>
              </div>
              <p style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5, margin: 0 }}>
                {pt
                  ? 'Um manager gerencia os times selecionados (e suas máquinas). Um user tem leitura restrita.'
                  : "A manager manages the selected teams (and their machines). A user has scoped read access."}
              </p>
              {rows.map((r, i) => (
                <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <div style={{ flex: 2 }}>
                    <Select
                      value={r.teamId}
                      onChange={v => updateRow(i, { teamId: v })}
                      options={[
                        { value: '', label: pt ? 'Selecione o time…' : 'Select team…' },
                        ...assignableTeams.map(t => ({ value: t._id, label: t.name })),
                      ]}
                      placeholder={pt ? 'Selecione o time…' : 'Select team…'}
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <Select
                      value={r.role}
                      onChange={v => updateRow(i, { role: v as 'manager' | 'user' })}
                      options={roleOptions(viewerIsOwner || managedTeamIds.size > 0)}
                    />
                  </div>
                  <button type="button" onClick={() => removeRow(i)}
                    // The icon is 14px and the row it sits in is a pair of selects; a 44x44 box
                    // beside them was the tallest thing in the row. `.ag-tap-icon` keeps the finger
                    // target and opts the button out of the `.ag-settings button` 44px sweep.
                    className="ag-tap-icon"
                    style={{ ...trashBtn, minWidth: 28, minHeight: 28, justifyContent: 'center' }}
                    aria-label={pt ? 'Remover time' : 'Remove team'}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              {/* A teamless account is allowed and is not obvious — say what it costs, once, and
                  never block on it. A manager never sees this: they get the scope error instead. */}
              {teamlessHint && (
                <p role="note" style={{
                  fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5, margin: 0,
                  background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
                  borderRadius: 7, padding: '9px 11px',
                }}>
                  {pt
                    ? 'Sem time: a conta fica invisível para todos os managers — só o owner da instância poderá enxergá-la e administrá-la. Você pode adicionar um time depois.'
                    : 'No team: the account stays invisible to every manager — only the instance owner will be able to see and manage it. You can add a team later.'}
                </p>
              )}
            </div>
          )}
        </div>

        {/* MACHINES SECTION */}
        <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 18, marginTop: 6 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-tertiary)', letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 14 }}>
            {pt ? 'Máquinas' : 'Machines'}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)' }}>{pt ? 'Vincular máquinas' : 'Link machines'}</span>
              <button type="button" style={ghostBtn} onClick={addMachineRow}><Plus size={13} /> {pt ? 'Adicionar' : 'Add'}</button>
            </div>
            {machineRows.length === 0 ? (
              <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', padding: '12px 0' }}>
                {pt ? 'Nenhuma máquina a ser vinculada.' : 'No machines to link.'}
              </div>
            ) : (
              <>
                <p style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5, margin: 0 }}>
                  {pt
                    ? 'Tokens gerados aparecerão apenas uma vez após a criação.'
                    : 'Tokens will be shown only once after creation.'}
                </p>
                {machineRows.map((m, i) => (
                  <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
                    <Field label={pt ? 'Nome da máquina' : 'Machine name'}>
                      <input style={input} value={m.name} onChange={e => updateMachineRow(i, { name: e.target.value })} placeholder={pt ? 'ex.: laptop-trabalho' : 'e.g. work-laptop'} />
                    </Field>
                    {accountType === 'member' && (
                      <Field label={pt ? 'Time (opcional)' : 'Team (optional)'}>
                        <Select
                          value={m.teamId}
                          onChange={v => updateMachineRow(i, { teamId: v })}
                          options={[
                            { value: '', label: pt ? 'Deixar vazio' : 'Leave empty' },
                            ...assignableTeams.map(t => ({ value: t._id, label: t.name })),
                          ]}
                          placeholder={pt ? 'Deixar vazio' : 'Leave empty'}
                        />
                      </Field>
                    )}
                    <button type="button" onClick={() => removeMachineRow(i)}
                      style={trashBtn}
                      aria-label={pt ? 'Remover máquina' : 'Remove machine'}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
        {/* TAGS SECTION — tag visibility is an explicit account list, so a new hire inherits
            nothing. Granting here saves opening every tag one by one after onboarding. The grants
            are applied right after the account is created, since it has no id before that. */}
        <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 18, marginTop: 6 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-tertiary)', letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 14 }}>
            Tags
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <p style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5, margin: 0 }}>
              {pt
                ? 'Quem recebe uma tag vê os números completos dela. Só aparecem tags que você pode conceder.'
                : 'Anyone granted a tag sees its full numbers. Only tags you may grant are listed.'}
            </p>
            {grantableTags.length === 0 ? (
              <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
                {pt ? 'Nenhuma tag disponível para conceder.' : 'No tags available to grant.'}
              </div>
            ) : (
              <Field label={pt ? 'Adicionar tag' : 'Add tag'}>
                <Select
                  value=""
                  onChange={id => { if (id) setNewTagIds(prev => prev.includes(id) ? prev : [...prev, id]) }}
                  options={grantableTags.filter(t => !newTagIds.includes(t._id)).map(t => ({ value: t._id, label: t.name }))}
                  placeholder={pt ? 'Buscar tag…' : 'Search a tag…'}
                  searchPlaceholder={pt ? 'Buscar…' : 'Search…'}
                  searchable
                />
              </Field>
            )}
            {newTagIds.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {newTagIds.map(id => {
                  const t = tags.find(x => x._id === id)
                  return (
                    <TagChip
                      key={id}
                      label={t?.name ?? id}
                      color={t?.color}
                      isMobile={isMobile}
                      removeLabel={pt ? 'Remover tag' : 'Remove tag'}
                      onRemove={() => setNewTagIds(prev => prev.filter(x => x !== id))}
                    />
                  )
                })}
              </div>
            )}
          </div>
        </div>
        </>)}

        {created ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)' }}>
              {pt ? 'Conta criada — copie os dados agora' : 'Account created — copy these now'}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
              {pt ? 'Estes valores não serão exibidos novamente.' : 'These values will not be shown again.'}
            </div>
            {([
              ['Email', created.email],
              [pt ? 'Senha' : 'Password', created.password],
            ] as [string, string][]).map(([label, value]) => (
              <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <code style={{ flex: 1, fontSize: 11.5, fontFamily: 'var(--font-mono, monospace)', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 9px', wordBreak: 'break-all', color: 'var(--text-primary)' }}>{value}</code>
                  <button type="button" style={ghostBtn} onClick={e => { e.stopPropagation(); void copy(label, value) }} aria-label={`Copy ${label}`}>
                    {copied === label ? <Check size={13} /> : <Copy size={13} />}
                  </button>
                </div>
                {copyFailed === label && (
                  <span style={{ fontSize: 10, color: '#ef4444', lineHeight: 1.4 }}>
                    {pt ? 'falha ao copiar — selecione manualmente' : 'copy failed — select manually'}
                  </span>
                )}
              </div>
            ))}
            {created.machineTokens && created.machineTokens.length > 0 && created.machineTokens.map(mt => (
              <React.Fragment key={mt.name}>
                <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)', marginTop: 8 }}>
                  {pt ? 'Máquina:' : 'Machine:'} {mt.name}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    {pt ? 'Token' : 'Token'}
                  </span>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <code style={{ flex: 1, fontSize: 11.5, fontFamily: 'var(--font-mono, monospace)', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 9px', wordBreak: 'break-all', color: 'var(--text-primary)' }}>{mt.token}</code>
                    <button type="button" style={ghostBtn} onClick={e => { e.stopPropagation(); void copy(`token-${mt.name}`, mt.token) }} aria-label="Copy token">
                      {copied === `token-${mt.name}` ? <Check size={13} /> : <Copy size={13} />}
                    </button>
                  </div>
                  {copyFailed === `token-${mt.name}` && (
                    <span style={{ fontSize: 10, color: '#ef4444', lineHeight: 1.4 }}>
                      {pt ? 'falha ao copiar — selecione manualmente' : 'copy failed — select manually'}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    {pt ? 'Comando de conexão' : 'Connect command'}
                  </span>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <code style={{ flex: 1, fontSize: 11.5, fontFamily: 'var(--font-mono, monospace)', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 9px', wordBreak: 'break-all', color: 'var(--text-secondary)' }}>
                      {connectCmdFor(mt.token)}
                    </code>
                    <button type="button" style={ghostBtn} onClick={e => { e.stopPropagation(); void copy(`cmd-${mt.name}`, connectCmdFor(mt.token)) }} aria-label="Copy connect command">
                      {copied === `cmd-${mt.name}` ? <Check size={13} /> : <Copy size={13} />}
                    </button>
                  </div>
                  {copyFailed === `cmd-${mt.name}` && (
                    <span style={{ fontSize: 10, color: '#ef4444', lineHeight: 1.4 }}>
                      {pt ? 'falha ao copiar — selecione manualmente' : 'copy failed — select manually'}
                    </span>
                  )}
                </div>
              </React.Fragment>
            ))}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
              <button style={primaryBtn} onClick={() => setAccountOpen(false)}><Check size={14} /> {pt ? 'Concluir' : 'Done'}</button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
            <button style={ghostBtn} onClick={() => setAccountOpen(false)}>{pt ? 'Cancelar' : 'Cancel'}</button>
            <button style={primaryBtn} onClick={() => void createAccount()}><Plus size={14} /> {pt ? 'Criar conta' : 'Create account'}</button>
          </div>
        )}
      </Drawer>

      {/* Edit account drawer — while a shown-once temp password or machine token is on screen, backdrop/X are no-ops
          so it can't be lost to a stray click (Close/Save are explicit). */}
      <Drawer open={editOpen} onClose={() => { if (!tempPassword && !addedMachineToken) setEditOpen(false) }} title={pt ? 'Editar conta' : 'Edit account'}
        lang={lang}
        dirty={editingAll && editDiff().any}>
        {drawerErr(editErr)}

        {/* IDENTITY SECTION (read-first) */}
        <Section
          title={pt ? 'Identidade' : 'Identity'}
          editing={editingAll}
          canEdit={canEditEdit}
          hideActions
          onEdit={() => {}}
          onCancel={() => {}}
          onSave={() => {}}
          labels={sectionLabels}
          editChildren={
            <>
              <Field label={pt ? 'Nome' : 'Name'}>
                <input style={input} value={en} onChange={e => setEn(e.target.value)} placeholder={pt ? 'Nome completo' : 'Full name'} />
              </Field>
              <ReadField label="Email" value={editAccount?.email ?? '—'} />
            </>
          }
        >
          {(() => {
            const managerTeamNames = editAccount ? editAccount.memberships.filter(m => m.role === 'manager').map(m => teamNameOf(m.teamId)) : []
            const roleKind = editIsOwner ? 'owner' : managerTeamNames.length > 0 ? 'manager' : 'user'
            const line = editIsOwner
              ? (pt ? 'Acesso total ao painel central.' : 'Full access to the central dashboard.')
              : roleKind === 'manager'
                ? (pt ? `Gerente de ${managerTeamNames.join(', ')}.` : `Manager of ${managerTeamNames.join(', ')}.`)
                : (pt ? 'Leitura restrita aos times atribuídos.' : 'Scoped read of assigned teams.')
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <RoleBadge role={roleKind} />
                  <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>{line}</span>
                </div>
                <ReadField label={pt ? 'Nome' : 'Name'} value={editAccount?.name ?? '—'} />
                <ReadField label="Email" value={editAccount?.email ?? '—'} />
              </div>
            )
          })()}
        </Section>

        {/* ACCESS (TEAMS) SECTION (read-first; owners have no team scope) */}
        <Section
          title={pt ? 'Acesso (times)' : 'Access (teams)'}
          editing={editingAll}
          canEdit={canEditEdit && !editIsOwner}
          hideActions
          onEdit={() => {}}
          onCancel={() => {}}
          onSave={() => {}}
          labels={sectionLabels}
          editChildren={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)' }}>{pt ? 'Escopo (times)' : 'Scope (teams)'}</span>
                <button type="button" style={ghostBtn} onClick={addERow}><Plus size={13} /> {pt ? 'Adicionar time' : 'Add team'}</button>
              </div>
              {eRows.map((r, i) => (
                <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <div style={{ flex: 2 }}>
                    <Select
                      value={r.teamId}
                      onChange={v => updateERow(i, { teamId: v })}
                      options={[
                        { value: '', label: pt ? 'Selecione o time…' : 'Select team…' },
                        ...assignableTeams.map(t => ({ value: t._id, label: t.name })),
                      ]}
                      placeholder={pt ? 'Selecione o time…' : 'Select team…'}
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <Select
                      value={r.role}
                      onChange={v => updateERow(i, { role: v as 'manager' | 'user' })}
                      options={roleOptions(viewerIsOwner || managedTeamIds.size > 0)}
                    />
                  </div>
                  <button type="button" onClick={() => removeERow(i)}
                    // The icon is 14px and the row it sits in is a pair of selects; a 44x44 box
                    // beside them was the tallest thing in the row. `.ag-tap-icon` keeps the finger
                    // target and opts the button out of the `.ag-settings button` 44px sweep.
                    className="ag-tap-icon"
                    style={{ ...trashBtn, minWidth: 28, minHeight: 28, justifyContent: 'center' }}
                    aria-label={pt ? 'Remover time' : 'Remove team'}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          }
        >
          {editIsOwner ? (
            <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.5, background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: 7, padding: '9px 11px' }}>
              {pt ? 'Owners não têm escopo de times.' : 'Owners have no team scope.'}
            </div>
          ) : (editAccount && editAccount.memberships.length > 0) ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {editAccount.memberships.map(m => (
                <span key={m.teamId} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderRadius: 6, fontSize: 11.5,
                  background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-secondary)',
                }}>
                  {teamNameOf(m.teamId)} <RoleBadge role={m.role} />
                </span>
              ))}
            </div>
          ) : (
            // A teamless account is a real state, not a missing value — say what it means rather
            // than printing a dash that reads as "not loaded".
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
              {pt
                ? 'Nenhum time — só o owner da instância enxerga e administra esta conta.'
                : 'No team — only the instance owner can see and manage this account.'}
            </span>
          )}
        </Section>

        {/* TAGS SECTION (read-first) — grants this account access to a tag's aggregated numbers.
            Saving PATCHes each changed tag with its full sharedWith array; tags created by someone
            else are shown but not editable, because the server would refuse the write. */}
        <Section
          title="Tags"
          editing={editingAll}
          canEdit={canEditEdit && grantableTags.length > 0}
          hideActions
          onEdit={() => {}}
          onCancel={() => {}}
          onSave={() => {}}
          labels={sectionLabels}
          editChildren={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
                {pt
                  ? 'Quem recebe uma tag vê os números completos dela. Só aparecem tags que você pode conceder.'
                  : 'Anyone granted a tag sees its full numbers. Only tags you may grant are listed.'}
              </div>
              <Field label={pt ? 'Adicionar tag' : 'Add tag'}>
                <Select
                  value=""
                  onChange={id => { if (id) setETagIds(prev => prev.includes(id) ? prev : [...prev, id]) }}
                  options={grantableTags.filter(t => !eTagIds.includes(t._id)).map(t => ({ value: t._id, label: t.name }))}
                  placeholder={pt ? 'Buscar tag…' : 'Search a tag…'}
                  searchPlaceholder={pt ? 'Buscar…' : 'Search…'}
                  searchable
                />
              </Field>
              {eTagIds.length === 0 ? (
                <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
                  {pt ? 'Nenhuma tag concedida.' : 'No tags granted.'}
                </div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {eTagIds.map(id => {
                    const t = tags.find(x => x._id === id)
                    const removable = !!t && mayGrantTag(t)
                    return (
                      <TagChip
                        key={id}
                        label={t?.name ?? id}
                        color={t?.color}
                        isMobile={isMobile}
                        removeLabel={pt ? 'Remover tag' : 'Remove tag'}
                        onRemove={removable ? () => setETagIds(prev => prev.filter(x => x !== id)) : undefined}
                      />
                    )
                  })}
                </div>
              )}
            </div>
          }
        >
          {currentTags.length === 0 ? (
            <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>—</span>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {currentTags.map(t => (
                <TagChip key={t._id} label={t.name} color={t.color} isMobile={isMobile} removeLabel={pt ? 'Remover tag' : 'Remove tag'} />
              ))}
            </div>
          )}
        </Section>

        {/* MACHINES SECTION (read-first; add/rename/revoke behind the section's Edit toggle) */}
        <Section
          title={pt ? 'Máquinas' : 'Machines'}
          // This section's own buttons (add machine / rename) act immediately against the server,
          // so it contributes no step to saveAll — it just opens and closes with the rest.
          editing={editingAll}
          canEdit={canEditEdit}
          hideActions
          onEdit={() => {}}
          onCancel={() => {}}
          onSave={() => {}}
          labels={sectionLabels}
          editChildren={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)' }}>{pt ? 'Máquinas vinculadas' : 'Linked machines'}</span>
              {loadingMachines ? (
                <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', padding: '12px 0' }}>{pt ? 'Carregando…' : 'Loading…'}</div>
              ) : linkedMachines.length === 0 ? (
                <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', padding: '12px 0' }}>{pt ? 'Nenhuma máquina vinculada.' : 'No machines linked.'}</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {linkedMachines.map(m => {
                    const isRenamingThisMachine = renamingMachineId === m.id
                    return (
                      <div key={m.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 7 }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
                          {isRenamingThisMachine ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <input
                                type="text"
                                value={renameMachineValue}
                                onChange={e => setRenameMachineValue(e.target.value)}
                                onKeyDown={handleRenameMachineKeyDown}
                                autoFocus
                                style={{
                                  ...input,
                                  padding: '4px 8px',
                                  fontSize: 12.5,
                                  minWidth: 120,
                                  flex: 1,
                                }}
                              />
                              <button
                                onClick={confirmRenameMachine}
                                style={{ ...ghostBtn, padding: '4px 8px', border: 'none', color: '#10b981' }}
                                title={pt ? 'Confirmar' : 'Confirm'}
                              >
                                <Check size={14} />
                              </button>
                              <button
                                onClick={cancelRenameMachine}
                                style={{ ...ghostBtn, padding: '4px 8px', border: 'none', color: '#6b7280' }}
                                title={pt ? 'Cancelar' : 'Cancel'}
                              >
                                <X size={14} />
                              </button>
                            </div>
                          ) : (
                            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>{m.machineName}</span>
                          )}
                          {!isRenamingThisMachine && (
                            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                              {m.teamId ? teamNameOf(m.teamId) : (pt ? 'sem time' : 'no team')} · {m.lastSeenAt ? new Date(m.lastSeenAt).toLocaleString() : (pt ? 'nunca' : 'never')}
                            </span>
                          )}
                        </div>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button
                            type="button"
                            style={{ ...ghostBtn, padding: '5px 10px', fontSize: 11.5 }}
                            onClick={() => startRenameMachine(m.id, m.machineName)}
                            title={pt ? 'Renomear' : 'Rename'}
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            type="button"
                            style={{ ...ghostBtn, padding: '5px 10px', fontSize: 11.5 }}
                            onClick={() => setConfirmUnlink({ id: m.id, name: m.machineName })}
                            title={pt ? 'Desvincular desta conta' : 'Unlink from this account'}
                          >
                            {pt ? 'Desvincular' : 'Unlink'}
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
              {/* Add machine inline form */}
              {addedMachineToken ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 14px', background: 'var(--bg-elevated)', border: '1px solid var(--anthropic-orange)', borderRadius: 7 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)' }}>
                    {pt ? 'Máquina adicionada — copie agora' : 'Machine added — copy now'}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.4 }}>
                    {addedMachineName}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      {pt ? 'Token' : 'Token'}
                    </span>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <code style={{ flex: 1, fontSize: 11.5, fontFamily: 'var(--font-mono, monospace)', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 9px', wordBreak: 'break-all', color: 'var(--text-primary)' }}>{addedMachineToken}</code>
                      <button type="button" style={ghostBtn} onClick={e => { e.stopPropagation(); void copy('added-token', addedMachineToken) }} aria-label="Copy token">
                        {copied === 'added-token' ? <Check size={13} /> : <Copy size={13} />}
                      </button>
                    </div>
                    {copyFailed === 'added-token' && (
                      <span style={{ fontSize: 10, color: '#ef4444', lineHeight: 1.4 }}>
                        {pt ? 'falha ao copiar — selecione manualmente' : 'copy failed — select manually'}
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      {pt ? 'Comando de conexão' : 'Connect command'}
                    </span>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <code style={{ flex: 1, fontSize: 11.5, fontFamily: 'var(--font-mono, monospace)', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 9px', wordBreak: 'break-all', color: 'var(--text-secondary)' }}>
                        {connectCmdFor(addedMachineToken)}
                      </code>
                      <button type="button" style={ghostBtn} onClick={e => { e.stopPropagation(); void copy('added-cmd', connectCmdFor(addedMachineToken)) }} aria-label="Copy connect command">
                        {copied === 'added-cmd' ? <Check size={13} /> : <Copy size={13} />}
                      </button>
                    </div>
                    {copyFailed === 'added-cmd' && (
                      <span style={{ fontSize: 10, color: '#ef4444', lineHeight: 1.4 }}>
                        {pt ? 'falha ao copiar — selecione manualmente' : 'copy failed — select manually'}
                      </span>
                    )}
                  </div>
                  <button type="button" style={ghostBtn} onClick={() => setAddedMachineToken(null)}>{pt ? 'Fechar' : 'Close'}</button>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {/* Link an existing machine. Only ownerless machines are listed — one already
                      owned by another account is re-assigned from the Machines page instead. */}
                  {unlinkedMachines.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)' }}>
                        {pt ? 'Vincular máquinas existentes' : 'Link existing machines'}
                      </span>
                      <div style={{
                        display: 'flex', flexDirection: 'column',
                        border: '1px solid var(--border)', borderRadius: 7,
                        background: 'var(--bg-elevated)', maxHeight: 220, overflowY: 'auto',
                      }}>
                        <div style={{
                          display: 'flex', alignItems: 'center', minHeight: isMobile ? 44 : 34,
                          padding: '0 11px', borderBottom: '1px solid var(--border-subtle)',
                        }}>
                          <Checkbox
                            checked={linkMachineIds.length === unlinkedMachines.length}
                            onChange={checked => setLinkMachineIds(checked ? unlinkedMachines.map(m => m.id) : [])}
                            label={pt ? 'Selecionar todas' : 'Select all'}
                          />
                        </div>
                        {unlinkedMachines.map(m => (
                          <div key={m.id} style={{
                            display: 'flex', alignItems: 'center', minHeight: isMobile ? 44 : 32,
                            padding: '0 11px',
                          }}>
                            <Checkbox
                              checked={linkMachineIds.includes(m.id)}
                              onChange={() => toggleLinkMachine(m.id)}
                              label={m.machineName}
                            />
                          </div>
                        ))}
                      </div>
                      <button
                        type="button"
                        style={{ ...primaryBtn, alignSelf: 'flex-start', opacity: linkMachineIds.length === 0 || linking ? 0.5 : 1 }}
                        disabled={linkMachineIds.length === 0 || linking}
                        onClick={() => void linkExistingMachines()}
                      >
                        {pt ? `Vincular ${linkMachineIds.length}` : `Link ${linkMachineIds.length}`}
                      </button>
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
                    <Field label={pt ? 'Nome da máquina' : 'Machine name'}>
                      <input style={input} value={addMachineName} onChange={e => setAddMachineName(e.target.value)} placeholder={pt ? 'ex.: laptop-trabalho' : 'e.g. work-laptop'} />
                    </Field>
                    {!editIsOwner && (
                      <Field label={pt ? 'Time (opcional)' : 'Team (optional)'}>
                        <Select
                          value={addMachineTeam}
                          onChange={v => setAddMachineTeam(v)}
                          options={[
                            { value: '', label: pt ? 'Deixar vazio' : 'Leave empty' },
                            ...assignableTeams.map(t => ({ value: t._id, label: t.name })),
                          ]}
                          placeholder={pt ? 'Deixar vazio' : 'Leave empty'}
                        />
                      </Field>
                    )}
                    <button type="button" style={primaryBtn} onClick={() => void addMachine()}>
                      <Plus size={13} /> {pt ? 'Adicionar' : 'Add'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          }
        >
          {loadingMachines ? (
            <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', padding: '12px 0' }}>{pt ? 'Carregando…' : 'Loading…'}</div>
          ) : linkedMachines.length === 0 ? (
            <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', padding: '12px 0' }}>{pt ? 'Nenhuma máquina vinculada.' : 'No machines linked.'}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {linkedMachines.map(m => (
                <div key={m.id} style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '10px 12px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 7 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>{m.machineName}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                    {m.teamId ? teamNameOf(m.teamId) : (pt ? 'sem time' : 'no team')} · {m.lastSeenAt ? new Date(m.lastSeenAt).toLocaleString() : (pt ? 'nunca' : 'never')}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* SECURITY SECTION — password recovery (no OTP): generate a one-time temp password.
            Only shown when the viewer can edit this account and it is NOT their own account. */}
        {canEditEdit && editAccount && editAccount.id !== me?.id && (
          <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)', letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 12 }}>
              {pt ? 'Segurança' : 'Security'}
            </div>
            {tempPassword ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 14px', background: 'var(--bg-elevated)', border: '1px solid var(--anthropic-orange)', borderRadius: 7 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)' }}>
                  {pt ? 'Senha temporária — copie agora' : 'Temporary password — copy now'}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.4 }}>
                  {pt ? 'Não será exibida novamente. O usuário deverá trocá-la no próximo login.' : 'It will not be shown again. The user must change it on next login.'}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    {pt ? 'Senha temporária' : 'Temp password'}
                  </span>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <code style={{ flex: 1, fontSize: 11.5, fontFamily: 'var(--font-mono, monospace)', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 9px', wordBreak: 'break-all', color: 'var(--text-primary)' }}>{tempPassword}</code>
                    <button type="button" style={ghostBtn} onClick={e => { e.stopPropagation(); void copy('temp-password', tempPassword) }} aria-label="Copy temp password">
                      {copied === 'temp-password' ? <Check size={13} /> : <Copy size={13} />}
                    </button>
                  </div>
                  {copyFailed === 'temp-password' && (
                    <span style={{ fontSize: 10, color: '#ef4444', lineHeight: 1.4 }}>
                      {pt ? 'falha ao copiar — selecione manualmente' : 'copy failed — select manually'}
                    </span>
                  )}
                </div>
                <button type="button" style={ghostBtn} onClick={() => setTempPassword(null)}>{pt ? 'Fechar' : 'Close'}</button>
              </div>
            ) : (
              <button type="button" style={ghostBtn} onClick={() => setConfirmReset(true)}>
                <KeyRound size={13} /> {pt ? 'Resetar senha (gera temporária)' : 'Reset password (generates temp)'}
              </button>
            )}
          </div>
        )}

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
          canEdit={canEditEdit}
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
          <button style={ghostBtn} onClick={() => setEditOpen(false)}>{pt ? 'Fechar' : 'Close'}</button>
        </div>
      </Drawer>

      {/* Destructive-action confirmations */}
      <ConfirmModal
        open={confirmDelete !== null}
        title={pt ? 'Excluir conta?' : 'Delete account?'}
        message={confirmDelete
          ? (pt
            ? `A conta "${confirmDelete.name}" (${confirmDelete.email}) será excluída permanentemente. Esta ação não pode ser desfeita.`
            : `The account "${confirmDelete.name}" (${confirmDelete.email}) will be permanently deleted. This cannot be undone.`)
          : ''}
        confirmLabel={pt ? 'Excluir' : 'Delete'}
        cancelLabel={pt ? 'Cancelar' : 'Cancel'}
        onConfirm={() => { if (confirmDelete) void deleteAccount(confirmDelete.id); setConfirmDelete(null) }}
        onCancel={() => setConfirmDelete(null)}
      />
      <ConfirmModal
        open={confirmUnlink !== null}
        title={pt ? 'Desvincular máquina?' : 'Unlink machine?'}
        message={confirmUnlink
          ? (pt
            ? `A máquina "${confirmUnlink.name}" será desvinculada desta conta. Ela NÃO será deletada nem para de enviar métricas — apenas perde o vínculo com esta conta.`
            : `Machine "${confirmUnlink.name}" will be unlinked from this account. It is NOT deleted and keeps sending metrics — it just loses the link to this account.`)
          : ''}
        confirmLabel={pt ? 'Desvincular' : 'Unlink'}
        cancelLabel={pt ? 'Cancelar' : 'Cancel'}
        onConfirm={() => { if (confirmUnlink) void unlinkMachine(confirmUnlink.id); setConfirmUnlink(null) }}
        onCancel={() => setConfirmUnlink(null)}
      />
      <ConfirmModal
        open={confirmReset}
        title={pt ? 'Resetar a senha desta conta?' : 'Reset this account’s password?'}
        message={pt
          ? 'Uma senha temporária será gerada e exibida uma única vez. O usuário deverá trocá-la no próximo login.'
          : 'A temporary password will be generated and shown once. The user must change it on next login.'}
        confirmLabel={pt ? 'Resetar senha' : 'Reset password'}
        cancelLabel={pt ? 'Cancelar' : 'Cancel'}
        onConfirm={() => { setConfirmReset(false); void resetPassword() }}
        onCancel={() => setConfirmReset(false)}
      />
    </div>
  )
}
