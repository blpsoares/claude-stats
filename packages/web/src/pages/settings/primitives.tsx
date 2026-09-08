import React, { useState } from 'react'
import { Pencil, Check, AlertTriangle, Info, ChevronDown } from 'lucide-react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { RevealButton, REVEAL_PAD } from '../../components/PasswordReveal'

// ScopeNote
// A subtle info banner explaining WHICH resources the signed-in account can see on a governance
// page (so a scoped manager/user understands the list is their access, not missing data).
export function ScopeNote({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 16,
      padding: '9px 12px', borderRadius: 8,
      background: 'color-mix(in srgb, var(--anthropic-orange) 8%, transparent)',
      border: '1px solid color-mix(in srgb, var(--anthropic-orange) 28%, transparent)',
      fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5,
    }}>
      <Info size={14} style={{ color: 'var(--anthropic-orange)', flexShrink: 0, marginTop: 1 }} />
      <span>{children}</span>
    </div>
  )
}

// ConfirmModal
// Centered confirmation dialog for destructive actions (delete/revoke/remove). Renders nothing
// when `open` is false. Backdrop click + Escape = cancel. The confirm button is red (danger).
export function ConfirmModal({ open, title, message, confirmLabel, cancelLabel, onConfirm, onCancel, requireText, requireTextHint }: {
  open: boolean
  title: string
  message: string
  confirmLabel: string
  cancelLabel: string
  onConfirm: () => void
  onCancel: () => void
  /** When set, the operator must type this EXACTLY before confirm enables — the guard against
   *  deleting the wrong thing on muscle memory. Omit it for a plain yes/no confirmation. */
  requireText?: string
  /** Prompt shown above the input, e.g. `Type "Client X" to confirm`. */
  requireTextHint?: string
}) {
  const isMobile = useIsMobile()
  const [typed, setTyped] = React.useState('')
  // Reset between openings, otherwise the previous answer would pre-arm the next delete.
  React.useEffect(() => { if (open) setTyped('') }, [open])
  const armed = requireText === undefined || typed === requireText
  React.useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [open, onCancel])
  if (!open) return null
  return (
    <div onClick={onCancel} style={{
      position: 'fixed', inset: 0, zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(3px)', padding: 16,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 420, background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderRadius: 12, padding: 22, boxShadow: '0 12px 48px rgba(0,0,0,0.5)',
        display: 'flex', flexDirection: 'column', gap: 14,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ display: 'inline-flex', padding: 8, borderRadius: 9, background: 'color-mix(in srgb, #ef4444 15%, transparent)', color: '#ef4444' }}>
            <AlertTriangle size={17} />
          </span>
          <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</span>
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55, margin: 0 }}>{message}</p>
        {requireText !== undefined && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {requireTextHint && (
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{requireTextHint}</span>
            )}
            <input
              value={typed}
              onChange={e => setTyped(e.target.value)}
              autoFocus
              spellCheck={false}
              autoComplete="off"
              style={{
                width: '100%', boxSizing: 'border-box', padding: isMobile ? '10px 11px' : '8px 11px',
                background: 'var(--bg-elevated)', border: `1px solid ${armed ? '#ef4444' : 'var(--border)'}`,
                borderRadius: 7, fontSize: isMobile ? 16 : 13, color: 'var(--text-primary)',
                outline: 'none', fontFamily: 'inherit',
              }}
            />
          </div>
        )}
        <div style={{
          display: 'flex', gap: 8, marginTop: 2, justifyContent: 'flex-end',
          flexDirection: isMobile ? 'column-reverse' : 'row',
        }}>
          <button type="button" onClick={onCancel} style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            padding: isMobile ? '0 14px' : '8px 14px', minHeight: isMobile ? 44 : undefined,
            width: isMobile ? '100%' : undefined,
            borderRadius: 7, border: '1px solid var(--border)', background: 'transparent',
            color: 'var(--text-secondary)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
          }}>{cancelLabel}</button>
          <button type="button" onClick={() => { if (armed) onConfirm() }} disabled={!armed} style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            padding: isMobile ? '0 14px' : '8px 14px', minHeight: isMobile ? 44 : undefined,
            width: isMobile ? '100%' : undefined,
            borderRadius: 7, border: '1px solid #ef4444', background: '#ef4444',
            color: '#fff', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
            cursor: armed ? 'pointer' : 'not-allowed', opacity: armed ? 1 : 0.45,
          }}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}

// RecordCard
// The mobile stand-in for a governance table row. A table with 6-8 columns is unreadable at
// 390px, so on mobile each row renders as a stacked card: title + badge, a subtitle, label/value
// field rows, and a footer of full-width 44px actions. The desktop <table> is kept as-is beside
// it — this is an additional branch, never a replacement.
export function RecordCard({ title, subtitle, badge, fields, actions, onClick, leading }: {
  title: React.ReactNode
  subtitle?: React.ReactNode
  /** Role / presence pill, rendered top-right on the title line. */
  badge?: React.ReactNode
  fields: { label: string; value: React.ReactNode }[]
  /** Rendered in a bordered footer; each direct child stretches to an equal share. */
  actions?: React.ReactNode
  /** Whole-card tap — mirrors the desktop row's onClick (opens the detail drawer). */
  onClick?: () => void
  /** Optional control before the title, e.g. a bulk-select checkbox. */
  leading?: React.ReactNode
}) {
  return (
    <div
      onClick={onClick}
      style={{
        border: '1px solid var(--border)', borderRadius: 12, background: 'var(--bg-card)',
        cursor: onClick ? 'pointer' : 'default', overflow: 'hidden',
      }}
    >
      <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          {leading && <span onClick={e => e.stopPropagation()} style={{ display: 'flex', flexShrink: 0 }}>{leading}</span>}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
            {subtitle && (
              <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>{subtitle}</div>
            )}
          </div>
          {badge && <span style={{ flexShrink: 0 }}>{badge}</span>}
        </div>
        {fields.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {fields.map(f => (
              <div key={f.label} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 12 }}>
                <span style={{ color: 'var(--text-tertiary)', flexShrink: 0, minWidth: 82 }}>{f.label}</span>
                <span style={{ color: 'var(--text-secondary)', minWidth: 0, flex: 1, textAlign: 'right' }}>{f.value}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {actions && (
        <div
          onClick={e => e.stopPropagation()}
          style={{
            display: 'flex', gap: 1, borderTop: '1px solid var(--border)',
            background: 'var(--border)',
          }}
        >
          {actions}
        </div>
      )}
    </div>
  )
}

// RecordCardAction
// A footer button for RecordCard: equal share of the row, 44px tall, flat against its neighbours
// (the 1px gaps in the parent's background show through as hairline dividers).
export function RecordCardAction({ onClick, children, danger, label, disabled }: {
  onClick: () => void
  children: React.ReactNode
  danger?: boolean
  label: string
  /** An action that is already running, or that must wait for one. A disabled control that still
   *  LOOKS pressable is how an unanswered click becomes a second request. */
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-busy={disabled || undefined}
      style={{
        flex: 1, minHeight: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
        border: 'none', background: 'var(--bg-card)',
        color: danger ? '#ef4444' : 'var(--text-secondary)',
        fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  )
}

// Shared presentational primitives for the settings pages. Extracted from the old
// PreferencesModal so the settings pages (which replace the modal tabs) keep an
// identical look without depending on the soon-to-be-removed modal.

// Section
// A titled block that is READ-ONLY by default with a right-aligned "Edit" button
// (shown only when `canEdit` and not already editing). Renders `children` (read
// view) by default; when `editing` it renders `editChildren` + Save/Cancel. The
// caller owns the `editing` boolean (per-section state). Used in the detail drawers
// so info shows read-first and each section is edited independently.
/**
 * One unit of work inside a single save. `run` throws to fail; `label` names the part for the
 * user, so a partial failure can say WHICH part did not save.
 */
export interface SaveStep {
  label: string
  /** Skip entirely when false — an untouched section must not fire a request. */
  dirty: boolean
  run: () => Promise<void>
}

/**
 * Run every dirty step, then report. Deliberately does NOT stop at the first failure.
 *
 * These steps are separate HTTP requests with no transaction behind them, so there is no rollback
 * to offer: by the time step 2 fails, step 1 is already committed on the server. Aborting would
 * leave the same partial state AND silently skip work the user asked for. So every step is
 * attempted and the caller is told exactly which parts landed and which did not — a partial save
 * the user can see beats a partial save dressed up as an abort.
 */
export async function runSaveSteps(steps: SaveStep[]): Promise<{ saved: string[]; failed: { label: string; error: string }[] }> {
  const saved: string[] = []
  const failed: { label: string; error: string }[] = []
  for (const step of steps) {
    if (!step.dirty) continue
    try {
      await step.run()
      saved.push(step.label)
    } catch (e) {
      failed.push({ label: step.label, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { saved, failed }
}

export function Section({ title, editing, onEdit, onCancel, onSave, canEdit = true, children, editChildren, labels, hideActions }: {
  title: string
  editing: boolean
  onEdit: () => void
  onCancel: () => void
  onSave: () => void
  canEdit?: boolean
  children: React.ReactNode
  editChildren: React.ReactNode
  labels?: { edit: string; save: string; cancel: string }
  /** Parent owns edit mode and supplies ONE save for the whole form — this section renders no
   *  Edit button and no Save/Cancel row. Used by drawers that save everything at once. */
  hideActions?: boolean
}) {
  const l = labels ?? { edit: 'Edit', save: 'Save', cancel: 'Cancel' }
  const isMobile = useIsMobile()
  return (
    <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, gap: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)', letterSpacing: '0.07em', textTransform: 'uppercase' }}>{title}</div>
        {canEdit && !editing && !hideActions && (
          <button type="button" onClick={onEdit} style={{
            display: 'inline-flex', alignItems: 'center', gap: 5, padding: isMobile ? '0 12px' : '5px 10px',
            minHeight: isMobile ? 40 : undefined, borderRadius: 7,
            border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)',
            fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
          }}><Pencil size={12} /> {l.edit}</button>
        )}
      </div>
      {editing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {editChildren}
          {/* Not rendered at all when the parent owns the save — `display: none` would leave two
              phantom Save buttons per drawer in the DOM and the accessibility tree.
              column-reverse puts Save above Cancel visually while keeping Cancel first in the
              DOM, so the thumb lands on the confirming action, not the discarding one. */}
          {!hideActions && (
          <div style={{
            display: 'flex', gap: 8, justifyContent: 'flex-end',
            flexDirection: isMobile ? 'column-reverse' : 'row',
          }}>
            {/* No `.ag-tap` here, deliberately: a full-width form action is the case that class
                excludes — it SHOULD be 44px of paint, not a thin bar the width of the drawer. */}
            <button type="button" onClick={onCancel} style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              padding: isMobile ? '0 12px' : '7px 12px', minHeight: isMobile ? 44 : undefined,
              width: isMobile ? '100%' : undefined, borderRadius: 7,
              border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)',
              fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
            }}>{l.cancel}</button>
            <button type="button" onClick={onSave} style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              padding: isMobile ? '0 14px' : '8px 14px', minHeight: isMobile ? 44 : undefined,
              width: isMobile ? '100%' : undefined, borderRadius: 7,
              border: '1px solid var(--anthropic-orange)', background: 'var(--anthropic-orange-dim)', color: 'var(--anthropic-orange)',
              fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
            }}><Check size={14} /> {l.save}</button>
          </div>
          )}
        </div>
      ) : children}
    </div>
  )
}

export function SectionHeader({ label }: { label: string }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)',
      letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 14,
    }}>
      {label}
    </div>
  )
}

export function Divider() {
  return <div style={{ height: 1, background: 'var(--border)', margin: '20px 0' }} />
}

export function TabSelect<T extends string>({
  options, value, onChange, accent = 'var(--anthropic-orange)',
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
  accent?: string
}) {
  return (
    <div style={{ display: 'inline-flex', width: 'fit-content', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
      {options.map((opt, i) => {
        const active = opt.value === value
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            style={{
              padding: '5px 12px',
              fontSize: 12, fontWeight: active ? 700 : 500,
              background: active ? `color-mix(in srgb, ${accent} 18%, transparent)` : 'transparent',
              color: active ? accent : 'var(--text-secondary)',
              border: 'none',
              borderRight: i < options.length - 1 ? '1px solid var(--border)' : 'none',
              cursor: active ? 'default' : 'pointer',
              fontFamily: 'inherit',
              transition: 'background 0.15s, color 0.15s',
              whiteSpace: 'nowrap',
            }}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

export function PrefRow({ label, sub, children }: { label: string; sub?: string; children: React.ReactNode }) {
  return (
    // flexWrap: 'wrap' is a no-op whenever a row's label + children already fit on one line (every
    // existing caller) and only kicks in once they don't — e.g. CentralAdminPanel's push-interval
    // row (select + Express checkbox + save status), which sits right at the edge of a 390px
    // viewport. Wrapping there beats a silent horizontal overflow.
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, gap: 12, flexWrap: 'wrap' }}>
      <div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', fontWeight: 500 }}>{label}</div>
        {sub && <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>{sub}</div>}
      </div>
      {children}
    </div>
  )
}

export function Toggle({ on, onToggle, disabled }: { on: boolean; onToggle: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={() => { if (!disabled) onToggle() }}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      // `.ag-switch` opts this control OUT of the `.ag-settings button { min-height: 44px }`
      // mobile rule (index.css). That rule exists for real buttons that were 22-33px tall on
      // mobile; applied here it stretched this 20px-tall pill to 44px and left its knob (top: 3)
      // pinned to the top third of a control three times its own height.
      className="ag-switch"
      style={{
        position: 'relative', width: 34, height: 20, borderRadius: 10,
        border: 'none', background: on ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
        cursor: disabled ? 'not-allowed' : 'pointer', padding: 0, transition: 'background 0.2s', flexShrink: 0,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <span style={{
        position: 'absolute', top: 3, left: on ? 17 : 3,
        width: 14, height: 14, borderRadius: '50%', background: '#fff',
        transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
      }} />
    </button>
  )
}

/**
 * The whole row is the control — one `<button>`, never a nested `<button>`.
 *
 * `.ag-settings button { min-height: 44px }` (index.css) already deforms `Toggle` on mobile (see
 * its own comment above); putting a `Toggle` INSIDE a row-sized button would additionally nest a
 * `<button>` inside a `<button>`, which is invalid HTML and behaves unpredictably (focus order,
 * double activation on some browsers/AT). So the whole row is one real button — `role="switch"` +
 * `aria-checked` carry the semantics — and the switch pill is a plain `<span aria-hidden>` drawn
 * inside it, purely visual. Follows `Checkbox` above: same problem ("the entire row is the
 * control"), same reason a `<label>` wrapper doesn't work here either (a label only forwards
 * clicks to a real form control, never to an element carrying an ARIA role).
 */
export function RowSwitch({ on, onToggle, label, sub, icon, disabled, dimmed }: {
  on: boolean
  onToggle: () => void
  label: string
  sub?: string
  icon?: React.ReactNode
  disabled?: boolean
  /** Renders the row de-emphasized with a struck-through label — the picker's "blocked
   *  repository" state. Deliberately not colour-only: a reader who cannot distinguish the
   *  on/off pill colour still sees the strikethrough and the lower opacity. */
  dimmed?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        minHeight: 48, width: '100%', boxSizing: 'border-box',
        padding: '0 2px',
        border: 'none', background: 'transparent', textAlign: 'left',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        fontFamily: 'inherit',
      }}
    >
      {icon && <span style={{ display: 'flex', flexShrink: 0, color: 'var(--text-tertiary)' }}>{icon}</span>}
      <span style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13, fontWeight: 500, color: 'var(--text-primary)',
          textDecoration: dimmed ? 'line-through' : 'none',
          opacity: dimmed ? 0.55 : 1,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{label}</div>
        {sub && (
          <div style={{
            fontSize: 11, color: 'var(--text-tertiary)', marginTop: 1,
            opacity: dimmed ? 0.55 : 1,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{sub}</div>
        )}
      </span>
      <span
        aria-hidden
        style={{
          // A plain `<span>`, not a `<button>` — never a nested control (see the doc comment
          // above) — so the `.ag-settings button` 44px rule cannot reach it and it needs no
          // `.ag-switch` opt-out of its own.
          position: 'relative', width: 34, height: 20, borderRadius: 10, flexShrink: 0,
          background: on ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
          transition: 'background 0.2s',
        }}
      >
        <span style={{
          position: 'absolute', top: 3, left: on ? 17 : 3,
          width: 14, height: 14, borderRadius: '50%', background: '#fff',
          transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
        }} />
      </span>
    </button>
  )
}

/**
 * A small coloured dot for connection/health state. Never the ONLY carrier of meaning — every
 * card that renders one also states the status in words next to it, so this is decorative,
 * not the label. Colours map to the app's existing status vocabulary (index.css): green for ok,
 * the orange accent for warn (the same colour `ScopeNote`'s `AlertTriangle` uses), red for error,
 * and the tertiary text colour for unknown — never an invented hex.
 */
export function StatusDot({ state, size = 8 }: {
  state: 'ok' | 'warn' | 'error' | 'unknown'
  size?: number
}) {
  const color = {
    ok: 'var(--accent-green)',
    warn: 'var(--anthropic-orange)',
    error: 'var(--accent-red)',
    unknown: 'var(--text-tertiary)',
  }[state]
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block', width: size, height: size, borderRadius: '50%',
        background: color, flexShrink: 0,
      }}
    />
  )
}

/**
 * A labeled text/password field. Moved verbatim from `TeamSettings.tsx` (which declared it
 * privately) so every settings page can share one implementation.
 *
 * Deliberately has NO inline mobile `fontSize` override. `index.css` already carries a global
 * iOS-zoom guard (`@media (max-width: 767px) { input:not([type=checkbox])..., textarea, select {
 * font-size: 16px !important } }`) that covers every text/password `<input>` in the app, this one
 * included — adding an inline 16px here would be dead code that reads like a live requirement.
 */
export function FieldInput({
  label, sub, value, onChange, type = 'text', placeholder, disabled,
}: {
  label: string
  sub?: string
  value: string
  onChange: (v: string) => void
  type?: 'text' | 'password'
  placeholder?: string
  disabled?: boolean
}) {
  // A hidden field the user cannot proof-read is where a mistyped token or password becomes a
  // failure somewhere else entirely; the reveal is the same control every other form here uses.
  const [shown, setShown] = useState(false)
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 2 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 5 }}>{sub}</div>}
      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}>
      <input
        type={type === 'password' && shown ? 'text' : type}
        value={value}
        placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        readOnly={disabled}
        style={{
          width: '100%', boxSizing: 'border-box',
          padding: '7px 10px',
          ...(type === 'password' ? { paddingRight: REVEAL_PAD } : null),
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 7,
          fontSize: 13,
          fontFamily: type === 'password' ? 'inherit' : 'inherit',
          color: 'var(--text-primary)',
          outline: 'none',
          transition: 'border-color 0.15s',
          ...(disabled ? { opacity: 0.6, cursor: 'not-allowed' } : {}),
        }}
        onFocus={e => { if (!disabled) e.currentTarget.style.borderColor = 'var(--anthropic-orange)' }}
        onBlur={e => { e.currentTarget.style.borderColor = 'var(--border)' }}
      />
      {type === 'password' && <RevealButton shown={shown} onToggle={() => setShown(v => !v)} />}
      </div>
    </div>
  )
}

/**
 * A checkbox whose ENTIRE row — box and label — is the control.
 *
 * This used to be a `<label>` wrapping a `div[role=checkbox]`, with the click handler on the inner
 * div only. A `<label>` forwards clicks solely to a real form control (`<input>`/`<select>`/…), and
 * never to a div with an ARIA role — so clicking the text did nothing, which is the one thing every
 * user expects a checkbox label to do. Making the row itself the single focusable control fixes the
 * label click, keyboard and the touch target in one shape, instead of syncing two elements.
 */
export function Checkbox({ checked, onChange, label, disabled }: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  disabled?: boolean
  /** Render the panel open, for the static-markup test that pins `position: fixed`. */
  defaultOpenForTest?: boolean
}) {
  const isMobile = useIsMobile()
  const toggle = (e: React.SyntheticEvent) => {
    if (disabled) return
    // Checkboxes sit inside clickable RecordCards (as `leading`), where bubbling would toggle the
    // row AND open the drawer behind it from a single tap.
    e.stopPropagation()
    onChange(!checked)
  }
  return (
    <div
      role="checkbox"
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      onClick={toggle}
      onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(e) } }}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 8,
        fontSize: 12, color: 'var(--text-secondary)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        // Only on mobile: a 44px row on desktop turns a list of checkboxes into a stack of bars.
        minHeight: isMobile ? 44 : undefined,
      }}
    >
      <div
        aria-hidden
        style={{
          width: 16, height: 16, borderRadius: 4, flexShrink: 0,
          border: `1px solid ${checked ? 'var(--anthropic-orange)' : 'var(--border)'}`,
          background: checked ? 'var(--anthropic-orange)' : 'transparent',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'all 0.15s',
        }}
      >
        {checked && (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2 6L5 9L10 3" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </div>
      {label && <span>{label}</span>}
    </div>
  )
}

/**
 * The single Edit / Save-Cancel footer for a drawer that saves EVERY section at once.
 *
 * Replaces the per-section Save: a form used to need one confirmation per field group, so changing
 * a machine's name, teams and owners meant three Edit→Save cycles. Here the whole form goes into
 * edit mode together and commits once.
 */
export function SaveBar({ editing, canEdit, dirty, busy, onEdit, onCancel, onSave, labels }: {
  editing: boolean
  canEdit: boolean
  /** Nothing changed → Save is inert, so a no-op cannot fire requests. */
  dirty: boolean
  busy?: boolean
  onEdit: () => void
  onCancel: () => void
  onSave: () => void
  labels: { edit: string; save: string; cancel: string; saving: string }
}) {
  const isMobile = useIsMobile()
  if (!canEdit) return null
  const base: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    minHeight: isMobile ? 44 : undefined, width: isMobile ? '100%' : undefined,
    borderRadius: 7, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
  }
  if (!editing) {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 18 }}>
        <button type="button" onClick={onEdit} style={{
          ...base, padding: isMobile ? '0 14px' : '8px 14px',
          border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)',
        }}><Pencil size={13} /> {labels.edit}</button>
      </div>
    )
  }
  return (
    <div style={{
      display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18,
      // Save above Cancel on mobile, while Cancel stays first in the DOM — the thumb should land
      // on the confirming action, not the discarding one.
      flexDirection: isMobile ? 'column-reverse' : 'row',
    }}>
      <button type="button" onClick={onCancel} disabled={busy} style={{
        ...base, padding: isMobile ? '0 12px' : '7px 12px',
        border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)',
        opacity: busy ? 0.5 : 1, cursor: busy ? 'not-allowed' : 'pointer',
      }}>{labels.cancel}</button>
      <button type="button" onClick={onSave} disabled={busy || !dirty} style={{
        ...base, padding: isMobile ? '0 14px' : '8px 14px',
        border: '1px solid var(--anthropic-orange)',
        background: 'var(--anthropic-orange-dim)', color: 'var(--anthropic-orange)',
        opacity: (busy || !dirty) ? 0.5 : 1,
        cursor: (busy || !dirty) ? 'not-allowed' : 'pointer',
      }}><Check size={14} /> {busy ? labels.saving : labels.save}</button>
    </div>
  )
}


/**
 * Where a popover should be drawn, in VIEWPORT coordinates.
 *
 * Both pickers used to draw their panel as a `position: absolute` child of the trigger. Inside the
 * settings Drawer — whose body is `overflowY: auto` — that panel is clipped by the scroll container,
 * so once the form had enough content to scroll, the panel opened into a box that cut it off. The
 * tag editor is where this bit: its pickers looked dead because the list was open and out of sight.
 *
 * They also chose their direction by measuring the WINDOW while the DRAWER was what clipped them, so
 * "there is room below" was being answered about the wrong box.
 *
 * `fixed` fixes both at once: no ancestor's overflow can clip it, and the viewport really is the box
 * it is measured against. The cost is that the panel no longer follows the trigger on scroll, which
 * is why the callers close on scroll rather than chasing it — a panel that drifts away from the row
 * it belongs to is worse than one that closed.
 */
export interface PopoverRect { left: number; top?: number; bottom?: number; width: number }

export function popoverPosition(rect: DOMRect, maxHeight: number, viewportHeight: number): PopoverRect {
  const below = viewportHeight - rect.bottom
  const dropUp = below < maxHeight && rect.top > below
  return dropUp
    ? { left: rect.left, bottom: viewportHeight - rect.top + 4, width: rect.width }
    : { left: rect.left, top: rect.bottom + 4, width: rect.width }
}

/** The style a popover panel gets. `position: fixed` is the load-bearing part — see popoverPosition. */
export function popoverStyle(pos: PopoverRect | null): React.CSSProperties {
  return {
    position: 'fixed',
    left: pos?.left ?? 0,
    ...(pos?.bottom !== undefined ? { bottom: pos.bottom } : { top: pos?.top ?? 0 }),
    width: pos?.width,
    zIndex: 1200,
  }
}

export function Select({ value, onChange, options, placeholder, disabled, searchable, searchPlaceholder, defaultOpenForTest }: {
  value: string
  onChange: (v: string) => void
  /** `disabled` greys an option out and blocks selection; `hint` says why, inline. */
  options: { value: string; label: string; disabled?: boolean; hint?: string }[]
  placeholder?: string
  disabled?: boolean
  /** Show a type-to-filter box in the popover. Defaults on when there are many options. */
  searchable?: boolean
  /** Placeholder for the type-to-filter box. English by default, per the project language rule. */
  searchPlaceholder?: string
  /** Render the panel open, for the static-markup test that pins `position: fixed`. */
  defaultOpenForTest?: boolean
}) {
  const [open, setOpen] = React.useState(Boolean(defaultOpenForTest))
  const [activeIndex, setActiveIndex] = React.useState(-1)
  const [query, setQuery] = React.useState('')
  const wrapperRef = React.useRef<HTMLDivElement>(null)
  const listRef = React.useRef<HTMLDivElement>(null)
  const searchRef = React.useRef<HTMLInputElement>(null)
  const isMobile = useIsMobile()
  // The panel is `position: fixed`, anchored to the trigger's viewport rect — see popoverPosition.
  // Absolute positioning made it a child of the Drawer's `overflowY: auto` body, which clipped it
  // as soon as the form was long enough to scroll.
  const [pos, setPos] = React.useState<PopoverRect | null>(null)
  const POPOVER_MAX_H = 280

  const showSearch = searchable ?? options.length > 8
  const filtered = (showSearch && query.trim())
    ? options.filter(o => o.label.toLowerCase().includes(query.trim().toLowerCase()))
    : options

  const selectedLabel = options.find(o => o.value === value)?.label ?? placeholder ?? ''
  const isEmpty = !value

  React.useEffect(() => {
    if (!open) return
    const handleClickOutside = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    // A fixed panel does not follow its trigger, so scrolling the PAGE (or any ancestor) would
    // leave it hanging beside a row that has moved — closing is the honest answer there. But this
    // listener is capture-phase on `window`, so it also fires when the panel's OWN option list
    // scrolls (e.g. scrolling down to reach an option past the fold, or a keyboard/assistive
    // scroll-into-view) — closing on that closed the panel before a click on a lower option could
    // ever land, making any option beyond the visible fold unreachable. Only close for a scroll
    // whose target is outside this component's own DOM subtree.
    const onScroll = (e: Event) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open])

  // Keep the keyboard-highlighted option scrolled into view.
  React.useEffect(() => {
    if (!open || activeIndex < 0) return
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex])

  const openMenu = () => {
    setQuery('')
    const i = options.findIndex(o => o.value === value)
    setActiveIndex(i >= 0 ? i : 0)
    const rect = wrapperRef.current?.getBoundingClientRect()
    if (rect) setPos(popoverPosition(rect, POPOVER_MAX_H, window.innerHeight))
    setOpen(true)
    if (showSearch) setTimeout(() => searchRef.current?.focus(), 0)
  }
  const handleToggle = () => {
    if (disabled) return
    if (open) setOpen(false)
    else openMenu()
  }

  const handleSelect = (optValue: string) => {
    onChange(optValue)
    setOpen(false)
    setQuery('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault(); openMenu()
      }
      return
    }
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setActiveIndex(i => Math.min(filtered.length - 1, i + 1)); break
      case 'ArrowUp': e.preventDefault(); setActiveIndex(i => Math.max(0, i - 1)); break
      case 'Home': e.preventDefault(); setActiveIndex(0); break
      case 'End': e.preventDefault(); setActiveIndex(filtered.length - 1); break
      case 'Enter':
      case ' ': {
        // Space types into the search box; only Enter selects.
        if (e.key === ' ' && showSearch) return
        e.preventDefault()
        const opt = filtered[activeIndex]
        if (opt && !opt.disabled) handleSelect(opt.value)
        break
      }
      case 'Escape': e.preventDefault(); setOpen(false); break
      case 'Tab': setOpen(false); break
    }
  }

  return (
    <div ref={wrapperRef} style={{ position: 'relative', width: '100%' }}>
      <button
        type="button"
        onClick={handleToggle}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          width: '100%',
          padding: '8px 11px',
          background: 'var(--bg-elevated)',
          border: `1px solid ${open ? 'var(--anthropic-orange)' : 'var(--border)'}`,
          borderRadius: 8,
          fontSize: 13,
          color: isEmpty ? 'var(--text-tertiary)' : 'var(--text-primary)',
          fontFamily: 'inherit',
          textAlign: 'left',
          cursor: disabled ? 'not-allowed' : 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          transition: 'border-color 0.15s',
          opacity: disabled ? 0.5 : 1,
        }}
        onMouseEnter={e => {
          if (!disabled && !open) {
            (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--anthropic-orange)'
          }
        }}
        onMouseLeave={e => {
          if (!disabled && !open) {
            (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'
          }
        }}
      >
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selectedLabel}
        </span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          style={{
            flexShrink: 0,
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.15s',
          }}
        >
          <path
            d="M3 4.5L6 7.5L9 4.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <div
          ref={listRef}
          role="listbox"
          style={{
            ...popoverStyle(pos),
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            boxShadow: '0 8px 28px rgba(0,0,0,0.35)',
            maxHeight: POPOVER_MAX_H,
            overflowY: 'auto',
            padding: 4,
          }}
        >
          {showSearch && (
            <input
              ref={searchRef}
              value={query}
              onChange={e => { setQuery(e.target.value); setActiveIndex(0) }}
              onKeyDown={handleKeyDown}
              placeholder={searchPlaceholder ?? 'Search…'}
              style={{
                position: 'sticky', top: 0, zIndex: 1, width: '100%', boxSizing: 'border-box',
                margin: '0 0 4px', padding: isMobile ? '10px 9px' : '7px 9px', background: 'var(--bg-elevated)',
                border: '1px solid var(--border)', borderRadius: 6,
                // 16px minimum on mobile: below it, iOS Safari auto-zooms the viewport on focus.
                fontSize: isMobile ? 16 : 13,
                color: 'var(--text-primary)', outline: 'none', fontFamily: 'inherit',
              }}
            />
          )}
          {filtered.length === 0 && (
            <div style={{ padding: '8px 10px', fontSize: 12.5, color: 'var(--text-tertiary)' }}>—</div>
          )}
          {filtered.map((opt, idx) => {
            const isSelected = opt.value === value
            const isActive = idx === activeIndex
            return (
              <div
                key={opt.value}
                role="option"
                aria-selected={isSelected}
                aria-disabled={opt.disabled}
                title={opt.hint}
                onClick={() => { if (!opt.disabled) handleSelect(opt.value) }}
                onMouseEnter={() => setActiveIndex(idx)}
                style={{
                  padding: isMobile ? '11px 12px' : '8px 10px',
                  minHeight: isMobile ? 44 : undefined,
                  boxSizing: 'border-box',
                  borderRadius: 6,
                  fontSize: 13,
                  cursor: opt.disabled ? 'not-allowed' : 'pointer',
                  opacity: opt.disabled ? 0.45 : 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  color: (isActive || isSelected) ? 'var(--anthropic-orange)' : 'var(--text-primary)',
                  background: isActive ? 'var(--anthropic-orange-dim)' : 'transparent',
                  transition: 'background 0.1s, color 0.1s',
                }}
              >
                <span style={{ flex: 1 }}>{opt.label}</span>
                {opt.hint && (
                  <span style={{ fontSize: 11, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>{opt.hint}</span>
                )}
                {isSelected && (
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path
                      d="M3 7L6 10L11 4"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * MultiPicker — a Select-shaped trigger that opens a search + checkbox panel.
 *
 * Replaces the pair "single-value Select + a separate bulk button": one control lets the user
 * search, tick one, or tick several, and decide which they wanted only after seeing the list.
 * Values are committed on the confirm button, so a mis-tick costs nothing until then.
 *
 * The panel flips above the trigger when there is no room below (same measurement as Select) and
 * uses 44px rows and a 16px search input on mobile, so it stays usable on a phone.
 */
export function MultiPicker({
  options, onCommit, placeholder, searchPlaceholder, confirmLabel, selectAllLabel, emptyLabel, disabled,
  defaultOpenForTest,
}: {
  options: { value: string; label: string; disabled?: boolean; hint?: string }[]
  /** Called with everything ticked when the user confirms. Never called with an empty list. */
  onCommit: (values: string[]) => void
  placeholder: string
  searchPlaceholder: string
  /** Receives the tick count, e.g. n => `Add ${n}`. */
  confirmLabel: (n: number) => string
  selectAllLabel: string
  emptyLabel: string
  disabled?: boolean
  /** Render the panel open, for the static-markup test that pins `position: fixed`. */
  defaultOpenForTest?: boolean
}) {
  const isMobile = useIsMobile()
  const [open, setOpen] = React.useState(Boolean(defaultOpenForTest))
  const [picked, setPicked] = React.useState<string[]>([])
  const [query, setQuery] = React.useState('')
  // See popoverPosition: fixed, so the Drawer's scrolling body cannot clip it.
  const [pos, setPos] = React.useState<PopoverRect | null>(null)
  const wrapperRef = React.useRef<HTMLDivElement>(null)
  const searchRef = React.useRef<HTMLInputElement>(null)
  const PANEL_MAX_H = 340
  // Ticking a checkbox reliably delivers a SECOND, browser-generated click to the trigger button
  // right after (same coordinates, no intervening mousedown/mouseup — verified with instrumented
  // listeners; the trigger sits in normal flow below/above a `position: fixed` popover, and picking
  // an option is enough to reflow the page under it). That phantom click hit the trigger's
  // open-if-closed/close-if-open toggle and closed the panel before the pick could ever be
  // committed — the FIRST option beyond the very top of the list was unreachable. Stamping every
  // pick and having the trigger ignore a click landing within the same tick is what a fixed-position
  // popover anchored to a trigger still in normal flow needs, regardless of why the browser
  // re-delivers the click.
  const lastPickAtRef = React.useRef(0)

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? options.filter(o => `${o.label} ${o.value}`.toLowerCase().includes(q)) : options
  }, [options, query])

  const close = React.useCallback(() => { setOpen(false); setPicked([]); setQuery('') }, [])

  React.useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    // Same reason as Select — and the same over-broad fix: this capture-phase listener also fires
    // when the panel's OWN checkbox list scrolls (it has to, to fit more than a handful of
    // options), which closed the whole picker the moment a user scrolled to reach — let alone
    // clicked — anything past the first screenful. Only close for a scroll outside this component.
    const onScroll = (e: Event) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) close()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open, close])

  const openPanel = () => {
    if (disabled) return
    const rect = wrapperRef.current?.getBoundingClientRect()
    if (rect) setPos(popoverPosition(rect, PANEL_MAX_H, window.innerHeight))
    setOpen(true)
    setTimeout(() => searchRef.current?.focus(), 0)
  }

  const commit = () => {
    if (picked.length === 0) return
    onCommit(picked)
    close()
  }

  // Disabled rows can never be ticked, so "select all" is about the selectable ones only —
  // otherwise the box never reads as checked and the toggle looks broken.
  const selectable = filtered.filter(o => !o.disabled)
  const allShownPicked = selectable.length > 0 && selectable.every(o => picked.includes(o.value))

  return (
    <div ref={wrapperRef} style={{ position: 'relative', width: '100%' }}>
      <button
        type="button"
        onClick={() => {
          // See lastPickAtRef above — a click landing here within ~200ms of an in-panel pick is
          // the browser's phantom re-delivery, not a real second press on the trigger.
          if (Date.now() - lastPickAtRef.current < 200) return
          open ? close() : openPanel()
        }}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          width: '100%', padding: '8px 11px', minHeight: 44, boxSizing: 'border-box',
          background: 'var(--bg-elevated)',
          border: `1px solid ${open ? 'var(--anthropic-orange)' : 'var(--border)'}`,
          borderRadius: 8, fontSize: 13, color: 'var(--text-tertiary)', fontFamily: 'inherit',
          textAlign: 'left', cursor: disabled ? 'not-allowed' : 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{placeholder}</span>
        <ChevronDown size={13} style={{ flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
      </button>

      {open && (
        <div
          role="listbox"
          style={{
            ...popoverStyle(pos),
            background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8,
            boxShadow: '0 8px 28px rgba(0,0,0,0.35)', padding: 6,
            display: 'flex', flexDirection: 'column', gap: 6, maxHeight: PANEL_MAX_H,
          }}
        >
          <input
            ref={searchRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={searchPlaceholder}
            style={{
              width: '100%', boxSizing: 'border-box', padding: isMobile ? '10px 9px' : '7px 9px',
              background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 6,
              fontSize: isMobile ? 16 : 13, color: 'var(--text-primary)', outline: 'none', fontFamily: 'inherit',
            }}
          />
          {filtered.length > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', minHeight: isMobile ? 44 : 30, paddingLeft: 2 }}>
              <Checkbox
                checked={allShownPicked}
                onChange={c => { lastPickAtRef.current = Date.now(); setPicked(c ? filtered.filter(o => !o.disabled).map(o => o.value) : []) }}
                label={selectAllLabel}
              />
            </div>
          )}
          <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            {filtered.length === 0 && (
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)', padding: '8px 4px' }}>{emptyLabel}</span>
            )}
            {filtered.map(o => (
              <div key={o.value}
                title={o.hint}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, minHeight: isMobile ? 44 : 32, paddingLeft: 2,
                  opacity: o.disabled ? 0.45 : 1, pointerEvents: o.disabled ? 'none' : undefined,
                }}>
                <Checkbox
                  checked={!o.disabled && picked.includes(o.value)}
                  onChange={c => { if (o.disabled) return; lastPickAtRef.current = Date.now(); setPicked(prev => c ? [...prev, o.value] : prev.filter(v => v !== o.value)) }}
                  label={o.label}
                />
                {o.hint && <span style={{ fontSize: 11, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>{o.hint}</span>}
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={commit}
            disabled={picked.length === 0}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              padding: '0 14px', minHeight: 44, borderRadius: 7,
              border: '1px solid var(--anthropic-orange)', background: 'var(--anthropic-orange-dim)',
              color: 'var(--anthropic-orange)', fontSize: 12.5, fontWeight: 600,
              cursor: picked.length === 0 ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
              opacity: picked.length === 0 ? 0.5 : 1,
            }}
          >
            {confirmLabel(picked.length)}
          </button>
        </div>
      )}
    </div>
  )
}
