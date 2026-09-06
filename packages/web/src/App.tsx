import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { Outlet, NavLink, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { createPortal } from 'react-dom'
import { version } from '../../../package.json'
import {
  Activity, AlertTriangle, ArrowLeft, ArrowRight, BarChart2, Bot,
  Calendar, CheckCircle, ChevronDown, ChevronLeft, ChevronRight, ChevronUp,
  Clock, Code2, Cpu, Database, DollarSign, Download,
  FileCode, FileDown, FileText, Flame, FolderOpen, GitBranch,
  GitCommit, GitCompare, Globe, Home, KeyRound, Layers,
  LogOut, Maximize2, MessageSquare, MessagesSquare, Moon, MoreHorizontal,
  PanelLeft, RefreshCw, Server, Settings, Shield, ShieldCheck,
  SlidersHorizontal, Sparkles, Sun, Tag as TagIcon, Target, TerminalSquare,
  TrendingUp, Trophy, Users, Wrench, X, Zap,
  ZoomIn,
} from 'lucide-react'
import { useData, useDerivedStats, LIVE_INTERVAL_OPTIONS, LIVE_INTERVAL_OPTIONS_RISKY } from './hooks/useData'
import { usePlanBasis } from './hooks/usePlanBasis'
import { planScopeHarnesses, planScopeNote } from './lib/costBasis'
import { bootLoading } from './lib/bootPhase'
import { DEFAULT_CARD_ORDER, migrateCardOrder, type CardId } from './lib/cardOrder'
import { BillingIntroModal } from './components/BillingIntroModal'
import type { LoadProgress } from './hooks/useData'
import { useIsMobile } from './hooks/useIsMobile'
import { useAccessibility } from './hooks/useAccessibility'
import type { TagDef } from './lib/tagMatch'
import { canCreateTagFromFilters, filtersToTagDraft } from './lib/filtersToTag'
import type { BillingSettings, CostBasis, Filters, HarnessId, HealthIssue, SavedComparison, TeamConfig } from '@agentistics/core'
import type { Lang, Theme } from '@agentistics/core'
import { billingReadiness, monthlyCommitment, normalizeBillingSettings, normalizeComparisons, planAllocation, formatProjectName, MODEL_PRICING, distinctUsers, distinctHarnesses, filterByUsers, fmtCost, HARNESS_ORDER, readTeamConnections, fmt, totalTokens, totalTokensExplained } from '@agentistics/core'
import { buildDeniedRepoLabels } from './lib/shareRepos'
import { StatCard } from './components/StatCard'
import { StreakBreakdownButton } from './components/StreakBreakdownButton'
import { ActivityHeatmap } from './components/ActivityHeatmap'
import { ActivityChart } from './components/ActivityChart'
import { HourChart } from './components/HourChart'
import { ModelBreakdown } from './components/ModelBreakdown'
import { ProjectsList } from './components/ProjectsList'
import { FiltersBar } from './components/FiltersBar'
import { NotificationToasts } from './components/NotificationToasts'
import { MagnifierLayer } from './components/a11y/MagnifierLayer'
import { HideLensesButton } from './components/a11y/HideLensesButton'
import { MagnifierButton } from './components/a11y/MagnifierButton'
import { NotificationBell } from './components/NotificationBell'
import { HardwareModal } from './components/HardwareModal'
import { useNotificationStream } from './hooks/useNotificationStream'
import { pushNotification } from './lib/notifications'
import { RecentSessions } from './components/RecentSessions'
import { HighlightsBoard } from './components/HighlightsBoard'
import { InfoModal } from './components/InfoModal'
import { PDFDirectExporter } from './components/PDFExportModal'
import { HealthWarnings } from './components/HealthWarnings'
import { ToolMetricsPanel } from './components/ToolMetricsPanel'
import { AgentMetricsPanel } from './components/AgentMetricsPanel'
import { CacheHitRatePanel } from './components/CacheHitRatePanel'
import { BudgetPanel } from './components/BudgetPanel'
import { SessionDrilldownModal } from './components/SessionDrilldownModal'
import { TranscriptModal } from './components/TranscriptModal'
import type { PrefsDraft, AppContext } from './lib/app-context'
import { TtyChat } from './components/TtyChat'
import { UpdateModal } from './components/UpdateModal'
import { InstallModal } from './components/InstallModal'
import { ArchiveConsentModal, type ArchiveMode } from './components/ArchiveConsentModal'
import { resolveArchiveChoice } from './lib/archive'
import { TeamLogin } from './components/TeamLogin'
import { Login } from './components/Login'
import { ModeSwitch } from './components/nav/ModeSwitch'
import { TopBar } from './components/nav/TopBar'
import { COST_BASIS_W, FULL_BAR_W, headerFit, stripPadding } from './lib/headerFit'
import { toggleArtifacts, useArtifacts } from './lib/artifactsStore'
import { SessionsAside } from './components/nav/SessionsAside'
import { SessionsRail } from './components/nav/SessionsRail'
import { getPinnedIds } from './lib/pinnedSessions'
import {
  DEFAULT_ORDER, sortSessions, type ControlSession,
} from '@agentistics/tui/control/session-fleet'
import { AsideResizer } from './components/nav/AsideResizer'
import { modeOfPath } from './lib/workspaceMode'
import { ASIDE_DEFAULT } from './lib/asideWidth'
import { useFleet, useFleetIndex, type FleetActionId } from './lib/fleet'
import { Segment } from './components/sessions/SessionPanel'
import { SessionActions } from './components/sessions/SessionActions'
import { MemberConnectionStatus } from './components/MemberConnectionStatus'
import { OwnerSetup } from './components/OwnerSetup'
import { ChangePassword } from './components/ChangePassword'
import { ChangePasswordSelf } from './components/ChangePasswordSelf'
import { MfaSetup } from './components/MfaSetup'
import { StepUpPrompt } from './components/StepUpPrompt'
import { type ChatModelId } from './lib/chatModels'
import { HARNESS_LABELS } from './lib/harness'
import { format, parseISO, parse } from 'date-fns'
import { ToggleSwitch } from './components/ToggleSwitch'
import { fleetFilterOptions, filterFleet, SESSION_FILTER_DIMS } from './lib/fleetFilter'
import { runningConversationIds } from './lib/activeConversations'
import { CentralSessions } from './components/sessions/CentralSessions'
// The sessions workspace's container geometry, named ONCE (see FleetOverview's header): the
// filter row in the strip and the body under it have to move together at every width.
import { PAGE_INSET, PAGE_MAX_WIDTH } from './components/sessions/FleetOverview'
import { setFleetSourceCentral } from './lib/fleet'
import { sessionPath } from './lib/sessionRoute'
import { SessionStatsMenu } from './components/sessions/SessionStatsMenu'

/**
 * What the SESSIONS filter bar may filter by — narrower than the dashboard's on purpose: a fleet
 * row is a live session, so member, team, machine, presence and tag have nothing to say about one,
 * and an option is a promise that something might be behind it.
 *
 * "Active only" is deliberately ABSENT: it is not a `Filters` dimension at all (see `FiltersBar`'s
 * doc comment on `onActiveOnlyChange`) and is rendered by passing that callback instead.
 */
/**
 * What the sessions workspace's filter bar may offer.
 *
 * Held in `fleetFilter.ts`, beside the function that HONOURS these dimensions, so the two can never
 * disagree — see the note there for how they did.
 */
const SESSIONS_FILTER_DIMS = SESSION_FILTER_DIMS as unknown as Array<'activeOnly' | 'harnesses' | 'repos' | 'projects' | 'models'>

// Team session state
interface TeamSessionState {
  required: boolean
  authed: boolean
  /** true when the server is running in central (hub) mode */
  central?: boolean
  /** true when a central has NO local harness data (pure aggregator) — hide local-only UI
   *  (archive consent gate, Nay chat) that only makes sense with a local harness installed. */
  aggregatorOnly?: boolean
  /** How reachable this instance is (server/exposure.ts). */
  profile?: 'local' | 'lan' | 'public'
  /** Local host-power capabilities the server still grants. Undefined on an older server
   *  (treat as granted); the server is the enforcement point either way. */
  capabilities?: {
    localShell?: boolean
    localChat?: boolean
    localTranscripts?: boolean
    mcpAdmin?: boolean
  }
  /** What the chat endpoints will actually answer: the capability AND the user's own switch.
   *  Undefined on an older server, which had no switch — treated as "the capability decides",
   *  so upgrading the web ahead of the server never hides a chat that still works. */
  chatEnabled?: boolean
}

export interface IamAccount { id: string; name: string; email: string; role: 'owner' | 'member'; memberships: { teamId: string; role: 'manager' | 'user' }[]; mustChangePassword: boolean }
interface IamState {
  needsBootstrap: boolean
  authed: boolean
  account?: IamAccount
  /** The server refuses this owner's requests until a second factor exists. Reported by
   *  /api/iam/me so the app can show the enrolment screen instead of a wall of 403s. */
  mfaEnrollmentRequired?: boolean
}

// Phase 1: parallel (statsCache + sessions + health). Phase 2: projects. Phase 3: finalizing.
const LOAD_STAGES: { key: string; labelPt: string; labelEn: string; icon: React.ReactNode; phase: 1 | 2 | 3 }[] = [
  { key: 'statsCache', labelPt: 'Cache de estatísticas', labelEn: 'Stats cache',   icon: <Database size={13} />, phase: 1 },
  { key: 'sessions',   labelPt: 'Metadados de sessões',  labelEn: 'Session data',  icon: <FileText size={13} />, phase: 1 },
  { key: 'health',     labelPt: 'Verificações de saúde', labelEn: 'Health checks', icon: <Shield size={13} />,   phase: 1 },
  { key: 'projects',   labelPt: 'Escaneando projetos',   labelEn: 'Project scan',  icon: <FolderOpen size={13} />, phase: 2 },
  { key: 'finalizing', labelPt: 'Totalizando tokens',    labelEn: 'Counting tokens', icon: <Zap size={13} />,    phase: 3 },
]

function formatStageDetail(key: string, detail: string, lang: string): string {
  const n = Number(detail)
  if (isNaN(n) || n === 0) return ''
  if (key === 'sessions') return `${n.toLocaleString()} ${lang === 'pt' ? 'sessões' : 'sessions'}`
  if (key === 'projects') return `${n.toLocaleString()} ${lang === 'pt' ? 'projetos' : 'projects'}`
  if (key === 'finalizing') {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tokens`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K tokens`
    return `${n.toLocaleString()} tokens`
  }
  return n.toLocaleString()
}

function LoadingScreen({ lang, loadProgress }: { lang: string; loadProgress: LoadProgress }) {
  // Group phase 1 stages to show parallel badge
  const phase1Done = ['statsCache', 'sessions', 'health'].filter(k => loadProgress[k]?.status === 'done').length

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 28,
      background: 'var(--bg-base)',
    }}>
      <style>{`
        @keyframes loadShimmer {
          0%{background-position:200% center}
          100%{background-position:-200% center}
        }
        @keyframes loadIndeterminate {
          0%{transform:translateX(-100%)}
          100%{transform:translateX(400%)}
        }
        @keyframes loadFadeUp {
          from{opacity:0;transform:translateY(10px)}
          to{opacity:1;transform:translateY(0)}
        }
        @keyframes loadIconGlow {
          0%,100%{box-shadow:0 0 0 0 rgba(217,119,6,0),0 0 10px 2px rgba(217,119,6,0.2)}
          50%{box-shadow:0 0 0 6px rgba(217,119,6,0),0 0 20px 5px rgba(217,119,6,0.35)}
        }
      `}</style>

      {/* Icon */}
      <div style={{ animation: 'loadFadeUp 0.35s ease-out both' }}>
        <div style={{
          width: 48, height: 48,
          background: 'var(--anthropic-orange-dim)',
          borderRadius: 14,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          animation: 'loadIconGlow 2.2s ease-in-out infinite',
        }}>
          <BarChart2 size={22} color="var(--anthropic-orange)" />
        </div>
      </div>

      {/* Title + subtitle */}
      <div style={{ textAlign: 'center', animation: 'loadFadeUp 0.35s ease-out 0.08s both' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 5, letterSpacing: '-0.01em' }}>
          agentistics
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
          {lang === 'pt' ? 'Carregando seus dados...' : 'Loading your data...'}
        </div>
      </div>

      {/* Stage progress bars */}
      <div style={{
        width: 340,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        animation: 'loadFadeUp 0.35s ease-out 0.16s both',
      }}>
        {/* Phase label */}
        {phase1Done < 3 && (
          <div style={{ fontSize: 10, color: 'var(--text-tertiary)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 2 }}>
            {lang === 'pt' ? '⇉ Paralelo' : '⇉ Parallel'}
          </div>
        )}

        {LOAD_STAGES.map((stage, idx) => {
          const sp = loadProgress[stage.key]
          const progress = sp?.progress ?? 0
          const status = sp?.status ?? 'pending'
          const label = lang === 'pt' ? stage.labelPt : stage.labelEn
          const pct = Math.round(progress * 100)
          const detailStr = sp?.detail ? formatStageDetail(stage.key, sp.detail, lang) : ''
          // For phase separator
          const prevStage = LOAD_STAGES[idx - 1]
          const showSeparator = prevStage && prevStage.phase !== stage.phase && phase1Done === 3

          return (
            <React.Fragment key={stage.key}>
              {showSeparator && (
                <div style={{ height: 1, background: 'var(--border)', opacity: 0.4, margin: '2px 0' }} />
              )}
              <div>
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 6,
                }}>
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 7,
                    color: status === 'pending' ? 'var(--text-tertiary)' : 'var(--text-secondary)',
                    transition: 'color 0.25s',
                  }}>
                    <span style={{ opacity: status === 'pending' ? 0.35 : 0.8, display: 'flex', transition: 'opacity 0.25s' }}>
                      {stage.icon}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 500 }}>
                      {label}
                      {detailStr && status === 'done' && (
                        <span style={{ color: 'var(--text-tertiary)', fontWeight: 400, marginLeft: 7, fontSize: 11 }}>
                          {detailStr}
                        </span>
                      )}
                    </span>
                  </div>
                  <span style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: status === 'done' ? 'var(--anthropic-orange)' : status === 'active' ? 'var(--text-secondary)' : 'var(--text-tertiary)',
                    transition: 'color 0.25s',
                    minWidth: 34,
                    textAlign: 'right',
                    fontVariantNumeric: 'tabular-nums',
                  }}>
                    {status === 'pending' ? '—' : status === 'done' ? '✓' : pct > 0 ? `${pct}%` : '…'}
                  </span>
                </div>
                {/* Bar track */}
                <div style={{ height: 4, background: 'var(--bg-elevated)', borderRadius: 2, overflow: 'hidden', position: 'relative' }}>
                  {status === 'active' && pct === 0 ? (
                    // Indeterminate — shows loading activity before real progress arrives
                    <div style={{
                      position: 'absolute',
                      top: 0, bottom: 0,
                      width: '35%',
                      borderRadius: 2,
                      background: 'linear-gradient(90deg, transparent, rgba(217,119,6,0.55), transparent)',
                      animation: 'loadIndeterminate 1.6s ease-in-out infinite',
                    }} />
                  ) : (
                    <div style={{
                      height: '100%',
                      width: status === 'done' ? '100%' : `${pct}%`,
                      minWidth: status === 'active' && pct > 0 && pct < 100 ? 10 : undefined,
                      borderRadius: 2,
                      ...(status === 'active' ? {
                        backgroundImage: 'linear-gradient(90deg, var(--anthropic-orange) 0%, rgba(217,119,6,0.5) 50%, var(--anthropic-orange) 100%)',
                        backgroundSize: '200% 100%',
                        animation: 'loadShimmer 1.8s linear infinite',
                      } : {
                        background: status === 'done' ? 'var(--anthropic-orange)' : 'transparent',
                      }),
                      transition: 'width 0.3s ease-out',
                    }} />
                  )}
                </div>
              </div>
            </React.Fragment>
          )
        })}
      </div>
    </div>
  )
}

function Section({ title, children, action, onExpand, flashId, style: extraStyle }: {
  title: React.ReactNode
  children: React.ReactNode
  action?: React.ReactNode
  onExpand?: () => void
  flashId?: string
  style?: React.CSSProperties
}) {
  return (
    <div
      data-flash-id={flashId}
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        padding: '20px 22px',
        boxSizing: 'border-box',
        ...extraStyle,
      }}
    >
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 18,
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
          {title}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {action}
          {onExpand && (
            <button
              onClick={onExpand}
              title="Expandir"
              style={{
                width: 24, height: 24,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                borderRadius: 6,
                border: '1px solid var(--border)',
                background: 'transparent',
                color: 'var(--text-tertiary)',
                cursor: 'pointer',
                transition: 'all 0.15s',
                padding: 0,
              }}
              onMouseEnter={e => {
                ;(e.currentTarget as HTMLButtonElement).style.color = 'var(--text-primary)'
                ;(e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--text-tertiary)'
              }}
              onMouseLeave={e => {
                ;(e.currentTarget as HTMLButtonElement).style.color = 'var(--text-tertiary)'
                ;(e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'
              }}
            >
              <Maximize2 size={12} />
            </button>
          )}
        </div>
      </div>
      {children}
    </div>
  )
}

function ChartModal({ title, onClose, children }: {
  title: React.ReactNode
  onClose: () => void
  children: React.ReactNode
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 300,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 32,
        backdropFilter: 'blur(4px)',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          padding: '24px 28px',
          width: '100%',
          maxWidth: 1100,
          maxHeight: '90vh',
          overflow: 'auto',
          boxShadow: 'var(--shadow-elevated)',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: 20,
        }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
            {title}
          </div>
          <button
            onClick={onClose}
            style={{
              width: 28, height: 28,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              borderRadius: 7,
              border: '1px solid var(--border)',
              background: 'transparent',
              color: 'var(--text-tertiary)',
              cursor: 'pointer',
              transition: 'all 0.15s',
              padding: 0,
            }}
            onMouseEnter={e => { ;(e.currentTarget as HTMLButtonElement).style.color = 'var(--text-primary)' }}
            onMouseLeave={e => { ;(e.currentTarget as HTMLButtonElement).style.color = 'var(--text-tertiary)' }}
          >
            <X size={14} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}


function fmtDuration(ms: number): string {
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function LiveSettingsModal({
  lang, liveUpdates, setLiveUpdates, updateInterval, setUpdateInterval,
  riskyMode, setRiskyMode, highlightUpdates, setHighlightUpdates, onClose,
}: {
  lang: Lang
  liveUpdates: boolean
  setLiveUpdates: (v: boolean) => void
  updateInterval: number
  setUpdateInterval: (v: number) => void
  riskyMode: boolean
  setRiskyMode: (v: boolean) => void
  highlightUpdates: boolean
  setHighlightUpdates: (v: boolean) => void
  onClose: () => void
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const allIntervals = [
    ...(riskyMode ? LIVE_INTERVAL_OPTIONS_RISKY : []),
    ...LIVE_INTERVAL_OPTIONS,
  ]

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 400,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        backdropFilter: 'blur(4px)',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 14,
          padding: '24px',
          width: 360,
          boxShadow: '0 8px 40px rgba(0,0,0,0.4)',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 22 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Settings size={14} style={{ color: 'var(--text-secondary)' }} />
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
              {lang === 'pt' ? 'Configurações de live' : 'Live update settings'}
            </span>
          </div>
          <button
            onClick={onClose}
            style={{
              width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'transparent', border: '1px solid var(--border)', borderRadius: 7,
              color: 'var(--text-tertiary)', cursor: 'pointer',
            }}
          >
            <X size={13} />
          </button>
        </div>

        {/* Live on/off */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 2 }}>
              {lang === 'pt' ? 'Atualização em tempo real' : 'Live updates'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
              {lang === 'pt' ? 'Monitora mudanças automaticamente' : 'Automatically polls for changes'}
            </div>
          </div>
          <ToggleSwitch on={liveUpdates} onToggle={() => setLiveUpdates(!liveUpdates)} />
        </div>

        <div style={{ height: 1, background: 'var(--border)', marginBottom: 20 }} />

        {/* Update interval */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            {lang === 'pt' ? 'Intervalo de atualização' : 'Update interval'}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {allIntervals.map(opt => {
              const isRisky = opt.value < 10
              const active = updateInterval === opt.value
              return (
                <button
                  key={opt.value}
                  onClick={() => { setUpdateInterval(opt.value); if (!liveUpdates) setLiveUpdates(true) }}
                  style={{
                    padding: '5px 12px',
                    borderRadius: 6,
                    border: active
                      ? `1px solid ${isRisky ? '#ef4444' : 'var(--anthropic-orange)'}80`
                      : '1px solid var(--border)',
                    background: active
                      ? isRisky ? 'rgba(239,68,68,0.12)' : 'var(--anthropic-orange-dim)'
                      : 'var(--bg-elevated)',
                    color: active
                      ? isRisky ? '#ef4444' : 'var(--anthropic-orange)'
                      : 'var(--text-secondary)',
                    fontSize: 12, fontWeight: active ? 700 : 500,
                    cursor: 'pointer', fontFamily: 'inherit',
                    transition: 'all 0.1s',
                  }}
                >
                  {isRisky ? `⚡ ${opt.label}` : opt.label}
                </button>
              )
            })}
          </div>
        </div>

        <div style={{ height: 1, background: 'var(--border)', marginBottom: 20 }} />

        {/* Risky mode */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 20 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
              <Zap size={12} style={{ color: riskyMode ? '#ef4444' : 'var(--text-tertiary)' }} fill={riskyMode ? '#ef4444' : 'none'} />
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                {lang === 'pt' ? 'Modo arriscado' : 'Risky mode'}
              </span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
              {lang === 'pt'
                ? 'Desbloqueia intervalos abaixo de 10s (até 1s). Pode aumentar o uso de CPU e I/O.'
                : 'Unlocks sub-10s intervals (down to 1s). May increase CPU and I/O load.'}
            </div>
          </div>
          <ToggleSwitch
            on={riskyMode}
            onToggle={() => {
              const next = !riskyMode
              setRiskyMode(next)
              if (!next && updateInterval < 10) setUpdateInterval(10)
            }}
          />
        </div>

        <div style={{ height: 1, background: 'var(--border)', marginBottom: 20 }} />

        {/* Update highlights */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
              <Sparkles size={12} style={{ color: highlightUpdates ? 'var(--anthropic-orange)' : 'var(--text-tertiary)' }} />
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                {lang === 'pt' ? 'Destaques de atualização' : 'Update highlights'}
              </span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
              {lang === 'pt'
                ? 'Destaca visualmente as seções que mudaram na última atualização.'
                : 'Briefly glows sections that changed on the last data update.'}
            </div>
          </div>
          <ToggleSwitch on={highlightUpdates} onToggle={() => setHighlightUpdates(!highlightUpdates)} />
        </div>
      </div>
    </div>
  )
}

function fmtFull(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}


function fmtCostFull(usd: number, currency: 'USD' | 'BRL' = 'USD', rate = 1): string {
  if (currency === 'BRL') {
    const brl = usd * rate
    if (brl < 0.00001) return '<R$0,00001'
    const [intPart, decPart] = brl.toFixed(6).split('.')
    return `R$${(intPart ?? '0').replace(/\B(?=(\d{3})+$)/g, '.')},${decPart}`
  }
  if (usd < 0.000001) return '<USD 0.000001'
  return `USD ${usd.toFixed(6)}`
}

function MobileBottomNav({
  lang, harnesses, onRefresh, onOpenHardware, liveUpdates, onToggleLive, updateInterval, healthIssues, isCentral, hasWorkflows,
  principal, theme, onToggleTheme, onToggleLang, a11yEnabled,
}: {
  lang: Lang
  harnesses?: HarnessId[]
  onRefresh: () => void
  /** Hardware is a modal, not a destination — on mobile its entry point is a tile in this sheet. */
  onOpenHardware: () => void
  liveUpdates: boolean
  onToggleLive: () => void
  updateInterval: number
  healthIssues?: HealthIssue[]
  /** A central updates in real time via SSE — no Live toggle. */
  isCentral?: boolean
  hasWorkflows?: boolean
  /** Signed-in account. Absent on a solo machine with no IAM — the account block then hides. */
  principal?: IamAccount
  theme: Theme
  onToggleTheme: () => void
  onToggleLang: () => void
  /** Whether the magnifier feature is on. Once it is, the header button is the way in — a tile
   *  here too would be a second entry point to the same screen. */
  a11yEnabled: boolean
}) {
  const location = useLocation()
  const navigate = useNavigate()
  const pt = lang === 'pt'
  const [moreOpen, setMoreOpen] = useState(false)
  const orange = 'var(--anthropic-orange)'
  // The sheet has two faces: the tile grid, and (after tapping the account row) the account
  // actions. A nested popover behaves badly on a phone, so we swap the body in place instead
  // of stacking another floating layer over the sheet.
  const [accountOpen, setAccountOpen] = useState(false)
  const [pwOpen, setPwOpen] = useState(false)
  const [mfaOpen, setMfaOpen] = useState(false)
  const roleLabel = principal
    ? (principal.role === 'owner' ? 'Owner' : (principal.memberships.some(m => m.role === 'manager') ? 'Manager' : 'User'))
    : ''
  const logout = () => { void fetch('/api/iam/logout', { method: 'POST' }).then(() => window.location.reload()) }
  const closeSheet = () => { setMoreOpen(false); setAccountOpen(false) }

  // Primary destinations live in the bar; the rest go behind a "More" sheet so
  // the bar never crams more than 5 slots on a narrow phone.
  const primary = [
    { to: '/',         labelPt: 'Home',       labelEn: 'Home',      icon: Home },
    { to: '/costs',    labelPt: 'Custos',     labelEn: 'Costs',     icon: DollarSign },
    { to: '/projects', labelPt: 'Projetos',   labelEn: 'Projects',  icon: FolderOpen },
    { to: '/tools',    labelPt: 'Tools',      labelEn: 'Tools',     icon: Wrench },
  ] as const

  // Square tiles in the "More" sheet: nav destinations + the actions that used
  // to crowd the top header (settings, live toggle, refresh, warnings).
  type Tile = {
    key: string
    label: string
    icon: typeof Home
    onClick: () => void
    active?: boolean
    accent?: boolean
    badge?: string
  }
  // The switch's badge, from the SHARED fleet poll (see lib/fleet.ts) — no extra request.
  const { fleet: mobileFleet } = useFleet(lang === 'pt' ? 'pt' : 'en')
  const attention = mobileFleet.attention

  const navTiles: Tile[] = [
    { key: 'repositories', label: pt ? 'Repositórios' : 'Repositories', icon: GitBranch, onClick: () => { closeSheet(); navigate('/repositories') }, active: location.pathname.startsWith('/repositories') || location.pathname.startsWith('/repo') },
    // Members/machines only exist on a central — a solo machine has exactly one of each.
    ...(isCentral
      ? [{ key: 'members', label: pt ? 'Membros' : 'Members', icon: Users, onClick: () => { closeSheet(); navigate('/members') }, active: location.pathname.startsWith('/members') } as Tile]
      : []),
    { key: 'top', label: pt ? 'Top' : 'Top', icon: Trophy, onClick: () => { closeSheet(); navigate('/top') }, active: location.pathname.startsWith('/top') },
    { key: 'tags', label: 'Tags', icon: TagIcon, onClick: () => { closeSheet(); navigate('/tags') }, active: location.pathname.startsWith('/tags') },
    { key: 'custom', label: pt ? 'Personalizado' : 'Custom', icon: Layers, onClick: () => { closeSheet(); navigate('/custom') }, active: location.pathname.startsWith('/custom') },
    { key: 'export', label: pt ? 'Exportar' : 'Export', icon: FileDown, onClick: () => { closeSheet(); navigate('/export') }, active: location.pathname.startsWith('/export') },
    // Unconditional: the page's filter mode compares two SCOPES and needs no second harness.
    // Only the by-harness mode inside it stays gated.
    { key: 'compare', label: pt ? 'Comparar' : 'Compare', icon: GitCompare, onClick: () => { closeSheet(); navigate('/compare') }, active: location.pathname.startsWith('/compare') },
    // Only while the feature is OFF: once it's on, the header magnifier button (beside the bell)
    // is the way in, and two entry points to the same screen on a phone is one too many. Same
    // ZoomIn icon as the header button — one feature, one icon.
    ...(a11yEnabled
      ? []
      : [{ key: 'accessibility', label: pt ? 'Acessibilidade' : 'Accessibility', icon: ZoomIn, onClick: () => { closeSheet(); navigate('/settings/accessibility') }, active: location.pathname.startsWith('/settings/accessibility') } as Tile]),
  ]
  const activeIssueCount = healthIssues?.length ?? 0
  const actionTiles: Tile[] = [
    // Live toggle — hidden on a central (real-time via SSE, nothing to toggle).
    ...(isCentral ? [] : [{
      key: 'live', label: pt ? 'Ao vivo' : 'Live', icon: Activity,
      onClick: () => onToggleLive(), accent: liveUpdates,
      badge: liveUpdates ? (updateInterval >= 60 ? `${updateInterval / 60}m` : `${updateInterval}s`) : undefined,
    } as Tile]),
    { key: 'refresh', label: pt ? 'Atualizar' : 'Refresh', icon: RefreshCw, onClick: () => { onRefresh(); closeSheet() } },
    // An overlay, so it belongs with the actions: nothing in the bottom bar can be "on /hardware".
    { key: 'hardware', label: 'Hardware', icon: Cpu, onClick: () => { closeSheet(); onOpenHardware() } },
    { key: 'settings', label: pt ? 'Ajustes' : 'Settings', icon: SlidersHorizontal, onClick: () => { closeSheet(); navigate('/settings') }, active: location.pathname.startsWith('/settings') },
    // Theme and language live here because the sidebar that hosts them on desktop is not
    // rendered on mobile. Neither closes the sheet — you toggle and immediately re-judge.
    { key: 'theme', label: pt ? 'Tema' : 'Theme', icon: theme === 'dark' ? Sun : Moon, onClick: () => onToggleTheme() },
    { key: 'lang', label: pt ? 'Idioma' : 'Language', icon: Globe, onClick: () => onToggleLang(), badge: pt ? 'EN' : 'PT' },
    // Health warnings moved next to the notification bell in the mobile top bar (its own popover).
  ]
  const allTiles = [...navTiles, ...actionTiles]

  const navAction = navTiles.some(t => t.active)

  const itemStyle = (active: boolean): React.CSSProperties => ({
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    textDecoration: 'none',
    color: active ? orange : 'var(--text-tertiary)',
    fontSize: 10,
    fontWeight: active ? 700 : 500,
    transition: 'color 0.15s',
    padding: '6px 2px',
    overflow: 'hidden',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    fontFamily: 'inherit',
  })

  const labelStyle: React.CSSProperties = {
    width: '100%', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  }

  const accountActionStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 44,
    padding: '0 14px', borderRadius: 12, border: '1px solid var(--border)',
    background: 'var(--bg-elevated)', color: 'var(--text-primary)',
    fontSize: 13.5, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', textAlign: 'left',
  }

  return (
    <>
      {/* "More" bottom sheet — square tiles for bigger, friendlier tap targets */}
      <div
        onClick={() => closeSheet()}
        style={{
          position: 'fixed', inset: 0, zIndex: 310, background: 'rgba(0,0,0,0.45)',
          opacity: moreOpen ? 1 : 0,
          pointerEvents: moreOpen ? 'auto' : 'none',
          transition: 'opacity 0.25s ease',
        }}
      />
      <div style={{
        position: 'fixed', left: 0, right: 0, bottom: 'var(--mobile-nav-h)', zIndex: 320,
        background: 'var(--bg-surface)', borderTop: '1px solid var(--border)',
        borderRadius: '16px 16px 0 0', boxShadow: '0 -8px 30px rgba(0,0,0,0.35)',
        padding: '8px 12px 16px',
        transform: moreOpen ? 'translateY(0)' : 'translateY(110%)',
        transition: 'transform 0.28s cubic-bezier(0.22, 1, 0.36, 1)',
      }}>
        <div style={{
          width: 36, height: 4, borderRadius: 2, background: 'var(--border)',
          margin: '4px auto 12px',
        }} />
        {/* Account block — the mobile home for the profile menu that lives in the desktop
            sidebar. Without it a phone user has no way to change their password or log out. */}
        {principal && (
          <button
            onClick={() => setAccountOpen(o => !o)}
            aria-expanded={accountOpen}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 44,
              padding: '8px 10px', marginBottom: 10, borderRadius: 12,
              border: `1px solid ${accountOpen ? orange : 'var(--border)'}`,
              background: accountOpen ? 'var(--anthropic-orange-dim)' : 'var(--bg-elevated)',
              cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
            }}
          >
            <span style={{
              width: 32, height: 32, borderRadius: '50%', background: 'var(--bg-surface)',
              border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', flexShrink: 0,
            }}>{principal.name.slice(0, 2)}</span>
            <span style={{ minWidth: 0, flex: 1 }}>
              <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{principal.name}</span>
              <span style={{ display: 'block', fontSize: 10, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{roleLabel}</span>
              {!isCentral && <span style={{ display: 'block', marginTop: 3 }}><MemberConnectionStatus lang={lang} compact /></span>}
            </span>
            <ChevronDown size={16} style={{ flexShrink: 0, color: 'var(--text-tertiary)', transform: accountOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
          </button>
        )}
        {accountOpen && principal ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button
              onClick={() => { setAccountOpen(false); setMoreOpen(false); setPwOpen(true) }}
              style={accountActionStyle}
            >
              <KeyRound size={16} /> {pt ? 'Trocar senha' : 'Change password'}
            </button>
            <button
              onClick={() => { setAccountOpen(false); setMoreOpen(false); setMfaOpen(true) }}
              style={accountActionStyle}
            >
              <ShieldCheck size={16} /> {pt ? 'Duas etapas' : 'Two-factor'}
            </button>
            <button
              onClick={logout}
              style={{ ...accountActionStyle, color: '#ef4444', borderColor: 'color-mix(in srgb, #ef4444 40%, transparent)' }}
            >
              <LogOut size={16} /> {pt ? 'Sair' : 'Log out'}
            </button>
          </div>
        ) : (
        <>
        {/* The workspace switch. The aside that hosts it on desktop is not rendered on mobile, and
            a mode a phone cannot reach is a mode a phone cannot leave. */}
        <div style={{ marginBottom: 12 }}>
          <ModeSwitch lang={lang === 'pt' ? 'pt' : 'en'} attention={attention} />
        </div>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 8,
        }}>
          {allTiles.map(tile => {
            const Icon = tile.icon
            const lit = tile.active || tile.accent
            return (
              <button
                key={tile.key}
                onClick={tile.onClick}
                style={{
                  position: 'relative',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                  gap: 6, padding: '11px 4px',
                  borderRadius: 12,
                  border: `1px solid ${lit ? orange : 'var(--border)'}`,
                  background: lit ? 'var(--anthropic-orange-dim)' : 'var(--bg-elevated)',
                  color: lit ? orange : 'var(--text-primary)',
                  cursor: 'pointer', fontFamily: 'inherit',
                  fontSize: 11, fontWeight: 600,
                  transition: 'all 0.15s',
                }}
              >
                <Icon size={19} strokeWidth={1.8} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>{tile.label}</span>
                {tile.badge && (
                  <span style={{
                    position: 'absolute', top: 4, right: 5,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    minWidth: 15, height: 15, padding: '0 4px', borderRadius: 8,
                    background: orange, color: '#fff', fontSize: 9, fontWeight: 700,
                  }}>
                    {tile.badge}
                  </span>
                )}
              </button>
            )
          })}
        </div>
        </>
        )}
      </div>

      <nav
        className="mobile-bottom-nav"
        style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 330,
          background: 'var(--bg-surface)',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'stretch',
          // Height comes from .mobile-bottom-nav (56px + the home-indicator inset). An inline
          // `height: 56` would win over the class and re-break the installed PWA.
        }}
      >
        {primary.map(tab => {
          const active = tab.to === '/'
            ? location.pathname === '/'
            : location.pathname.startsWith(tab.to)
          const Icon = tab.icon
          return (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.to === '/'}
              onClick={() => closeSheet()}
              style={itemStyle(active)}
            >
              <Icon size={18} />
              <span style={labelStyle}>{pt ? tab.labelPt : tab.labelEn}</span>
            </NavLink>
          )
        })}
        <button
          onClick={() => { if (moreOpen) closeSheet(); else setMoreOpen(true) }}
          style={itemStyle(navAction || moreOpen)}
        >
          <div style={{ position: 'relative' }}>
            <MoreHorizontal size={18} />
          </div>
          <span style={labelStyle}>{pt ? 'Mais' : 'More'}</span>
        </button>
      </nav>

      {pwOpen && <ChangePasswordSelf lang={lang} onClose={() => setPwOpen(false)} />}
      {mfaOpen && <MfaSetup lang={lang} onClose={() => setMfaOpen(false)} canDisable={principal?.role !== 'owner'} />}
    </>
  )
}

/**
 * The fixed strip holding the mark, search and the sidebar toggle. The aside starts beneath it, so
 * those three controls never move when the sidebar changes width, changes body, or is collapsed.
 */
const TOPBAR_H = 44
const SIDEBAR_W = 248
const SIDEBAR_W_COLLAPSED = 64

/** Themed hover tooltip for the collapsed sidebar (icons only). Renders via a portal so it
 *  escapes the sidebar's overflow clipping. Active only when `show` is true (i.e. collapsed);
 *  when expanded the label is already visible, so it just renders its child untouched. */
function CollapsedTip({ label, show, children }: { label: string; show: boolean; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  if (!show) return <>{children}</>
  return (
    <div
      ref={ref}
      style={{ position: 'relative' }}
      onMouseEnter={() => { const r = ref.current?.getBoundingClientRect(); if (r) setPos({ top: r.top + r.height / 2, left: r.right + 10 }) }}
      onMouseLeave={() => setPos(null)}
    >
      {children}
      {pos && createPortal(
        <div role="tooltip" style={{
          position: 'fixed', top: pos.top, left: pos.left, transform: 'translateY(-50%)',
          background: 'var(--bg-card)', color: 'var(--text-primary)',
          border: '1px solid var(--border)', borderRadius: 7, padding: '5px 10px',
          fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
          boxShadow: '0 6px 20px rgba(0,0,0,0.35)', zIndex: 500, pointerEvents: 'none',
        }}>{label}</div>,
        document.body,
      )}
    </div>
  )
}

function SideNav({ lang, harnesses, isCentral, hasWorkflows, collapsed, width, onResize, onCommitWidth, onToggle, theme, onToggleTheme, onToggleLang, onExport, principal, sessionsFilters, sessionsActiveOnly }: {
  lang: Lang; harnesses?: HarnessId[]; isCentral?: boolean; hasWorkflows?: boolean
  collapsed: boolean; onToggle: () => void
  /** The width in force. Fixed in the dashboard workspace, user-set in the sessions one. */
  width: number
  onResize: (w: number) => void
  onCommitWidth: (w: number) => void
  theme: Theme; onToggleTheme: () => void; onToggleLang: () => void; onExport: () => void
  principal?: IamAccount
  /** The SAME filters/switch the shared header's `FiltersBar` edits — see `App.tsx`'s own state.
   *  `SideNav` only reads them, to hand to `SessionsAside`; it owns neither. */
  sessionsFilters: Filters
  sessionsActiveOnly: boolean
}) {
  const location = useLocation()
  // Which session is open, for the collapsed rail's selected highlight.
  const { sessionId } = useParams()
  const pt = lang === 'pt'
  // History, for the icon row. This ships as an installed PWA, where there is no browser chrome to
  // fall back on — in a plain tab they duplicate the browser's own, which is a cost worth paying
  // for the standalone case.
  const navigate = useNavigate()
  // Profile menu (popover anchored to the avatar) + self-service change-password modal.
  const [menuOpen, setMenuOpen] = useState(false)
  const [pwOpen, setPwOpen] = useState(false)
  const [mfaOpen, setMfaOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)
  const avatarRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (menuRef.current?.contains(t) || avatarRef.current?.contains(t)) return
      setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey) }
  }, [menuOpen])
  const openMenu = () => {
    const r = avatarRef.current?.getBoundingClientRect()
    if (r) setMenuPos({ top: r.top, left: r.right + 10 })
    setMenuOpen(o => !o)
  }
  const roleLabel = principal
    ? (principal.role === 'owner' ? 'Owner' : (principal.memberships.some(m => m.role === 'manager') ? 'Manager' : 'User'))
    : ''
  const logout = () => { void fetch('/api/iam/logout', { method: 'POST' }).then(() => window.location.reload()) }
  // Repositories highlights across the whole section (list, detail, actions) — Actions lives as a
  // tab inside each repo, so there's no sidebar submenu.
  const inReposSection = location.pathname.startsWith('/repositories') || location.pathname.startsWith('/repo')
  // How many sessions are waiting on a person, for the switch's badge. Read HERE rather than
  // passed down, because the aside must carry it in BOTH workspaces — the badge exists precisely
  // for the moment you are looking at the dashboard and a session starts needing you. `useFleet`
  // shares one poll across every consumer, so this costs no extra request. Never on a central: it
  // aggregates many machines and hosts none of their sessions.
  const { fleet, loading: fleetLoading, unsupported: fleetUnsupported, stale: fleetStale, act: fleetAct } = useFleet(pt ? 'pt' : 'en')
  const attention = fleet.attention
  // The row's context menu (Task 6) needs the verb-carrying shape, not the arrangement-only one —
  // `useFleetIndex` is the SAME map the header and the panel already build from `fleet.sessions`.
  const asideRowIndex = useFleetIndex(fleet.sessions)
  const mode = modeOfPath(location.pathname)
  // The collapsed rail's order — the SAME order the open list draws, so collapsing the aside never
  // reshuffles the sessions. Pinned first (that is what pinning is for), then `sortSessions(…,
  // DEFAULT_ORDER)` — the ranking the terminal cockpit breaks ties on, so "sorted by status" means
  // one thing everywhere.
  const railRows = useMemo(() => {
    const kept = filterFleet({ rows: fleet.rows, filters: sessionsFilters, activeOnly: sessionsActiveOnly }).rows
    const pinnedSet = new Set(getPinnedIds())
    const key = (r: ControlSession) => r.conversationId ?? r.id
    return [
      ...kept.filter(r => pinnedSet.has(key(r))),
      ...sortSessions(kept.filter(r => !pinnedSet.has(key(r))), DEFAULT_ORDER),
    ]
  }, [fleet.rows, sessionsFilters, sessionsActiveOnly])
  // A resize in progress. Only used to suspend the collapse animation — see the aside's `transition`.
  const [dragging, setDragging] = useState(false)

  const items: { to: string; labelPt: string; labelEn: string; icon: React.ReactNode }[] = [
    { to: '/',          labelPt: 'Home',         labelEn: 'Home',         icon: <Home size={17} /> },
    { to: '/costs',     labelPt: 'Custos',       labelEn: 'Costs',        icon: <DollarSign size={17} /> },
    { to: '/top',       labelPt: 'Top de uso',   labelEn: 'Top usage',    icon: <Trophy size={17} /> },
    { to: '/projects',  labelPt: 'Projetos',     labelEn: 'Projects',     icon: <FolderOpen size={17} /> },
    { to: '/repositories', labelPt: 'Repositórios', labelEn: 'Repositories', icon: <GitBranch size={17} /> },
    // Members/machines only exist on a central — a solo machine has exactly one of each.
    ...(isCentral ? [{ to: '/members', labelPt: 'Membros', labelEn: 'Members', icon: <Users size={17} /> }] : []),
    { to: '/tags',      labelPt: 'Tags',         labelEn: 'Tags',         icon: <TagIcon size={17} /> },
    { to: '/tools',     labelPt: 'Ferramentas',  labelEn: 'Tools',        icon: <Wrench size={17} /> },
    { to: '/custom',    labelPt: 'Personalizado',labelEn: 'Custom',       icon: <Layers size={17} /> },
    // Unconditional — see the mobile tile: comparing two filter scopes needs no second harness.
    { to: '/compare', labelPt: 'Comparar', labelEn: 'Compare', icon: <GitCompare size={17} /> },
  ]
  const footBtn: React.CSSProperties = {
    width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: 8, border: '1px solid var(--border)', background: 'transparent',
    color: 'var(--text-secondary)', cursor: 'pointer', transition: 'all 0.15s',
  }
  return (
    <aside style={{
      position: 'fixed', top: 'var(--ag-topbar-h)', left: 0, bottom: 0,
      width: collapsed ? SIDEBAR_W_COLLAPSED : width, zIndex: 200,
      background: 'var(--bg-surface)', borderRight: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column', padding: collapsed ? '12px 8px' : '14px 12px', boxSizing: 'border-box',
      // `fixed` is already a positioning context, so the resize handle on the edge places against
      // it. Visible overflow, because that handle straddles the border by design and clipping it
      // would leave half the hit area.
      overflow: 'visible',
      // The collapse ANIMATES; a drag must not. The width follows the pointer during a resize, and
      // a transition on it makes the edge lag behind the cursor and then catch up.
      transition: dragging ? 'none' : 'width 0.22s cubic-bezier(0.22, 1, 0.36, 1)',
    }}>
      {/* The workspace switch, PINNED above the scrolling body. */}
      <div style={{ padding: '0 2px 10px' }}>
        <ModeSwitch lang={lang} collapsed={collapsed} attention={attention} />
        {/* Member machine: live connection status + latency to the central. Null unless connected. */}
        {!collapsed && !isCentral && <div style={{ marginTop: 8 }}><MemberConnectionStatus lang={lang} compact /></div>}
      </div>

      {/* ONE aside, two bodies — never two asides. The shell above and the footer below are the
          same in both workspaces; only what sits between them changes. Collapsed, the sessions
          workspace draws the RAIL — sessions, not the dashboard's Home/Costs/Tools nav, which is
          the one thing this workspace certainly is not. */}
      {mode === 'sessions' ? (
        collapsed ? (
          <SessionsRail rows={railRows} {...(sessionId ? { selectedId: sessionId } : {})} />
        ) : (
        <>
        {/* On a central the workspace is ABOUT a machine, so the choice sits above the list it
            governs. Absent on a machine, which is its own. */}
        {isCentral && <div style={{ padding: '0 2px 8px' }}><CentralSessions lang={pt ? 'pt' : 'en'} /></div>}
        <SessionsAside
          lang={pt ? 'pt' : 'en'}
          rows={fleet.rows}
          finishedTasks={fleet.finishedTasks}
          loading={fleetLoading}
          unsupported={fleetUnsupported}
          filters={sessionsFilters}
          activeOnly={sessionsActiveOnly}
          {...(fleet.unavailable ? { unavailable: fleet.unavailable } : {})}
          stale={fleetStale}
          {...(isCentral ? { hideNew: true } : {})}
          rowsById={asideRowIndex}
          act={req => fleetAct({ ...req, action: req.action as FleetActionId })}
        />
        </>
        )
      ) : (
      <nav className="ag-noscroll" style={{ display: 'flex', flexDirection: 'column', gap: 5, overflowY: 'auto', overflowX: 'hidden', flex: 1, paddingTop: 4 }}>
        {items.map(item => {
          const active = item.to === '/'
            ? location.pathname === '/'
            : item.to === '/repositories'
              ? inReposSection
              : location.pathname.startsWith(item.to)
          const label = pt ? item.labelPt : item.labelEn
          return (
            <CollapsedTip key={item.to} label={label} show={collapsed}>
              <NavLink
                to={item.to}
                end={item.to === '/'}
                aria-label={collapsed ? label : undefined}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12, minWidth: 0,
                  // 40px of row. The list was laid out at 10px vertical padding and read as cramped
                  // — a nav item is a target as well as a label, and 36px is the floor for one.
                  padding: collapsed ? '11px 0' : '11px 12px', justifyContent: collapsed ? 'center' : 'flex-start',
                  borderRadius: 10, textDecoration: 'none',
                  fontSize: 13.5, fontWeight: active ? 700 : 500, fontFamily: 'inherit', whiteSpace: 'nowrap',
                  color: active ? 'var(--anthropic-orange)' : 'var(--text-secondary)',
                  background: active ? 'var(--anthropic-orange-dim)' : 'transparent',
                  transition: 'background 0.15s, color 0.15s',
                }}
                onMouseEnter={e => { if (!active) { const t = e.currentTarget as HTMLAnchorElement; t.style.color = 'var(--text-primary)'; t.style.background = 'var(--bg-elevated)' } }}
                onMouseLeave={e => { if (!active) { const t = e.currentTarget as HTMLAnchorElement; t.style.color = 'var(--text-secondary)'; t.style.background = 'transparent' } }}
              >
                <span style={{ flexShrink: 0, display: 'flex' }}>{item.icon}</span>
                {!collapsed && label}
              </NavLink>
            </CollapsedTip>
          )
        })}
      </nav>
      )}

      {/* The resize handle. In BOTH workspaces — the dashboard's labels benefit from a wider
          column too, and a control that exists on one screen and vanishes on the next reads as
          broken. Only while the sidebar is open: there is nothing to resize about a 64px rail. */}
      {!collapsed && (
        <AsideResizer
          width={width}
          onResize={w => { setDragging(true); onResize(w) }}
          onCommit={w => { setDragging(false); onCommitWidth(w) }}
          lang={pt ? 'pt' : 'en'}
        />
      )}

      {/* Footer — Row A account · thin divider · Row B config actions */}
      <div style={{ paddingTop: 10, marginTop: 6, borderTop: '1px solid var(--border)' }}>
        {/* Row A — account: a single profile button (avatar) opening a popover menu */}
        {principal && (
          <div style={{ display: 'flex', justifyContent: collapsed ? 'center' : 'stretch', paddingBottom: 10 }}>
            <CollapsedTip label={principal.name} show={collapsed}>
              <button ref={avatarRef} onClick={openMenu} aria-haspopup="menu" aria-expanded={menuOpen}
                title={collapsed ? undefined : principal.name}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, width: collapsed ? 'auto' : '100%',
                  padding: collapsed ? 0 : '4px 6px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit',
                  border: '1px solid transparent', background: menuOpen ? 'var(--bg-elevated)' : 'transparent', transition: 'background 0.15s',
                }}
                onMouseEnter={e => { if (!menuOpen) (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-elevated)' }}
                onMouseLeave={e => { if (!menuOpen) (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}>
                <span style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--bg-elevated)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11.5, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', flexShrink: 0 }}>{principal.name.slice(0, 2)}</span>
                {!collapsed && (
                  <span style={{ minWidth: 0, flex: 1, textAlign: 'left' }}>
                    <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{principal.name}</span>
                    <span style={{ display: 'block', fontSize: 10, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{roleLabel}</span>
                  </span>
                )}
                {!collapsed && <ChevronDown size={14} style={{ flexShrink: 0, color: 'var(--text-tertiary)' }} />}
              </button>
            </CollapsedTip>
          </div>
        )}

        {/* Profile popover — rendered via portal so it escapes the sidebar's overflow clip */}
        {principal && menuOpen && menuPos && createPortal(
          <div ref={menuRef} role="menu"
            style={{
              position: 'fixed', top: menuPos.top, left: menuPos.left, transform: 'translateY(-100%)',
              minWidth: 220, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8,
              boxShadow: '0 10px 30px rgba(0,0,0,0.35)', zIndex: 600, padding: 6,
            }}>
            <div style={{ padding: '8px 10px 10px', borderBottom: '1px solid var(--border)', marginBottom: 6 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{principal.name}</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{principal.email}</div>
              <div style={{ marginTop: 4, fontSize: 10, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{roleLabel}</div>
            </div>
            <button role="menuitem" onClick={() => { setMenuOpen(false); setPwOpen(true) }}
              style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '8px 10px', borderRadius: 7, border: 'none', background: 'transparent', color: 'var(--text-secondary)', fontSize: 13, fontWeight: 500, fontFamily: 'inherit', cursor: 'pointer', textAlign: 'left' }}
              onMouseEnter={e => { const t = e.currentTarget as HTMLButtonElement; t.style.background = 'var(--bg-elevated)'; t.style.color = 'var(--text-primary)' }}
              onMouseLeave={e => { const t = e.currentTarget as HTMLButtonElement; t.style.background = 'transparent'; t.style.color = 'var(--text-secondary)' }}>
              <KeyRound size={15} /> {pt ? 'Trocar senha' : 'Change password'}
            </button>
            <button role="menuitem" onClick={() => { setMenuOpen(false); setMfaOpen(true) }}
              style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '8px 10px', borderRadius: 7, border: 'none', background: 'transparent', color: 'var(--text-secondary)', fontSize: 13, fontWeight: 500, fontFamily: 'inherit', cursor: 'pointer', textAlign: 'left' }}
              onMouseEnter={e => { const t = e.currentTarget as HTMLButtonElement; t.style.background = 'var(--bg-elevated)'; t.style.color = 'var(--text-primary)' }}
              onMouseLeave={e => { const t = e.currentTarget as HTMLButtonElement; t.style.background = 'transparent'; t.style.color = 'var(--text-secondary)' }}>
              <ShieldCheck size={15} /> {pt ? 'Duas etapas' : 'Two-factor'}
            </button>
            <button role="menuitem" onClick={() => { setMenuOpen(false); logout() }}
              style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '8px 10px', borderRadius: 7, border: 'none', background: 'transparent', color: 'var(--text-secondary)', fontSize: 13, fontWeight: 500, fontFamily: 'inherit', cursor: 'pointer', textAlign: 'left' }}
              onMouseEnter={e => { const t = e.currentTarget as HTMLButtonElement; t.style.background = 'var(--bg-elevated)'; t.style.color = 'var(--text-primary)' }}
              onMouseLeave={e => { const t = e.currentTarget as HTMLButtonElement; t.style.background = 'transparent'; t.style.color = 'var(--text-secondary)' }}>
              <LogOut size={15} /> {pt ? 'Sair' : 'Log out'}
            </button>
          </div>,
          document.body,
        )}

        {/* Self-service change-password modal */}
        {pwOpen && <ChangePasswordSelf lang={lang} onClose={() => setPwOpen(false)} />}
      {mfaOpen && <MfaSetup lang={lang} onClose={() => setMfaOpen(false)} canDisable={principal?.role !== 'owner'} />}

        {/* Thin divider between account and actions */}
        {principal && <div style={{ height: 1, background: 'var(--border)', marginBottom: 10 }} />}

        {/* Row B — config actions (theme · language · export · settings), evenly spaced */}
        <div style={{ display: 'flex', flexDirection: collapsed ? 'column' : 'row', alignItems: 'center', gap: 6 }}>
          <CollapsedTip label={pt ? 'Tema' : 'Theme'} show={collapsed}>
            <button onClick={onToggleTheme} aria-label={pt ? 'Tema' : 'Theme'} title={collapsed ? undefined : (theme === 'dark' ? (pt ? 'Tema claro' : 'Light theme') : (pt ? 'Tema escuro' : 'Dark theme'))} style={{ ...footBtn, width: collapsed ? 34 : 'auto', flex: collapsed ? undefined : 1 }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-primary)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-secondary)' }}>
              {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
            </button>
          </CollapsedTip>
          <CollapsedTip label={pt ? 'Idioma' : 'Language'} show={collapsed}>
            <button onClick={onToggleLang} aria-label={pt ? 'Idioma' : 'Language'} title={collapsed ? undefined : (pt ? 'Switch to English' : 'Mudar para Português')} style={{ ...footBtn, width: collapsed ? 34 : 'auto', flex: collapsed ? undefined : 1, gap: 5, fontSize: 12, fontWeight: 600, fontFamily: 'inherit' }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-primary)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-secondary)' }}>
              <Globe size={14} />{!collapsed && (pt ? 'EN' : 'PT')}
            </button>
          </CollapsedTip>
          <CollapsedTip label={pt ? 'Exportar' : 'Export'} show={collapsed}>
            <button onClick={onExport} aria-label={pt ? 'Exportar relatório PDF' : 'Export PDF report'} title={collapsed ? undefined : (pt ? 'Exportar relatório PDF' : 'Export PDF report')}
              style={{ ...footBtn, width: collapsed ? 34 : 'auto', flex: collapsed ? undefined : 1, borderColor: 'var(--anthropic-orange)50', color: 'var(--anthropic-orange)', background: 'var(--anthropic-orange-dim)' }}>
              <Download size={15} />
            </button>
          </CollapsedTip>
          <CollapsedTip label={pt ? 'Configurações' : 'Settings'} show={collapsed}>
            <NavLink to="/settings" aria-label={pt ? 'Configurações' : 'Settings'} title={collapsed ? undefined : (pt ? 'Configurações' : 'Settings')} style={{ ...footBtn, width: collapsed ? 34 : 'auto', flex: collapsed ? undefined : 1, textDecoration: 'none' }}
              onMouseEnter={e => { (e.currentTarget as HTMLAnchorElement).style.color = 'var(--text-primary)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLAnchorElement).style.color = 'var(--text-secondary)' }}>
              <SlidersHorizontal size={15} />
            </NavLink>
          </CollapsedTip>
        </div>
      </div>
    </aside>
  )
}

export default function AppLayout() {
  const location = useLocation()
  const navigate = useNavigate()
  // Reset scroll to the top on every route change — otherwise navigating away while scrolled to the
  // bottom of a page lands the next page still scrolled down.
  useEffect(() => { window.scrollTo(0, 0) }, [location.pathname])
  // Pages that render their OWN filter bar(s) and must not get the header's as well. `/custom`
  // embeds one; `/compare?mode=filter` owns two, and three bars on one screen is not a page.
  const isCustomPage =
    location.pathname === '/custom'
    || (location.pathname === '/compare' && new URLSearchParams(location.search).get('mode') === 'filter')

  /** Which filter dimensions a page can actually react to. Top usage ranks by member, team,
   *  machine, presence, repo, tag, project and model, so those narrow it meaningfully — harness is
   *  left out because the page already breaks every dimension down per harness. Every other page
   *  gets the full set (undefined = no restriction). A filter that visibly changes nothing reads as
   *  broken, so it is better not to offer it. */
  const filterDimsForRoute = location.pathname.startsWith('/top')
    ? (['members', 'teams', 'machines', 'presence', 'repos', 'tags', 'projects', 'models'] as const).slice() as
      Array<'members' | 'teams' | 'machines' | 'presence' | 'repos' | 'tags' | 'projects' | 'models'>
    : undefined
  const isMobile = useIsMobile()
  const { data, loading, loadProgress, error, refetch, liveUpdates, setLiveUpdates, updateInterval, setUpdateInterval } = useData()
  const [riskyMode, setRiskyMode] = useState(false)
  const [lang, setLangState] = useState<Lang>('en')

  // Team session gate
  // undefined = not yet fetched, TeamSessionState after fetch
  const [teamSession, setTeamSession] = useState<TeamSessionState | undefined>(undefined)
  /**
   * Whether to offer the chat at all.
   *
   * `chatEnabled` is the server's own answer (capability AND the user's switch), so this is a
   * mirror of what /api/chat-tty would do rather than a second opinion about it. `undefined` means
   * an older server that has no switch — then the capability alone decides, exactly as before, so
   * a web bundle newer than its server never hides a chat that still works.
   */
  const chatOffered = teamSession?.chatEnabled ?? true
  // true when this instance is a team member pushing to a central (mode === 'member').
  // Used only to tailor the upgrade command shown in the UpdateModal.
  const [isMember, setIsMember] = useState(false)

  // IAM gate (central only)
  const [iam, setIam] = useState<IamState | undefined>(undefined)

  // `useAccessibility` is mounted here — ABOVE the `if (!iam.authed) return <Login/>` gate below —
  // so its own load effect always runs before that gate can block anything. On a central,
  // `/api/accessibility` answers 401 before sign-in and 403 before an owner's MFA enrolment
  // (`AUTH_PUBLIC` / `MFA_EXEMPT` in `server/index-routes.ts` name neither route), so a stable
  // identity of `undefined` through both of those states — collapsing to the account id only once
  // a session is fully authorized — is what lets the hook's load effect re-fire the moment one
  // becomes available, instead of being stuck forever with whatever its first, pre-auth fetch saw.
  // On a non-central machine the route is never gated, so a constant identity is correct: the
  // effect runs once, exactly as it always has.
  const a11yIdentity = !teamSession?.central
    ? 'solo'
    : (iam?.authed && !iam.mfaEnrollmentRequired ? (iam.account?.id ?? 'unknown-account') : undefined)
  const a11y = useAccessibility(a11yIdentity)

  const reloadIam = useCallback(() => {
    Promise.all([
      fetch('/api/iam/status').then(r => r.ok ? r.json() : { needsBootstrap: false }),
      fetch('/api/iam/me').then(r => r.ok ? r.json() : { authed: false }),
    ]).then(([st, me]) => setIam({ needsBootstrap: !!st.needsBootstrap, authed: !!me.authed, account: me.account, mfaEnrollmentRequired: !!me.mfaEnrollmentRequired }))
      .catch(() => setIam({ needsBootstrap: false, authed: false }))
  }, [])
  useEffect(() => { if (teamSession?.central) reloadIam() }, [teamSession?.central, reloadIam])

  useEffect(() => {
    fetch('/api/team/session')
      .then(r => r.ok ? (r.json() as Promise<TeamSessionState>) : null)
      .then(s => setTeamSession(s ?? { required: false, authed: true }))
      .catch(() => setTeamSession({ required: false, authed: true }))
  }, [])

  useEffect(() => {
    fetch('/api/team/status')
      .then(r => r.ok ? (r.json() as Promise<{ mode?: string }>) : null)
      .then(s => setIsMember(s?.mode === 'member'))
      .catch(() => {})
  }, [])

  // Flip to login screen when any API call returns 401 (team password set but cookie expired)
  useEffect(() => {
    if (error && error.includes('401') && teamSession?.required) {
      // SPREAD, never a fresh object. This line predates centrals (it was written when the only
      // gate was the shared team password) and replacing the whole state dropped `central`, which
      // is the flag deciding WHICH login screen renders. On a central every /api/data call 401s
      // until an account signs in, so the first one erased `central` and the app fell through to
      // the legacy shared-password form — a form the server retired ("shared-password login
      // retired; use account login"), so it could never succeed. Measured on a live central: the
      // account login screen was unreachable, with a working `/api/team/session` reporting
      // `central: true` on every poll.
      setTeamSession(s => ({ ...(s ?? {}), required: true, authed: false }))
    }
    // 403 too, and for a reason that cost someone their whole first-run: the moment an owner
    // account is created, the gate starts refusing /api/data with `mfa_enrollment_required`
    // until a second factor exists. The data layer only sees "HTTP 403" and renders "Failed to
    // load data" — a dead end, on the screen right after signing up. Re-reading the IAM state is
    // what turns that into the enrolment screen, which is the only thing that can clear it.
    if (teamSession?.central && (String(error).includes('401') || String(error).includes('403'))) reloadIam()
  }, [error, teamSession?.required, teamSession?.central, reloadIam])
  const [theme, setThemeState] = useState<Theme>(() => {
    // The LOCAL copy decides the first paint; `/api/preferences` corrects it a moment later if they
    // disagree. Starting from a constant meant a light-theme user got a dark flash on every load.
    try { return localStorage.getItem('agentistics-theme') === 'light' ? 'light' : 'dark' } catch { return 'dark' }
  })
  const [currency, setCurrencyState] = useState<'USD' | 'BRL'>('USD')

  // Surface server-pushed notifications (member connection/auth errors) as toasts + bell.
  useNotificationStream(lang)

  // A central updates in real time via SSE (presence + ingest), so it hides the Live toggle
  // and keeps live updates always on (the SSE 'change' subscription is gated on liveUpdates).
  const isCentral = teamSession?.central === true
  useEffect(() => { if (isCentral) setLiveUpdates(true) }, [isCentral, setLiveUpdates])

  const setLang = useCallback((l: Lang) => setLangState(l), [])
  /**
   * Set the theme AND remember it.
   *
   * It used to only set state, so the sidebar's and the mobile sheet's toggles changed the theme
   * for exactly as long as the tab lived and a refresh came back dark — only the Settings modal
   * ever wrote it. Reported.
   *
   * BOTH stores, deliberately. `preferences.json` is the durable one and is what a second browser
   * or a fresh profile reads; `localStorage` is what the pre-React guard in `index.html` reads to
   * stamp `data-theme` BEFORE the bundle loads, which is what stops a light-theme user seeing a
   * dark flash on every load. Writing only the server would keep that flash forever.
   */
  const setTheme = useCallback((t: Theme) => {
    setThemeState(t)
    try { localStorage.setItem('agentistics-theme', t) } catch { /* private mode */ }
    fetch('/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: t }),
    }).catch(() => { /* the local copy still holds for this browser */ })
  }, [])
  const setCurrency = useCallback((c: 'USD' | 'BRL') => setCurrencyState(c), [])

  // How this machine is actually billed. Local only — it never travels to a central.
  const [billing, setBilling] = useState<BillingSettings>({ profiles: {} })
  const [comparisons, setComparisons] = useState<SavedComparison[]>([])
  const saveComparisons = useCallback(async (next: SavedComparison[]) => {
    setComparisons(next)
    await fetch('/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comparisons: next }),
    })
  }, [])
  const [costBasisState, setCostBasisState] = useState<CostBasis>('api')
  const [billingSetupOpen, setBillingSetupOpen] = useState(false)
  // `writePreferencesTo` is a SHALLOW merge, so a partial PUT would replace the whole billing
  // object with the fragment. The complete settings always go over the wire.
  const saveBilling = useCallback(async (next: BillingSettings) => {
    setBilling(next)
    await fetch('/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ billing: next }),
    })
  }, [])
  const [brlRate, setBrlRate] = useState(5.70)
  const [filters, setFilters] = useState<Filters>({
    dateRange: 'all',
    customStart: '',
    customEnd: '',
    projects: [],
    models: [],
  })

  // "Create tag with these filters" — only offered once the active filters actually map to
  // something a tag can be built from (see filtersToTag.ts). The drawer opens on /tags pre-filled;
  // TagsPage reads `draftFromFilters` from router state the same way it already reads `editTagId`.
  const createTagFromFilters = useMemo(
    () => (canCreateTagFromFilters(filters, { central: isCentral })
      ? () => navigate('/tags', { state: { draftFromFilters: filtersToTagDraft(filters, { central: isCentral }) } })
      : undefined),
    [filters, isCentral, navigate],
  )
  const [infoModalIndex, setInfoModalIndex] = useState<number | null>(null)
  const [pdfDirectExportRange, setPdfDirectExportRange] = useState<string | null>(null)
  const [expandedChart, setExpandedChart] = useState<string | null>(null)
  const [selectedSession, setSelectedSession] = useState<import('@agentistics/core').SessionMeta | null>(null)

  // Keep the drilldown modal in sync when live data refreshes
  useEffect(() => {
    if (!selectedSession || !data) return
    const updated = data.sessions.find(s => s.session_id === selectedSession.session_id)
    if (updated && updated !== selectedSession) setSelectedSession(updated)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  const [monthlyBudgetUSD, setMonthlyBudgetUSD] = useState<number | null>(() => {
    try {
      const raw = localStorage.getItem('agentistics-monthly-budget-usd')
      if (!raw) return null
      const v = parseFloat(raw)
      return isNaN(v) ? null : v
    } catch { return null }
  })
  const updateBudget = useCallback((v: number | null) => {
    setMonthlyBudgetUSD(v)
    try {
      if (v === null) localStorage.removeItem('agentistics-monthly-budget-usd')
      else localStorage.setItem('agentistics-monthly-budget-usd', String(v))
    } catch { /* ignore quota/disabled storage */ }
  }, [])

  // The card id set and its migration are PURE and tested (`lib/cardOrder.ts`) — the order is
  // persisted, so a renamed id is a stored contract, not an implementation detail.
  const [cardOrder, setCardOrder] = useState<CardId[]>(() => {
    try {
      const saved = localStorage.getItem('claude-stats-card-order')
      if (saved) return migrateCardOrder(JSON.parse(saved))
    } catch {}
    return DEFAULT_CARD_ORDER
  })
  // Mobile-only: lets the user minimize the sticky filter bar while scrolling so
  // it doesn't eat the viewport on small screens. Expanded by default.
  const [filtersCollapsed, setFiltersCollapsed] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('agentistics-sidebar-collapsed') === '1' } catch { return false }
  })
  /**
   * The sessions workspace's sidebar width. Only that workspace is resizable: the dashboard's body
   * is a fixed list of labels with a known longest item, so a wider column buys nothing there and a
   * narrower one truncates words that were sized to fit. A session list is the opposite — the titles
   * are the user's own sentences.
   */
  const [asideWidth, setAsideWidth] = useState(ASIDE_DEFAULT)
  /**
   * Deliberately NOT persisted. The width holds for the whole visit — it survives switching
   * workspaces and moving between sessions — and a reload starts from the default again. That is
   * the user's call: a stored width is a decision that outlives the reason for it, and the one it
   * outlives worst is "I widened it to read one long title".
   */
  const commitAsideWidth = (_w: number) => { /* session-scoped by design; see above */ }
  // ONE width for both workspaces. Giving each its own made the aside jump every time the switch
  // was pressed — the sidebar visibly resizing on a control whose job is to change what is IN it.
  // Only the sessions workspace offers the handle, but whatever it is dragged to applies to both.
  const liveAsideWidth = asideWidth
  const inSessionsWorkspace = modeOfPath(location.pathname) === 'sessions'

  /**
   * The fixed strip is ONE row again.
   *
   * The active filters were briefly a full-width band inside it, which grew the strip and made
   * every element positioned below it depend on a measured height. They now drop from the filter
   * region itself (see `FiltersBar`'s "see active filters" panel), so the strip is a constant again
   * — but the variable stays, because the sidebar and the page shell read it now and one place
   * deciding where the header ends is the point of it.
   */
  useEffect(() => {
    document.documentElement.style.setProperty('--ag-topbar-h', `${isMobile ? 0 : TOPBAR_H}px`)
  }, [isMobile])

  /**
   * How much width the filter bar actually has in the strip, and what it therefore draws.
   *
   * The strip's middle is `overflow: hidden` so it can never paint over the view tabs again — but a
   * clipped control is unreachable with nothing on screen saying so, which is worse. So the bar is
   * TOLD how much room it has and gives the date block up first (`headerFit.ts` owns that order and
   * its thresholds). Only one of the two strips is mounted at a time, so one ref serves both.
   */
  const [filterSlotEl, setFilterSlotEl] = useState<HTMLDivElement | null>(null)
  const [filterSlotW, setFilterSlotW] = useState(0)
  useEffect(() => {
    if (!filterSlotEl) { setFilterSlotW(0); return }
    const read = () => setFilterSlotW(filterSlotEl.clientWidth)
    read()
    const ro = new ResizeObserver(read)
    ro.observe(filterSlotEl)
    return () => ro.disconnect()
  }, [filterSlotEl])
  /**
   * The dashboard strip's right-hand cluster, measured.
   *
   * The filters must read as centred IN THE HEADER, not merely centred in the box left over beside
   * the actions — those are different points, and the second one is visibly off. Centring inside a
   * `flex: 1` slot puts the middle at `(W - actions) / 2`; padding that slot by the cluster's own
   * width moves it back to `W / 2`.
   *
   * Measured rather than guessed because the cluster grows and shrinks with what it holds: the
   * health warnings appear only when there are issues, the update dot comes and goes, and the
   * central pill is absent on a solo machine. A constant would be right on one machine.
   */
  const [actionsEl, setActionsEl] = useState<HTMLDivElement | null>(null)
  const [actionsW, setActionsW] = useState(0)
  useEffect(() => {
    if (!actionsEl) { setActionsW(0); return }
    const read = () => setActionsW(actionsEl.offsetWidth)
    read()
    const ro = new ResizeObserver(read)
    ro.observe(actionsEl)
    return () => ro.disconnect()
  }, [actionsEl])

  // The compensating padding is not space the bar may draw in, so it is taken off first.
  /** The artifacts panel's open flag and count — see `artifactsStore` for why it is not a prop. */
  const artifacts = useArtifacts()

  /**
   * Active sessions only — the fleet's own dimension (see `FiltersBar`'s doc comment on
   * `onActiveOnlyChange`), not part of `Filters`. Defaults to ON the moment you land in the
   * Sessions workspace and OFF the moment you leave it, on EVERY visit — not a preference
   * remembered across navigation, because "what is running right now" and "everything on record"
   * are the natural defaults for those two places respectively, and a stale opposite default from
   * a previous visit would read as broken filtering rather than as a choice.
   */
  const [activeOnly, setActiveOnly] = useState(inSessionsWorkspace)
  useEffect(() => { setActiveOnly(inSessionsWorkspace) }, [inSessionsWorkspace])

  /**
   * The selected session's title/tabs/actions row, lifted UP into this shared header from
   * `SessionPanel` — which used to draw its own second bordered strip directly under this one, the
   * same information said twice in two different boxes. `useFleet` is a SHARED poll (see
   * `lib/fleet.ts`'s own header): calling it again here costs no extra request, it is the same
   * subscription `SideNav` already holds.
   */
  const { sessionId: selectedSessionId } = useParams()
  // A CENTRAL's fleet is the RELAY's, for the machine the aside's picker chose. Set once, here,
  // because the poller is module-scoped and every surface reads the same snapshot.
  useEffect(() => { setFleetSourceCentral(isCentral) }, [isCentral])
  const { fleet: headerFleet, act: headerFleetAct, unsupported: headerFleetUnsupported } = useFleet(lang === 'pt' ? 'pt' : 'en')
  /**
   * "Active only" needs a fleet to intersect against, on EITHER page. An exposed profile with no
   * host power, or a central with no machine chosen, both report `unsupported` here — offering the
   * dimension there would be a filter whose only possible answer is "nothing", the confident-zero
   * shape this whole file is written against.
   */
  const fleetReadable = !headerFleetUnsupported
  /**
   * What the SESSIONS filter bar may offer — derived from the FLEET, never from the dashboard's
   * metrics. The two are different universes: the metrics knew six harnesses on this machine while
   * the fleet held three, so the bar offered "antigravity" and picking it emptied the list. Nothing
   * was broken — there were genuinely no antigravity rows — but a filter that can only ever answer
   * "nothing" is indistinguishable from one that is failing, and it was reported as exactly that.
   * An option is a promise that something might be behind it.
   */
  const fleetOptions = useMemo(() => fleetFilterOptions(headerFleet.rows, activeOnly), [headerFleet.rows, activeOnly])
  const headerFleetIndex = useFleetIndex(headerFleet.sessions)
  const selectedFleetSession = inSessionsWorkspace && selectedSessionId !== undefined
    ? headerFleet.rows.find(r => r.id === selectedSessionId || r.conversationId === selectedSessionId)
    : undefined
  const selectedSessionRow = selectedFleetSession ? headerFleetIndex.get(selectedFleetSession.id) : undefined
  // The Chat/Terminal choice lives in the URL (`?view=`) rather than in state here or in
  // `SessionPanel`, so the ONE control (now in this shared header) and the ONE reader (the panel,
  // still deciding which component to mount) can never disagree about which view is showing without
  // threading a prop through `SessionsPage` for it.
  /** A session's panel is open on this screen — mobile chrome steps out of its way. */
  const sessionOpen = inSessionsWorkspace && selectedSessionId !== undefined

  const [sessionViewParams, setSessionViewParams] = useSearchParams()
  const sessionView: 'chat' | 'terminal' = sessionViewParams.get('view') === 'terminal' ? 'terminal' : 'chat'
  const setSessionView = useCallback((v: 'chat' | 'terminal') => {
    setSessionViewParams(prev => {
      const next = new URLSearchParams(prev)
      if (v === 'chat') next.delete('view')
      else next.set('view', v)
      return next
    }, { replace: true })
  }, [setSessionViewParams])

  const toggleSidebar = useCallback(() => setSidebarCollapsed(v => {
    const next = !v
    try { localStorage.setItem('agentistics-sidebar-collapsed', next ? '1' : '0') } catch { /* ignore */ }
    return next
  }), [])
  // The collapse animation needs `overflow: hidden` to clip the sliding panel,
  // but that also clips the Models dropdown popover. Keep it clipped only while
  // animating/collapsed; once an expand transition finishes, switch to visible
  // so the popover can overflow the header.
  const [filtersClip, setFiltersClip] = useState(false)
  const collapseFilters = () => { setFiltersClip(true); setFiltersCollapsed(true) }
  const expandFilters = () => { setFiltersClip(true); setFiltersCollapsed(false) }
  const [updateInfo, setUpdateInfo] = useState<{ current: string; latest: string } | null>(null)
  // Whether the full UpdateModal (a blocking, position:fixed/inset:0/z-9999 dialog) is open.
  // Separate from `updateInfo` on purpose: the version CHECK is automatic, but the MODAL must
  // never be — it sits on top of every drawer/popover in the app (all under z-index 2000), so an
  // update firing while a user has, say, the "New tag" source picker open silently eats every
  // click on the page with no visual cue on a dark theme (a 65%-black blur over an already
  // near-black background reads as almost no change). `updateInfo` still drives the toast/bell
  // (see the effect below) — that is the correct passive surface. The modal is opt-in, reached by
  // clicking that toast/bell entry (see the 'agentistics:open-update-modal' listener).
  const [showUpdateModal, setShowUpdateModal] = useState(false)
  // First-run archive consent gate: undefined = prefs not loaded, null = loaded but
  // not yet chosen (blocks the app), ArchiveMode = chosen.
  const [archiveChoice, setArchiveChoice] = useState<ArchiveMode | null | undefined>(undefined)
  // Task 13 — the hidden-repo badge: canonical repo key -> labels of the connections hiding it.
  // Populated from the same /api/preferences load `archiveChoice` uses below; empty map (never
  // undefined) so every consumer can read it without an extra "not loaded yet" branch.
  const [deniedRepoLabels, setDeniedRepoLabels] = useState<Map<string, string[]>>(new Map())
  /** Re-reads the connection list so the hidden-repo badge follows the rules instead of freezing at
   *  whatever they were on page load. The preferences effect below is mount-only and this is an
   *  SPA, so un-blocking a repository (or disconnecting the central entirely) used to leave
   *  `/repositories` still claiming "Hidden from 1 central" until a manual reload — told hidden,
   *  not hidden. Fired by `ConnectionsPanel`'s `onConnectionsChanged` after EVERY write it makes,
   *  which is the single source both `RepositoriesList` and `RepoDetailPage` read through. */
  const refreshDeniedRepoLabels = useCallback(() => {
    fetch('/api/preferences')
      .then(r => (r.ok ? r.json() : null))
      .then(prefs => { if (prefs) setDeniedRepoLabels(buildDeniedRepoLabels(readTeamConnections(prefs))) })
      .catch(() => { /* a failed refresh keeps the last-known map — never wipes the badges */ })
  }, [])
  const chooseArchive = useCallback((mode: ArchiveMode) => {
    setArchiveChoice(mode)
    fetch('/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archiveMode: mode }),
    })
      .then(() => refetch())
      .catch(() => {})
  }, [refetch])

  type PwaPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> }
  const [pwaPrompt, setPwaPrompt] = useState<PwaPrompt | null>(null)
  // Treat the Tauri desktop app as "already installed" — it must never show the
  // PWA install prompt (it IS the app). Tauri v2 exposes these globals.
  const isTauri = typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  const [pwaInstalled, setPwaInstalled] = useState(() =>
    isTauri || (typeof window !== 'undefined' && window.matchMedia('(display-mode: standalone)').matches)
  )
  useEffect(() => {
    const handler = (e: Event) => { e.preventDefault(); setPwaPrompt(e as PwaPrompt) }
    window.addEventListener('beforeinstallprompt', handler)
    // If the user installs, the appinstalled event fires
    const onInstalled = () => { setPwaInstalled(true); setPwaPrompt(null) }
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', handler)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  const INSTALL_DISMISSED_KEY = 'agentistics-install-dismissed'
  const [showInstallModal, setShowInstallModal] = useState(false)
  // Dismissal is persisted SERVER-SIDE (survives incognito, where localStorage is wiped).
  // undefined = prefs not loaded yet → don't show until we know; true = don't show.
  const [installDismissedPref, setInstallDismissedPref] = useState<boolean | undefined>(undefined)
  const installModalShownRef = React.useRef(false)
  // Show install modal once after first data load, unless dismissed or already installed
  useEffect(() => {
    if (installModalShownRef.current) return
    // A central is a server, not an end-user machine — never prompt to install the app there
    // (and its prefs are ephemeral/read-only in Docker, so a dismiss wouldn't persist anyway).
    if (isCentral) return
    if (!data || loading) return
    if (pwaInstalled) return
    if (installDismissedPref === undefined) return // wait for prefs to load
    if (installDismissedPref) return
    try { if (localStorage.getItem(INSTALL_DISMISSED_KEY) === 'true') return } catch {}
    installModalShownRef.current = true
    setShowInstallModal(true)
  }, [data, loading, pwaInstalled, installDismissedPref, isCentral])
  const [chatModel, setChatModel] = useState<ChatModelId | null>(null)
  const [chatSoundEnabled, setChatSoundEnabled] = useState(true)
  const [chatSoundId, setChatSoundId] = useState('ping')

  const [cardPrecision, setCardPrecisionState] = useState<Record<string, boolean>>({})
  const precisionSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const setCardPrecision = useCallback((id: string, v: boolean) => {
    setCardPrecisionState(prev => {
      const next = { ...prev, [id]: v }
      if (precisionSaveTimer.current) clearTimeout(precisionSaveTimer.current)
      precisionSaveTimer.current = setTimeout(() => {
        fetch('/api/preferences', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cardPrecision: next }),
        }).catch(() => {})
      }, 400)
      return next
    })
  }, [])

  // Persist a full preferences draft — applies to global state + PUTs /api/preferences.
  // Threaded to the Preferences settings page (and reused by the legacy Settings modal onSave).
  const savePreferences = useCallback((draft: PrefsDraft) => {
    setLangState(draft.lang)
    setThemeState(draft.theme)
    setCurrencyState(draft.currency)
    setCardOrder(draft.cardOrder as CardId[])
    setCardPrecisionState(draft.cardPrecision)
    fetch('/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lang: draft.lang,
        theme: draft.theme,
        currency: draft.currency,
        cardOrder: draft.cardOrder,
        cardPrecision: draft.cardPrecision,
      }),
    }).catch(() => {})
  }, [setCardOrder])
  const [scrolled, setScrolled] = useState(false)
  const [highlightUpdates, setHighlightUpdates] = useState(true)
  const highlightUpdatesRef = useRef(true)
  const flashTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const prevDerivedFingerprintRef = useRef<Record<string, string>>({})
  const liveFlashFirstRunRef = useRef(true)

  useEffect(() => {
    // Load preferences resiliently. CRITICAL: a failed load (network hiccup, 5xx, server
    // still booting) must NEVER be collapsed into the "not chosen yet" sentinel — doing so
    // re-shows the first-run archive gate AND the install prompt on every transient failure,
    // even though the user already chose. `archiveChoice === null` means "genuinely unset";
    // only a real 200 response with no archiveMode may set it. On failure we retry with
    // backoff and leave state at `undefined` (neutral loading bg) so nothing false-gates.
    let cancelled = false
    const apply = (prefs: { cardPrecision?: Record<string, boolean>; lang?: Lang; theme?: Theme; currency?: 'USD' | 'BRL'; cardOrder?: string[]; chatModel?: string; chatSoundEnabled?: boolean; archiveMode?: ArchiveMode; archiveSessions?: boolean; installDismissed?: boolean; team?: TeamConfig; billing?: unknown }) => {
      if (prefs.cardPrecision) setCardPrecisionState(prefs.cardPrecision)
      // Total and never throws: a hand-edited preferences.json must not blank the dashboard.
      const nextBilling = normalizeBillingSettings(prefs.billing)
      setBilling(nextBilling)
      setCostBasisState(nextBilling.costBasis ?? 'api')
      setComparisons(normalizeComparisons((prefs as Record<string, unknown>).comparisons))
      if (prefs.lang) setLangState(prefs.lang)
      if (prefs.theme) {
        setThemeState(prefs.theme)
        // The server is the durable answer; mirror it locally so the next first paint agrees.
        try { localStorage.setItem('agentistics-theme', prefs.theme) } catch { /* private mode */ }
      }
      if (prefs.currency) setCurrencyState(prefs.currency)
      if (prefs.cardOrder) setCardOrder(migrateCardOrder(prefs.cardOrder))
      if (prefs.chatModel) setChatModel(prefs.chatModel as ChatModelId)
      if (prefs.chatSoundEnabled !== undefined) setChatSoundEnabled(prefs.chatSoundEnabled)
      setInstallDismissedPref(prefs.installDismissed === true)
      if ((prefs as Record<string, unknown>).chatSoundId) setChatSoundId((prefs as Record<string, unknown>).chatSoundId as string)
      // Resolve the archive mode (migrates the legacy archiveSessions boolean). Only reached on
      // a successful load — a failed fetch is retried in `load`, never funneled through here.
      setArchiveChoice(resolveArchiveChoice(prefs))
      // Task 13 — the hidden-repo badge map, rebuilt from the same load (readTeamConnections
      // tolerates a missing/malformed `connections` array instead of `.map`-ing `undefined`).
      setDeniedRepoLabels(buildDeniedRepoLabels(readTeamConnections(prefs)))
    }
    const load = async (attempt = 0) => {
      try {
        const r = await fetch('/api/preferences')
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const prefs = await r.json()
        if (!cancelled) apply(prefs)
      } catch {
        if (cancelled) return
        // Keep archiveChoice/installDismissedPref at their loading values and retry with
        // capped backoff, so a transient failure never wipes the user's saved choice.
        const delay = Math.min(1000 * 2 ** attempt, 15000)
        setTimeout(() => { if (!cancelled) void load(attempt + 1) }, delay)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [])

  // Tracks which latest version we've already surfaced as a toast/bell notification,
  // so re-renders (or an SSE re-check for the same version) don't re-push it.
  const notifiedVersionRef = useRef<string | null>(null)
  useEffect(() => {
    fetch('/api/version')
      .then(r => r.ok ? r.json() : null)
      .then((info: { current: string; latest: string; hasUpdate: boolean } | null) => {
        if (info?.hasUpdate) {
          // Only the passive surfaces (toast + bell) fire automatically. The blocking modal
          // opens on demand — see `showUpdateModal` above.
          setUpdateInfo({ current: info.current, latest: info.latest })
          if (notifiedVersionRef.current !== info.latest) {
            notifiedVersionRef.current = info.latest
            pushNotification({ type: 'info', code: 'app.update_available', meta: { version: info.latest } })
          }
        }
      })
      .catch(() => {})
  }, [])

  // The update toast/bell entry dispatches this to open the full modal on click.
  useEffect(() => {
    const handler = () => setShowUpdateModal(true)
    window.addEventListener('agentistics:open-update-modal', handler)
    return () => window.removeEventListener('agentistics:open-update-modal', handler)
  }, [])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  useEffect(() => {
    let rafId: number | null = null
    const check = () => {
      if (rafId !== null) return
      rafId = requestAnimationFrame(() => {
        rafId = null
        setScrolled(window.scrollY > 0)
      })
    }
    check()
    window.addEventListener('scroll', check, { passive: true })
    return () => {
      window.removeEventListener('scroll', check)
      if (rafId !== null) cancelAnimationFrame(rafId)
    }
  }, [])

  useEffect(() => {
    type RatesResp = { brlRate: number; pricing: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> }
    fetch('/api/rates')
      .then(r => r.ok ? (r.json() as Promise<RatesResp>) : null)
      .then(rates => {
        if (!rates) return
        if (rates.brlRate && rates.brlRate > 1) setBrlRate(rates.brlRate)
        if (rates.pricing) {
          for (const [id, price] of Object.entries(rates.pricing)) {
            MODEL_PRICING[id] = price
          }
        }
      })
      .catch(() => { /* silently use defaults */ })
  }, [])

  // Maps home-page flash IDs → canvas catalog component IDs so both flash together
  const CATALOG_FLASH_MAP: Record<string, string[]> = {
    'messages':        ['kpi.messages'],
    'sessions':        ['kpi.sessions'],
    'tool-calls':      ['kpi.tool-calls'],
    'cost':            ['kpi.cost', 'costs.budget', 'costs.cache'],
    'streak':          ['kpi.streak'],
    'longest-session': ['kpi.longest-session'],
    'commits':         ['kpi.commits'],
    'files':           ['kpi.files'],
    'input-tokens':    ['kpi.input-tokens'],
    'output-tokens':   ['kpi.output-tokens'],
    'activity':        ['activity.chart', 'activity.chart-messages', 'activity.chart-sessions', 'activity.chart-tools'],
    'heatmap':         ['activity.heatmap'],
    'hours':           ['activity.hours', 'activity.hours-bar'],
    'models':          ['costs.model-breakdown'],
    'projects':        ['projects.list', 'projects.languages'],
    'tools':           ['tools.metrics'],
    'agents':          ['tools.agents'],
    'sessions-list':   ['sessions.recent'],
    'highlights':      ['sessions.highlights'],
  }

  const triggerFlash = useCallback((ids: string[]) => {
    if (!highlightUpdatesRef.current) return
    const expanded = [...ids]
    for (const id of ids) {
      const extra = CATALOG_FLASH_MAP[id]
      if (extra) expanded.push(...extra)
    }
    for (const id of expanded) {
      const els = Array.from(document.querySelectorAll(`[data-flash-id="${id}"]`))
      for (const elRaw of els) {
        const el = elRaw as HTMLElement
        if (flashTimersRef.current[id]) {
          clearTimeout(flashTimersRef.current[id])
          delete flashTimersRef.current[id]
        }
        el.classList.remove('live-flash')
        void el.offsetWidth
        el.classList.add('live-flash')
        flashTimersRef.current[id] = setTimeout(() => {
          el.classList.remove('live-flash')
          delete flashTimersRef.current[id]
        }, 1400)
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Tags visible to the viewer; back both the `tags` filter dimension and the derived stats.
  const [tagsList, setTagsList] = useState<TagDef[]>([])
  // "Active only" on the dashboard means "conversations running right now" — the stored session
  // set intersected with the live fleet by conversation id (see `activeConversations.ts`'s
  // header). `&& fleetReadable` rather than trusting `activeOnly` alone: the switch could still
  // read true from before the fleet became unreadable (a central with no machine chosen), and an
  // empty `runningIds` there would silently report a confident zero instead of the unfiltered
  // totals — the exact defect `resolveMachineCacheScope` exists to prevent for team/machine scope.
  const derivedActiveOnly = activeOnly && fleetReadable
  const runningIds = useMemo(() => runningConversationIds(headerFleet.rows), [headerFleet.rows])
  const derived = useDerivedStats(data, filters, tagsList, derivedActiveOnly, runningIds)

  // ── the plan cost basis ──────────────────────────────────────────────────────────────────
  // Computed ONCE here and passed down: two surfaces each cutting A their own way would tell two
  // different stories about the same filter, and the point of the basis is that they agree.
  const planBasis = usePlanBasis({
    apiCostByDay: derived?.apiCostByDay,
    billing,
    brlRate,
    filters,
    // The basis does not exist on a central, and refusing HERE is what makes it unreachable: the
    // surfaces that read `planBasis` directly (Home's plan panel, compare's per-side button) never
    // pass through the `costBasis` switch below.
    central: isCentral,
  })
  const billingReady = useMemo(
    () => billingReadiness(billing, data?.harnesses?.length ? data.harnesses : ['claude']),
    [billing, data?.harnesses],
  )
  // A central aggregates many machines; pricing a whole fleet from its operator's own timeline
  // would be a fabricated number, so the basis does not exist there at all. And a basis the data
  // cannot support falls back rather than rendering a page of N/A.
  const costBasis: CostBasis =
    isCentral || !billingReady.ready || planBasis.basis === null ? 'api' : costBasisState
  /**
   * The centring padding the strip can AFFORD, and what the bar therefore has to draw in.
   *
   * The action cluster used to be charged twice — once for being a sibling that takes room, and
   * again as the padding that pulls the filters onto the strip's own centre line. On a 1273px
   * window with a 258px cluster that is 516px gone, and the bar compacted with most of the header
   * empty beside it. `stripPadding` takes the centring out of the SLACK instead: centring is a
   * nicety, a date control collapsed into a popover is something somebody has to go looking for.
   *
   * The cost-basis toggle is budgeted only where it is actually drawn — it is absent on a central
   * and on a machine with no billing set up, and reserving room for a control that is not on screen
   * compacts a bar that would have fitted.
   */
  const stripExtra = (!isCentral && billingReady.ready && planBasis.basis !== null) ? COST_BASIS_W : 0
  // The SESSIONS strip does not centre its filters at all — its slot carries no padding — so it
  // is charged none. It was being charged `actionsW` for a padding that is not there, which is
  // the same double-subtraction seen from its other side.
  const stripPad = inSessionsWorkspace ? 0 : stripPadding(filterSlotW, actionsW, FULL_BAR_W + stripExtra)
  const stripFit = headerFit(Math.max(0, filterSlotW - stripPad), stripExtra)

  const setCostBasis = useCallback((b: CostBasis) => {
    setCostBasisState(b)
    void saveBilling({ ...billing, costBasis: b })
  }, [billing, saveBilling])
  const openBillingSetup = useCallback(() => setBillingSetupOpen(true), [])

  // What the registered plans commit to THIS calendar month — a different question from the
  // filter-window plan cost, and the one a monthly budget is set against.
  const monthCommitment = useMemo(
    () => (isCentral ? null : monthlyCommitment({
      profiles: billing.profiles,
      month: new Date().toISOString().slice(0, 10),
      brlRate,
    })),
    [billing.profiles, brlRate, isCentral],
  )

  // The first-run invite repeats every load until dismissed for good — but only once preferences
  // have actually loaded (`introDismissed` absent during loading would flash it at someone who
  // dismissed it months ago), only with nothing registered yet, and never on a central.
  const [billingIntroSeen, setBillingIntroSeen] = useState(false)
  const showBillingIntro =
    !isCentral
    && !billingIntroSeen
    && archiveChoice !== null
    && billing.introDismissed !== true
    && Object.keys(billing.profiles).length === 0

  // The header totals strip, in whichever basis is active. It carries no label of its own, so the
  // tooltip is where "this is your plan cost, not an API estimate" has to be said.
  // C straight off the basis, never `totalCostUSD × factor` — see the long note on the HomePage
  // cost card. The strip and the card must agree to the cent, so they read the same field.
  const headerPlanBasis = costBasis === 'plan' && planBasis.basis?.coverage.computable
    ? planBasis.basis
    : null
  const headerCostUSD = headerPlanBasis ? headerPlanBasis.planCostUSD : (derived?.totalCostUSD ?? 0)
  const headerCostScope = headerPlanBasis
    ? planScopeNote({
        covered: planScopeHarnesses(headerPlanBasis).covered.map(h => HARNESS_LABELS[h] ?? h),
        inScope: planScopeHarnesses(headerPlanBasis).inScope,
        lang: lang === 'pt' ? 'pt' : 'en',
      })
    : null
  // The strip's totals (sessions/cost/tokens) all narrow to online members BY DEFAULT on a
  // central whose operator turned off `includeOfflineData` — nobody chose that on this screen, so
  // it needs the same disclosure `planScopeNote` gives a plan-basis figure. An explicit "Offline"
  // presence pill already reads as a filter the user picked and needs no extra sentence.
  const presenceScopeNote = derived?.presenceScope.isPolicyDefault
    ? (lang === 'pt' ? 'somente membros online (política do central)' : 'online members only (central policy)')
    : null
  const headerCostTitle = [
    headerPlanBasis
      ? [
          lang === 'pt' ? 'Custo do seu plano no período medido' : 'Your plan cost over the measured period',
          headerCostScope,
        ].filter(Boolean).join(' · ')
      : (lang === 'pt' ? 'Estimativa a preços de API' : 'API-price estimate'),
    presenceScopeNote,
  ].filter(Boolean).join(' · ')

  /**
   * The header's token figure and the sentence explaining it.
   *
   * It read `inputTokens + outputTokens` — the two conversational counters — so the number beside
   * the cost described 0,34 % of the tokens the cost was charged on. Now it is every billed
   * counter, and it carries its own explanation on hover: at these magnitudes a bare "8,7B tok"
   * reads as a fault until you know that most of it is the cache being re-read.
   */
  const headerTokens = derived ? totalTokens(derived.tokenTotals) : 0
  const headerTokensTitle = derived
    ? [totalTokensExplained(derived.tokenTotals, lang === 'pt' ? 'pt' : 'en'), presenceScopeNote]
        .filter(Boolean).join(' · ')
    : ''

  const models = useMemo(() => {
    if (!data) return []
    const set = new Set<string>()
    for (const id of Object.keys(data.statsCache.modelUsage ?? {})) {
      set.add(id)
    }
    for (const s of data.sessions) {
      if (s.model) set.add(s.model)
    }
    return Array.from(set)
  }, [data])

  // When a project filter is active, compute which models are actually used in those projects
  const modelsInProject = useMemo(() => {
    if (!data || filters.projects.length === 0) return null
    const projectSet = new Set(filters.projects)
    const used = new Set<string>()
    for (const s of data.sessions) {
      if (s.model && projectSet.has(s.project_path)) used.add(s.model)
    }
    return used
  }, [data, filters.projects])

  // Models grouped by the harness that actually used them (NOT by prefix — Copilot
  // also uses gpt-* models). When a harness filter is active, only that harness's
  // models are offered; in the unified view all harnesses are shown as sections.
  const modelGroups = useMemo<{ harness: HarnessId; models: string[] }[]>(() => {
    if (!data) return []
    const order: HarnessId[] = HARNESS_ORDER
    const byH: Partial<Record<HarnessId, Set<string>>> = {}
    const add = (h: HarnessId, m?: string) => { if (!m) return; (byH[h] ??= new Set<string>()).add(m) }
    for (const id of Object.keys(data.statsCache.modelUsage ?? {})) add('claude', id)
    for (const s of data.sessions) add((s.harness ?? 'claude') as HarnessId, s.model)
    // When the harness filter is active, only the selected harnesses' models are offered;
    // in the unified view all harnesses are shown as sections.
    const sel = filters.harnesses ?? []
    const harnesses = sel.length > 0 ? order.filter(h => sel.includes(h)) : order
    return harnesses
      .filter(h => byH[h] && byH[h]!.size > 0)
      .map(h => ({ harness: h, models: Array.from(byH[h]!).sort() }))
  }, [data, filters.harnesses])

  // Live update highlight detection
  useEffect(() => {
    if (!liveUpdates || !derived) return
    const fp = prevDerivedFingerprintRef.current
    const toFlash: string[] = []

    const chk = (key: string, val: unknown, ids: string[]) => {
      const s = String(val ?? '')
      if (!liveFlashFirstRunRef.current && fp[key] !== s) toFlash.push(...ids)
      fp[key] = s
    }

    chk('totalMessages', derived.totalMessages, ['messages'])
    chk('totalSessions', derived.totalSessions, ['sessions'])
    chk('totalToolCalls', derived.totalToolCalls, ['tool-calls'])
    chk('totalCostUSD', derived.totalCostUSD?.toFixed(4), ['cost'])
    chk('streak', derived.streak, ['streak'])
    chk('longestSession', derived.longestSession?.session_id, ['longest-session'])
    chk('gitCommits', derived.gitCommits, ['commits'])
    chk('filesModified', derived.filesModified, ['files'])
    chk('inputTokens', derived.inputTokens, ['input-tokens'])
    chk('outputTokens', derived.outputTokens, ['output-tokens'])
    const lastHeat = derived.heatmapData?.[derived.heatmapData.length - 1]
    const heatSig = `${derived.heatmapData?.length}:${lastHeat?.sessions}`
    chk('heatmap', heatSig, ['activity', 'heatmap'])
    chk('hourCounts', JSON.stringify(derived.hourCounts), ['hours'])
    chk('modelUsage', JSON.stringify(Object.keys(derived.modelUsage ?? {})), ['models'])
    chk('projectStats', derived.projectStats?.length, ['projects'])
    chk('toolCounts', JSON.stringify(derived.toolCounts), ['tools'])
    chk('agentCount', derived.agentInvocations?.length, ['agents'])
    const sessSig = `${derived.filteredSessions?.length}:${derived.filteredSessions?.[0]?.session_id}`
    chk('sessions', sessSig, ['sessions-list', 'highlights'])

    liveFlashFirstRunRef.current = false
    if (toFlash.length > 0) triggerFlash([...new Set(toFlash)])
  }, [derived, liveUpdates, triggerFlash])

  // Session count per project from enriched sessions (have valid start_time).
  // Used in the Projects modal so its count matches the card when "All" is selected.
  const sessionCountByProject = useMemo(() => {
    if (!data) return {}
    const counts: Record<string, number> = {}
    for (const s of data.sessions) {
      if (!s.start_time || !s.project_path) continue
      counts[s.project_path] = (counts[s.project_path] ?? 0) + 1
    }
    return counts
  }, [data])

  const users = useMemo(() => (data ? distinctUsers(data.sessions) : []), [data])

  // Stable signature of who is online right now — drives the machines refetch below.
  const presenceKey = useMemo(
    () => Object.entries(data?.presence ?? {}).map(([u, p]) => `${u}:${p.online ? 1 : 0}`).sort().join('|'),
    [data?.presence],
  )

  // Central-only: fetch teams and machines for filter dimensions
  const [teamsList, setTeamsList] = useState<{ id: string; name: string }[]>([])
  const [machinesList, setMachinesList] = useState<{ id: string; name: string; user: string; teamId?: string; teamIds?: string[]; online?: boolean }[]>([])
  useEffect(() => {
    if (!teamSession?.central) {
      setTeamsList([])
      setMachinesList([])
      return
    }
    Promise.all([
      fetch('/api/iam/teams').then(r => r.ok ? r.json() : { teams: [] }),
      fetch('/api/iam/machines').then(r => r.ok ? r.json() : { machines: [] }),
    ]).then(([teamsResp, machinesResp]) => {
      setTeamsList((teamsResp.teams ?? []).map((t: { _id: string; name: string }) => ({ id: t._id, name: t.name })))
      setMachinesList((machinesResp.machines ?? []).map((m: { id: string; machineName: string; user: string; teamId?: string; teamIds?: string[]; online?: boolean }) => ({ id: m.id, name: m.machineName, user: m.user, teamId: m.teamId, teamIds: m.teamIds, online: m.online === true })))
    }).catch(() => {
      setTeamsList([])
      setMachinesList([])
    })
    // presenceKey: /api/iam/machines stamps each machine's `online` from computePresence(), so the
    // list has to be refetched when presence flips — otherwise the online/offline machine counts
    // would freeze at whatever they were when the central was first loaded.
  }, [teamSession?.central, presenceKey])

  // Tags back the `tags` filter dimension; without them the dimension stays hidden and any stored
  // filters.tags selection is inert. They exist in EVERY mode (a solo machine keeps them in
  // ~/.agentistics/tags.json), so this load is not tied to the central fetch above.
  //
  // The response is only parsed once it IS json: the route used to answer a plain-text 404 off a
  // central, and `r.json()` on that threw a SyntaxError out of this effect.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const r = await fetch('/api/tags')
        if (!r.ok || !(r.headers.get('content-type') ?? '').includes('application/json')) throw new Error('no tags')
        const body = await r.json() as { tags?: TagDef[] }
        if (!cancelled) setTagsList(body.tags ?? [])
      } catch {
        if (!cancelled) setTagsList([])
      }
    })()
    return () => { cancelled = true }
  }, [teamSession?.central])

  // Header summary counts (desktop only)
  const memberCount = users.length
  const onlineCount = data?.presence ? Object.values(data.presence).filter(p => p.online).length : 0
  const offlineCount = data?.presence ? Object.values(data.presence).filter(p => !p.online).length : 0
  const machineCount = machinesList.length
  // Per-machine presence comes stamped on /api/iam/machines (server-side computePresence), so the
  // machine chip can split total / online / offline exactly like the members chip does.
  const machinesOnline = machinesList.filter(m => m.online).length
  const machinesOffline = machineCount - machinesOnline
  const projectCount = data?.projects?.length ?? 0
  const teamCount = teamsList.length
  const repoCount = useMemo(() => new Set((data?.sessions ?? []).map(s => s.git_remote).filter(Boolean)).size, [data])
  // Hardware is an OVERLAY, not a route: it answers "what is this machine doing right now", which
  // is asked from wherever you are and then dismissed. Desktop opens it from the header icon;
  // mobile from the "More" sheet, where every other header action lives.
  const [hardwareOpen, setHardwareOpen] = useState(false)
  // Collapsible "fleet stats" tab below the header (updated/members/machines/teams/projects/repos).
  const [fleetOpen, setFleetOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('agentistics-fleet-open') !== '0' } catch { return true }
  })
  const toggleFleet = () => setFleetOpen(v => { const n = !v; try { localStorage.setItem('agentistics-fleet-open', n ? '1' : '0') } catch { /* ignore */ } return n })

  // Members list = users WITH machines only
  const machineUsers = useMemo(() => new Set(machinesList.map(m => m.user)), [machinesList])
  const usersWithMachines = useMemo(() => users.filter(u => machineUsers.has(u)), [users, machineUsers])

  // Only member-managers (owner, or a manager of any team) may filter BY member — a plain user
  // sees only their own scoped data, so member/presence filtering would be meaningless for them.
  // They still get Teams (their teams) + Machines (their linked machines).
  const canFilterMembers = iam?.account?.role === 'owner'
    || (iam?.account?.memberships ?? []).some(m => m.role === 'manager')

  // Harnesses available in the harness filter, scoped to the SELECTED users (empty = all
  // users). So picking one member narrows the harness options to the harnesses that member
  // actually used; "All members" shows the union. Falls back to all harnesses in the data
  // when the scoped slice is empty (e.g. a selected member has no sessions yet).
  const availableHarnesses = useMemo<HarnessId[]>(() => {
    if (!data) return []
    const scoped = filterByUsers(data.sessions, filters.users ?? [])
    const present = distinctHarnesses(scoped)
    return present.length > 0 ? present : data.harnesses
  }, [data, filters.users])

  // Projects offered in the filter, scoped to the SELECTED users (empty = all users).
  // On a central, filtering by member X should only list X's projects — not everyone's.
  const availableProjects = useMemo(() => {
    if (!data) return []
    const sel = filters.users ?? []
    if (sel.length === 0) return data.projects
    const selSet = new Set(sel)
    // A project is in scope iff at least one of its owning members is selected.
    // Projects carry an explicit `users` tag (built server-side), so this is
    // deterministic — no path re-matching and no fallback that leaks other members' projects.
    return data.projects.filter(p => (p.users ?? []).some(u => selSet.has(u)))
  }, [data, filters.users])

  // Prune any selected project no longer available after a user-selection change.
  useEffect(() => {
    const sel = filters.projects ?? []
    if (sel.length === 0) return
    const allowed = new Set(availableProjects.map(p => p.path))
    const pruned = sel.filter(p => allowed.has(p))
    if (pruned.length !== sel.length) setFilters(f => ({ ...f, projects: pruned }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableProjects])

  // Prune any selected harness that is no longer available after a user-selection change
  // (e.g. selecting a member who never used a previously-selected harness).
  useEffect(() => {
    const sel = filters.harnesses ?? []
    if (sel.length === 0) return
    const allowed = new Set(availableHarnesses)
    const pruned = sel.filter(h => allowed.has(h))
    if (pruned.length !== sel.length) setFilters(f => ({ ...f, harnesses: pruned }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableHarnesses])

  // When exactly one harness is selected, the header mirrors the old per-harness view
  // (derived first/last dates + harness label). With 0 or >1 selected it uses the
  // statsCache (Claude-canonical) dates, matching the unified dashboard.
  const singleHarness: HarnessId | undefined =
    (filters.harnesses?.length === 1) ? filters.harnesses[0] : undefined

  // Info items for all 8 stat cards
  // Card "i" popovers. These describe REAL behaviour and are audited against useDerivedStats —
  // a stale explanation is worse than none, because it is read as authoritative.
  //
  // The single fact that drives most of them: `stats-cache.json` is CLAUDE-ONLY and has no
  // project/repo/model granularity. Whenever the active scope cannot be answered from it
  // (`sessionFiltered` in useDerivedStats: any project/repo/tag/model/date filter, a non-Claude
  // harness, …) the numbers are recomputed by summing individual sessions instead. So each item
  // below states BOTH paths rather than pretending there is one.
  const infoItems = useMemo(() => {
    const scoped = filters.projects.length > 0 || (filters.repos?.length ?? 0) > 0
      || filters.models.length > 0 || (filters.tags?.length ?? 0) > 0
      || (filters.harnesses?.length ?? 0) > 0
    const pt = lang === 'pt'
    // Shared wording for the two-path reality, so the items cannot drift apart.
    const SESSION_SOURCES = pt
      ? 'Sessões vêm de: ~/.claude/projects/**/*.jsonl (transcrições), '
        + '~/.claude/usage-data/session-meta/*.json (quando existe) e '
        + '~/.agentistics/sessions/<harness>/<id>.json (arquivo local — revive sessões que o Claude já apagou).'
      : 'Sessions come from: ~/.claude/projects/**/*.jsonl (transcripts), '
        + '~/.claude/usage-data/session-meta/*.json (when present) and '
        + '~/.agentistics/sessions/<harness>/<id>.json (local store — revives sessions Claude already deleted).'
    const CLAUDE_ONLY = pt
      ? 'stats-cache.json é exclusivo do Claude Code. Métricas de Codex, Gemini, Copilot, Antigravity e Kimi são sempre somadas sessão a sessão.'
      : 'stats-cache.json is Claude Code only. Codex, Gemini, Copilot, Antigravity and Kimi metrics are always summed session by session.'
    const twoPaths = (cacheField: string, sessionField: string) => scoped
      ? `${sessionField}  ${pt ? '(escopo filtrado → soma por sessão)' : '(filtered scope → per-session sum)'}`
      : `${cacheField}  ${pt ? '(sem filtro de escopo)' : '(no scope filter)'}`
    return [
      {
        label: pt ? 'Total de mensagens' : 'Total messages',
        source: twoPaths(
          '~/.claude/stats-cache.json → dailyActivity[].messageCount',
          'user_message_count + assistant_message_count de cada sessão'),
        formula: pt
          ? 'Sem filtro de escopo: Σ messageCount dos dias no período\nCom filtro: Σ (user_message_count + assistant_message_count)\nMédia = totalMessages ÷ totalSessions'
          : 'No scope filter: Σ messageCount for days in the period\nFiltered: Σ (user_message_count + assistant_message_count)\nAvg = totalMessages ÷ totalSessions',
        note: pt
          ? `Cada "mensagem" é uma entrada do usuário ou uma resposta do assistente. ${CLAUDE_ONLY}`
          : `Each "message" is one user input or one assistant reply. ${CLAUDE_ONLY}`,
      },
      {
        label: pt ? 'Sessões' : 'Sessions',
        source: twoPaths(
          '~/.claude/stats-cache.json → dailyActivity[].sessionCount',
          pt ? 'contagem das sessões que passam pelos filtros' : 'count of sessions passing the filters'),
        formula: pt
          ? 'Sem filtro de escopo: Σ sessionCount dos dias no período\nCom filtro: número de sessões filtradas'
          : 'No scope filter: Σ sessionCount for days in the period\nFiltered: number of filtered sessions',
        note: pt
          ? `Uma sessão = um arquivo de transcrição do assistente. ${SESSION_SOURCES}`
          : `One session = one assistant transcript file. ${SESSION_SOURCES}`,
      },
      {
        label: pt ? 'Chamadas de ferramentas' : 'Tool calls',
        source: twoPaths(
          '~/.claude/stats-cache.json → dailyActivity[].toolCallCount',
          'Σ values(tool_counts) de cada sessão'),
        formula: pt
          ? 'Σ values(tool_counts) por sessão\nEx: { Bash:16, Read:5, Edit:3 } = 24'
          : 'Σ values(tool_counts) per session\nEx: { Bash:16, Read:5, Edit:3 } = 24',
        note: pt
          ? 'Inclui todas as ferramentas: Bash, Read, Edit, Write, Grep, Glob, Agent, ferramentas MCP, etc. Harnesses sem registro de ferramentas mostram N/A em vez de 0.'
          : 'Includes all tools: Bash, Read, Edit, Write, Grep, Glob, Agent, MCP tools, etc. Harnesses that record no tool usage show N/A rather than 0.',
      },
      {
        label: pt ? 'Sequência' : 'Streak',
        source: twoPaths(
          '~/.claude/stats-cache.json → dailyActivity[].date',
          pt ? 'datas das mensagens das sessões filtradas' : 'message dates of the filtered sessions'),
        formula: pt
          ? 'Conta dias consecutivos para trás a partir de hoje\ncom ≥ 1 dia ativo registrado'
          : 'Counts consecutive days backwards from today\nwith ≥ 1 active day recorded',
        note: pt
          ? 'Se hoje ainda não teve atividade, a contagem começa em ontem — para não penalizar quem ainda não trabalhou hoje. ATENÇÃO: com filtro de escopo ativo, a sequência é calculada só sobre as sessões filtradas, não sobre todo o histórico.'
          : 'If today has no activity yet, counting starts from yesterday — so you are not penalised for not having worked yet today. NOTE: with a scope filter active, the streak is computed over the filtered sessions only, not the full history.',
      },
      {
        label: pt ? 'Sessão mais longa' : 'Longest session',
        source: pt
          ? 'Transcrição da sessão → duração de cada turno (Σ) e primeiro/último evento'
          : "Session transcript → each turn's duration (Σ) and first/last event",
        formula: pt
          ? 'ATIVO = Σ duração de cada turno\n  (do seu prompt até o assistente terminar)\n\nDECORRIDO = último evento − primeiro evento\n  da sessão. É EVENTO, não mensagem: o primeiro\n  costuma ser um anexo ou linha de sistema\n  minutos antes da sua 1ª mensagem, e o último\n  uma linha de sistema depois da resposta final.\n\nO ranking do card usa o ATIVO.'
          : 'ACTIVE = Σ duration of each turn\n  (from your prompt until the assistant finishes)\n\nELAPSED = last event − first event of the\n  session. EVENT, not message: the first is often\n  an attachment or system line minutes before\n  your first message, and the last a system line\n  after the final reply.\n\nThe card ranks by ACTIVE.',
        note: pt
          ? 'O ativo NÃO conta o intervalo entre um turno acabar e você mandar o próximo — por isso uma sessão reaberta durante semanas deixa de aparecer como centenas de horas. Mas ele AINDA conta um turno que ficou parado esperando você (ex.: aprovação de permissão): separar isso exigiria um limite de ociosidade arbitrário. Sessões cuja transcrição o Claude já apagou não têm tempo ativo e ficam fora do ranking.'
          : 'Active time does NOT count the gap between a turn ending and your next prompt — which is why a session reopened over weeks no longer reads as hundreds of hours. It DOES still count a turn that sat waiting on you (e.g. a permission prompt): separating that would need an arbitrary idle threshold. Sessions whose transcript Claude already deleted have no active time and are excluded from the ranking.',
      },
      // Two different items, because in plan basis this card measures something else entirely.
      // Leaving the API text up while the headline shows C would make the explanation itself the
      // lie the whole feature exists to remove.
      costBasis === 'plan'
        ? {
            label: pt ? 'Custo do plano' : 'Plan cost',
            source: pt
              ? 'Configurações → Cobrança (períodos cadastrados) + as sessões filtradas'
              : 'Settings → Billing (registered periods) + the filtered sessions',
            formula: pt
              ? 'C = Σ dos períodos:  mensalidade × dias no filtro ÷ 30,44\n'
                + 'A = custo a preços de API dos MESMOS dias\n'
                + 'V = A ÷ C          (quantas vezes o plano se pagou)\n'
                + '$/1M efetivo = C ÷ (tokens cobertos ÷ 1.000.000)\n\n'
                + 'Ex.: R$ 500/mês, 126 dias dentro do filtro\n'
                + '     500 × 126 ÷ 30,44 = R$ 2.069,65\n\n'
                + '30,44 = média de dias por mês (365,25 ÷ 12).'
              : 'C = Σ over periods:  monthly × days in filter ÷ 30.44\n'
                + 'A = API-price cost of the SAME days\n'
                + 'V = A ÷ C          (how many times the plan paid for itself)\n'
                + 'effective $/1M = C ÷ (covered tokens ÷ 1,000,000)\n\n'
                + 'E.g.: $100/mo, 126 days inside the filter\n'
                + '      100 × 126 ÷ 30.44 = $413.93\n\n'
                + '30.44 = average days per month (365.25 ÷ 12).',
            note: pt
              ? 'POR QUE TEM CENTAVOS: o rateio é por DIA, não por mês de calendário. 126 dias não são 4 meses redondos, são 4,139 meses — e essa é a única leitura que sobrevive a um filtro arbitrário: "meio mês" não significa nada para 10 dias soltos no meio de maio.\n\n'
                + 'POR QUE VOCÊ CADASTRA PERÍODOS: nenhum arquivo em nenhuma máquina registra qual plano estava valendo quando. Por isso a cobrança é uma LINHA DO TEMPO: cada período é rateado com o próprio preço, então uma janela que atravessa uma troca de plano soma as duas partes corretamente em vez de aplicar o preço de hoje ao passado inteiro.\n\n'
                + 'DIAS SEM PLANO SAEM DOS DOIS LADOS — do custo do plano e do valor de API — senão o múltiplo compararia períodos diferentes. O rodapé do card diz quantos dias foram realmente medidos, que pode ser menos que o filtro.\n\n'
                + 'ESTE NÚMERO É O C, LIDO DIRETO — não é o total da tela reescalado. Por isso ele pode ser menor que os cards ao lado: eles contam todos os harnesses, e o C cobre só os que têm plano cadastrado. Quando os dois escopos diferem, o rodapé nomeia o que está coberto ("só Claude Code").\n\n'
                + 'POR LINHA (modelo, repositório, agente) o valor é RATEIO, não medição: ninguém consegue dizer que fatia de uma mensalidade fixa um modelo "usou". Dentro de um mesmo harness é um reescalonamento linear, então a ordem e as proporções se mantêm exatas.\n\n'
                + 'A mensalidade é a que você digitou; BRL converte pela cotação de /api/rates. Cache não reduz assinatura — ele estende seu limite de uso —, por isso o painel de cache continua em base API.'
              : 'WHY IT HAS CENTS: proration is by DAY, not by calendar month. 126 days is not 4 round months, it is 4.139 months — and that is the only reading that survives an arbitrary filter: "half a month" means nothing for 10 loose days in the middle of May.\n\n'
                + 'WHY YOU REGISTER PERIODS: no file on any machine records which plan was in force when. That is why billing is a TIMELINE: each period is prorated at its own price, so a window spanning a plan change adds both parts correctly instead of applying today\'s price to the whole past.\n\n'
                + 'DAYS WITH NO REGISTERED PLAN LEAVE BOTH SIDES — the plan cost and the API value — otherwise the multiple would compare different periods. The card\'s subtitle names how many days were actually measured, which can be fewer than your filter.\n\n'
                + 'THIS FIGURE IS C, READ DIRECTLY — not the page total rescaled. So it can be smaller than the cards beside it: those count every harness, while C covers only the ones with a registered plan. When the two scopes differ, the subtitle names what is covered ("Claude Code only").\n\n'
                + 'PER ROW (model, repository, agent) the figure is an ALLOCATION, not a measurement: nobody can say what share of a flat monthly fee a given model "used". Within one harness it is a linear rescale, so rankings and proportions survive exactly.\n\n'
                + 'The monthly amount is the one you typed; BRL is converted at the /api/rates figure. Cache does not reduce a subscription — it extends your rate limit — which is why the cache panel stays in API basis.',
          }
        : {
            label: pt ? 'Custo estimado' : 'Estimated cost',
            source: twoPaths(
              '~/.claude/stats-cache.json → modelUsage[model].{inputTokens, outputTokens, cacheRead, cacheWrite}',
              pt ? 'tokens de cada sessão × preço do modelo dela' : "each session's tokens × its model's price"),
            formula: pt
              ? 'Σ modelo [(input/1M × p.in) + (output/1M × p.out)\n  + (cacheRead/1M × p.cR) + (cacheWrite/1M × p.cW)]\n\nUma sessão sem modelo conhecido usa a taxa média ponderada pelo mix de modelos do período.'
              : 'Σ model [(input/1M × p.in) + (output/1M × p.out)\n  + (cacheRead/1M × p.cR) + (cacheWrite/1M × p.cW)]\n\nA session with no known model uses the average rate weighted by the period\'s model mix.',
            note: pt
              ? 'Preços vêm de três fontes, nesta ordem de confiança: páginas oficiais dos fornecedores, a base comunitária LiteLLM e a tabela embutida no app. Como os harnesses usam vários fornecedores (Anthropic, OpenAI, Google), os preços não são só da Anthropic. Veja Configurações → Preços para a tarifa e a origem de cada modelo que esta máquina realmente usou. É estimativa de preço de API — não é sua fatura nem sua assinatura. Cadastrou seu plano? Configurações → Cobrança transforma isto no custo real.'
              : 'Prices come from three sources, in this order of trust: the vendors\' official pages, the LiteLLM community dataset and the table built into the app. Because harnesses use several vendors (Anthropic, OpenAI, Google), prices are not Anthropic-only. See Settings → Pricing for the rate and origin of every model this machine actually used. This is an API-price estimate — not your invoice or your subscription. Registered your plan? Settings → Billing turns this into your real cost.',
          },
      {
        label: pt ? 'Commits' : 'Commits',
        source: scoped
          ? (pt ? 'git log --numstat no repositório do projeto' : 'git log --numstat in the project repository')
          : (pt ? 'transcrições → comandos git commit/push nas chamadas Bash' : 'transcripts → git commit/push commands in Bash tool calls'),
        formula: scoped
          ? (pt ? 'Σ commits do projeto (git log --numstat)\nΣ git_pushes das sessões (via Bash)' : 'Σ project commits (git log --numstat)\nΣ git_pushes from sessions (via Bash)')
          : (pt ? 'Σ git_commits das sessões no período\nΣ git_pushes das sessões no período' : 'Σ git_commits for sessions in the period\nΣ git_pushes for sessions in the period'),
        note: scoped
          ? (pt
            ? 'Com projeto filtrado, lê git log --numstat direto do repositório — inclui commits feitos fora do assistente. Requer que o projeto seja um repositório git.'
            : 'With a project filtered, reads git log --numstat straight from the repository — includes commits made outside the assistant. Requires the project to be a git repository.')
          : (pt
            ? 'Sem filtro de projeto, conta só commits e pushes que o assistente executou pela ferramenta Bash — commits feitos por você no terminal não aparecem. Filtre um projeto para ver o histórico completo do repositório.'
            : 'Without a project filter, counts only commits and pushes the assistant ran through the Bash tool — commits you made in the terminal do not appear. Filter a project to see the repository\'s full history.'),
      },
      {
        label: pt ? 'Arquivos modificados' : 'Files modified',
        source: pt
          ? 'chamadas Edit/Write/MultiEdit das sessões, e git log --numstat quando o projeto é um repositório git'
          : 'Edit/Write/MultiEdit calls in the sessions, plus git log --numstat when the project is a git repository',
        formula: pt
          ? 'ARQUIVOS = máx(arquivos distintos editados pelo assistente,\n  arquivos do git log --numstat)\nLINHAS = Σ lines_added | Σ lines_removed'
          : 'FILES = max(distinct files the assistant edited,\n  files from git log --numstat)\nLINES = Σ lines_added | Σ lines_removed',
        note: pt
          ? 'O máximo entre as duas fontes é usado para capturar também arquivos editados fora de um repositório git. Arquivos binários ficam de fora (git numstat marca "-"). Harnesses que não registram diffs mostram N/A em vez de 0.'
          : 'The max of the two sources is used so files edited outside a git repository are still counted. Binary files are excluded (git numstat writes "-"). Harnesses that record no diffs show N/A rather than 0.',
      },
      // ONE item, because there is now one card. It used to be two — input and output — which is
      // exactly the pair that adds up to 0,34 % of the volume on a real machine, and the two
      // cache counters that make up the rest had no card and no explanation anywhere on this page.
      {
        label: 'Tokens',
        source: twoPaths(
          '~/.claude/stats-cache.json → modelUsage[model].{input,output,cacheRead,cacheCreation}Tokens',
          pt ? 'os quatro contadores de cada sessão' : "each session's four counters"),
        formula: pt
          ? 'Total = entrada + saída + leitura de cache + escrita de cache\n\n'
            + 'Vem do MESMO recorte de uso por modelo de onde sai o custo,\n'
            + 'então os tokens e o dinheiro ao lado descrevem sempre\n'
            + 'as mesmas chamadas — sob qualquer filtro.'
          : 'Total = input + output + cache read + cache write\n\n'
            + 'Read from the SAME filtered model usage the cost is priced\n'
            + 'from, so the tokens and the money beside them always describe\n'
            + 'the same set of turns — under any filter.',
        note: pt
          ? 'São quatro preços diferentes, não um só: leitura de cache custa ~10× menos que entrada nova, '
            + 'e escrita custa um prêmio. Numa máquina real a leitura de cache é ~96% do volume — por isso '
            + `um total de bilhões de tokens convive com uma conta modesta. ${CLAUDE_ONLY}`
          : 'These are four different prices, not one: a cache read costs ~10× less than fresh input, '
            + 'and a write pays a premium. On a real machine cache reads are ~96% of the volume — which is '
            + `why a total in the billions sits next to a modest bill. ${CLAUDE_ONLY}`,
      },
    ]
  }, [filters.projects.length, filters.repos?.length, filters.models.length,
    filters.tags?.length, filters.harnesses?.length, lang])

  // Team auth gate takes precedence over the data loading/error states below:
  // on a gated central /api/data returns 401 until the operator logs in, so we
  // must resolve the session and show the login screen FIRST — otherwise the
  // expected 401 surfaces as a "failed to load" error and the login never shows.
  if (teamSession === undefined) {
    // Still resolving the session — show the honest boot loader, not a silent blank. We also can't
    // yet tell a 403 auth-hold from a real error (that needs `teamSession.central`), so holding the
    // loader here is correct as well as honest.
    return <LoadingScreen lang={lang} loadProgress={loadProgress} />
  }
  // Central: account-based IAM gate (bootstrap → login → app).
  if (teamSession.central) {
    if (iam === undefined) return <LoadingScreen lang={lang} loadProgress={loadProgress} />
    if (iam.needsBootstrap) return <OwnerSetup lang={lang} onDone={() => { reloadIam(); refetch() }} />
    if (!iam.authed) return <Login onAuthed={() => { reloadIam(); refetch() }} />
    // Changing a password is step-up-protected (`server/stepup.ts`), and this screen is returned
    // BEFORE the app tree that mounts the prompter at the root — so it mounts its own. Without it
    // the forced first-login change would answer 403 with nobody able to answer the challenge,
    // which is a lockout on the one screen a new account cannot get past.
    if (iam.account?.mustChangePassword) {
      return (
        <>
          <ChangePassword onDone={() => { reloadIam(); refetch() }} />
          <StepUpPrompt lang={lang} />
        </>
      )
    }
    // An owner owes a second factor. The gate in index.ts is already refusing everything else,
    // so this is not an extra restriction — it is the screen that says WHY, and the only way the
    // owner can satisfy it. It also carries the recovery codes that make the account
    // self-recoverable, which is the other half of why it is mandatory.
    if (iam.mfaEnrollmentRequired) {
      return <MfaSetup lang={lang} required onClose={() => { reloadIam(); refetch() }} />
    }
  } else if (teamSession.required && !teamSession.authed) {
    // Non-central (member/solo) keeps the legacy password gate.
    return <TeamLogin onAuthed={() => { setTeamSession(s => ({ ...(s ?? { required: true }), required: true, authed: true })); refetch() }} />
  }

  // Errors are checked BEFORE the boot loader below: an error means the load settled (`complete()`
  // cleared `loading`), and it must win — otherwise a failed load would spin the loader forever.

  // A 403 on a central is an AUTH state, not a broken server: the gate refuses data until the
  // enrolment (or the sign-in) it is waiting for happens, and the effect above is already
  // re-reading that state. Showing "Failed to load data — HTTP 403" in that gap turns the
  // moment right after signing up into a dead end with a Retry button that cannot help.
  if (error && teamSession.central && String(error).includes('403')) {
    return <div style={{ minHeight: '100vh', background: 'var(--bg-base)' }} />
  }

  if (error) {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        padding: 40,
        textAlign: 'center',
      }}>
        <div style={{ fontSize: 40 }}>⚠️</div>
        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)' }}>
          {lang === 'pt' ? 'Falha ao carregar dados' : 'Failed to load data'}
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', fontFamily: 'monospace', background: 'var(--bg-card)', padding: '10px 16px', borderRadius: 8, maxWidth: 500 }}>
          {error}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
          {lang === 'pt' ? 'Certifique-se de que o servidor está rodando:' : 'Make sure the API server is running:'}{' '}
          <code style={{ background: 'var(--bg-elevated)', padding: '2px 6px', borderRadius: 4 }}>bun run server.ts</code>
        </div>
        <button onClick={refetch} style={{
          padding: '8px 20px',
          background: 'var(--anthropic-orange-dim)',
          border: '1px solid var(--anthropic-orange)60',
          borderRadius: 8,
          color: 'var(--anthropic-orange)',
          cursor: 'pointer',
          fontFamily: 'inherit',
          fontSize: 13,
          fontWeight: 600,
        }}>
          {lang === 'pt' ? 'Tentar novamente' : 'Retry'}
        </button>
      </div>
    )
  }

  // The boot loader stays until the app can actually paint: data fetched, derived stats computed,
  // AND the first-run prefs (archive choice) resolved. `loading` alone flipped false the instant
  // /api/data resolved, and the gaps here used to return a SILENT BLANK — the loader vanishing
  // before the data was ready. `bootLoading` is the single predicate deciding this.
  if (bootLoading({ loading, hasData: !!data, hasDerived: !!derived, prefsLoaded: archiveChoice !== undefined })) {
    return <LoadingScreen lang={lang} loadProgress={loadProgress} />
  }
  // `bootLoading` already guaranteed both are present; this explicit guard is what narrows them for
  // TypeScript below. It is not reachable as a blank — it returns the loader too, never `null`.
  if (!data || !derived) return <LoadingScreen lang={lang} loadProgress={loadProgress} />

  // Capture non-null derived for use in nested functions (TypeScript can't narrow closures)
  const d = derived
  const { statsCache } = data

  // Fleet-strip strings. Lifted out of the desktop-only block so the mobile header can render
  // the same two facts without duplicating the expressions.
  const fleetUpdated = singleHarness && singleHarness !== 'claude'
    ? (derived.lastSessionDate ? format(derived.lastSessionDate, 'MMM d') : (lang === 'pt' ? 'hoje' : 'today'))
    : (statsCache.lastComputedDate ? format(parseISO(statsCache.lastComputedDate), 'MMM d') : (lang === 'pt' ? 'hoje' : 'today'))
  const fleetFirstDate = singleHarness ? derived.firstSessionDate : statsCache.firstSessionDate
  const fleetSince = fleetFirstDate
    ? `${lang === 'pt' ? 'Desde' : 'Since'} ${format(singleHarness ? derived.firstSessionDate! : parseISO(statsCache.firstSessionDate!), 'MMM d, yyyy')} · ${derived.allTimeTotalSessions.toLocaleString()} ${lang === 'pt' ? (derived.allTimeTotalSessions === 1 ? 'sessão' : 'sessões') : (derived.allTimeTotalSessions === 1 ? 'session' : 'sessions')}${singleHarness ? ` · ${HARNESS_LABELS[singleHarness]}` : ''}`
    : undefined

  // Tokens: use model usage totals when available (non-project-filtered), fallback to session-level
  const totalInputTokens = Object.keys(derived.modelUsage).length > 0
    ? Object.values(derived.modelUsage).reduce((s, u) => s + u.inputTokens, 0)
    : derived.inputTokens
  const totalOutputTokens = Object.keys(derived.modelUsage).length > 0
    ? Object.values(derived.modelUsage).reduce((s, u) => s + u.outputTokens, 0)
    : derived.outputTokens

  // Count active filters (date / projects / models / harness) for the collapsed-bar badge.
  const harnessFilterActive = /^\/h\//.test(location.pathname)
  const activeFilterCount =
    (filters.dateRange !== 'all' || filters.customStart || filters.customEnd ? 1 : 0) +
    (filters.projects.length > 0 ? 1 : 0) +
    (filters.models.length > 0 ? 1 : 0) +
    (harnessFilterActive ? 1 : 0)

  // Block the app until the user makes the first-run archive choice. `archiveChoice` is guaranteed
  // resolved here (undefined would have kept `bootLoading` on the loader above) and `teamSession` is
  // non-undefined since the auth gate at the top — so `null` is the one remaining case: "loaded, not
  // yet chosen", which is the consent prompt, never a silent blank.
  // A central never shows the archive consent gate: it aggregates members' computed metrics
  // (stored in Mongo) and any self-contributed host data defaults server-side — there's nothing
  // for the operator to consent to here, so the blocking prompt would only annoy.
  if (archiveChoice === null && !teamSession.aggregatorOnly && !isCentral) {
    return (
      <ArchiveConsentModal
        lang={lang}
        onChoose={chooseArchive}
        onLangChange={(l) => {
          setLang(l)
          fetch('/api/preferences', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lang: l }),
          }).catch(() => {})
        }}
      />
    )
  }

  // Built once so the magnifier layer (Task 8) can be handed the exact same object the pages get
  // via <Outlet context>; two separately-built objects would drift out of sync.
  const appCtx: AppContext = {
    data,
    derived,
    statsCache,
    filters, setFilters, activeOnly, setActiveOnly,
    availableProjects, availableHarnesses,
    lang, theme, currency, setCurrency, brlRate,
    billing, saveBilling, costBasis, setCostBasis, planBasis, billingReady, openBillingSetup,
    comparisons, saveComparisons,
    tags: tagsList, monthCommitment,
    chatModel, setChatModel, chatSoundEnabled, setChatSoundEnabled, chatSoundId, setChatSoundId,
    savePreferences,
    pwaPrompt,
    onPwaInstalled: () => { setPwaInstalled(true); setPwaPrompt(null) },
    liveUpdates, setLiveUpdates, updateInterval, setUpdateInterval,
    riskyMode, setRiskyMode, highlightUpdates, setHighlightUpdates,
    monthlyBudgetUSD, updateBudget,
    totalInputTokens, totalOutputTokens,
    setExpandedChart, setSelectedSession, setInfoModalIndex,
    infoItems,
    cardOrder, setCardOrder,
    cardPrecision, setCardPrecision,
    sessionCountByProject, models, modelGroups, modelsInProject, users: usersWithMachines,
    harnesses: data.harnesses,
    isCentral,
    capabilities: teamSession?.capabilities,
    me: iam?.account,
    teams: teamsList,
    machines: machinesList,
    deniedRepoLabels,
    refreshDeniedRepoLabels,
    a11y,
  }

  /**
   * The sessions workspace's ONE bar: the selected session's title, the filters, the view tabs and
   * the actions — drawn INTO the fixed top strip.
   *
   * It began inside `SessionPanel`, was lifted into the shared header as a second full-width row
   * with its own rule, and now rides in the space the top strip has always left empty to the right
   * of the mark. Each move removed a band of chrome; this one removes the last, because the sticky
   * `<header>` under this strip existed in this workspace only to carry `FiltersBar` — a whole band
   * for one row of controls, directly beneath a band that was already there.
   *
   * The FILTERS are here whether or not a session is open: they narrow the LIST, which is what the
   * workspace shows with nothing selected.
   *
   * One line, not two: the title and its state share a row here, separated by a dot, because the
   * strip is 44px and stacking a subtitle under the title would either overflow it or shrink both
   * past reading. Desktop only — on mobile the strip is hidden and `SessionsPage` draws its own.
   */
  const sessionTopBar = (inSessionsWorkspace && !isMobile) ? (
    /* The body below is centred in a `PAGE_MAX_WIDTH` box inset by `PAGE_INSET`, so this row has to
       be too — `FleetOverview`'s own header records two failed attempts at this alignment, and both
       failed by matching one of the two numbers. `TopBar`'s `trailingFlush` is what makes the box
       this sits in exactly `<main>`'s content box; without it the strip's own padding leaves the two
       a few pixels apart at every width. */
    <div style={{
      // FULL WIDTH, not the body's 1400px box. Centring the strip's content in that box left ~550px
      // of dead bar on each side of a 2500px screen, with the title adrift in the middle and the
      // actions nowhere near the edge they belong to — reported as "should be space-between".
      // The body keeps its box; the BAR is chrome and runs edge to edge, the way a fixed header
      // does everywhere else. The left inset still matches `PAGE_INSET`, so the title starts on the
      // same vertical line the content below it does — that is the alignment worth keeping, and it
      // is the left edge, which is the one the eye follows down the page.
      width: '100%', padding: `0 ${PAGE_INSET}px`, boxSizing: 'border-box',
      display: 'flex', alignItems: 'center', gap: 10, minWidth: 0,
    }}>
      {selectedFleetSession && (
        <div style={{ minWidth: 0, flexShrink: 1, display: 'flex', alignItems: 'baseline', gap: 7 }}>
          <span style={{
            fontSize: 13.5, fontWeight: 650, color: 'var(--text-primary)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
          }}>
            {selectedFleetSession.title}
          </span>
          {/* Gives up before the title does: the name is what identifies the session, and the state
              is repeated on its own row in the aside two centimetres away. */}
          <span style={{
            fontSize: 11, color: 'var(--text-tertiary)', flexShrink: 1000000,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
          }}>
            {selectedFleetSession.stateLabel}
            {selectedFleetSession.project ? ` · ${selectedFleetSession.project}` : ''}
          </span>
        </div>
      )}

      {/* THE FILTERS, in the centre. They are the element that gives up width FIRST: the title
          identifies what you are looking at and the actions are how you act on it, while a narrowed
          filter bar is still a filter bar — its own `+ Filtro` popover holds everything it drops. */}
      {/* NO `overflow: hidden` HERE. It was added as the no-overlap guarantee and it also clipped
          the bar's own popovers — the `+ Filtro` menu opened into a hidden box, so the button read
          as dead. A clipping ancestor cannot tell a popover from an overflowing row. The overlap is
          prevented where it is caused instead: `headerFit` collapses the date block before the row
          can outgrow this slot, and the bar's own root is capped at 100%. */}
      <div ref={setFilterSlotEl} style={{ flex: 1, minWidth: 90, display: 'flex', justifyContent: 'center' }}>
        <FiltersBar
          inline
          dateCompact={stripFit.date === 'compact'}
          activeFiltersIcon={stripFit.activeFilters === 'icon'}
          addFilterIcon={stripFit.addFilter === 'icon'}
          only={SESSIONS_FILTER_DIMS}
          activeOnly={activeOnly}
          onActiveOnlyChange={setActiveOnly}
          filters={filters}
          onChange={setFilters}
          projects={availableProjects}
          sessionCountByProject={sessionCountByProject}
          models={models}
          modelGroups={modelGroups}
          modelsInProject={modelsInProject}
          users={[]}
          // HARNESSES come from the FLEET here and from the metrics everywhere else. The bar offered
          // all six the metrics know while the list it filters holds whatever is running — three on
          // this machine — so picking "antigravity" emptied the list. Nothing was broken; there were
          // genuinely no antigravity rows. But a filter that can only ever answer "nothing" is
          // indistinguishable from one that is failing, and it was reported as exactly that. An
          // option is a promise that something might be behind it.
          // The WHOLE fleet's assistants, not just the ones the current switches can show — see
          // `fleetFilterOptions`. The ones being withheld are MARKED rather than dropped, because a
          // dimension that disappears reads as "this product does not know about my other
          // assistants", which the Compare page contradicts two clicks away.
          harnesses={fleetOptions.harnessesAll as typeof availableHarnesses}
          harnessesOutOfView={fleetOptions.harnessesAll.filter(h => !fleetOptions.harnesses.includes(h))}
          lang={lang}
        />
      </div>

      {/* The magnifier pair, here for the reason it is in the dashboard's strip: this workspace
          renders no <header>, so without it the lenses would have no control on this route. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <MagnifierButton ctx={appCtx} />
        <HideLensesButton ctx={appCtx} />
      </div>

      {/* HARDWARE, on this route too. The whole action cluster is hidden in the sessions workspace
          — correctly, for the totals and the page-data Live toggle, neither of which describes a
          fleet that polls itself — and this button went with it. It answers "what is this machine
          doing right now", which is MORE relevant here than anywhere else: this is the screen where
          you watch that machine run several assistants at once. Reported as missing.
          It sits on the LIST side of the rule below, because it is about the machine and not about
          the session you have open. */}
      {!isCentral && (
        <button
          onClick={() => setHardwareOpen(true)}
          title={lang === 'pt' ? 'Recursos de hardware' : 'Hardware resources'}
          aria-label={lang === 'pt' ? 'Recursos de hardware' : 'Hardware resources'}
          aria-haspopup="dialog"
          style={{
            width: 30, height: 30, flexShrink: 0, display: 'flex', alignItems: 'center',
            justifyContent: 'center', borderRadius: 8, border: '1px solid var(--border)',
            background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer',
          }}
        >
          <Cpu size={14} />
        </button>
      )}

      {/* A RULE, not more gap. Everything to the left narrows the LIST; everything to the right is
          about the session you have open — two different questions that were sitting in one
          undifferentiated row of controls, which is what "entulhado" describes. A one-pixel line
          costs nothing and says where the row changes subject; the group after it keeps a wider
          gap of its own so the eye lands on the break rather than counting buttons. */}
      {selectedFleetSession && (
        <span aria-hidden style={{
          width: 1, alignSelf: 'stretch', margin: '4px 4px 4px 2px', flexShrink: 0,
          background: 'var(--border-subtle)',
        }} />
      )}

      {selectedFleetSession && selectedFleetSession.conversationBlind === undefined && (
        <div role="tablist" style={{
          display: 'flex', gap: 3, padding: 2, borderRadius: 9, flexShrink: 0,
          background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
        }}>
          <Segment
            on={sessionView === 'chat'} onClick={() => setSessionView('chat')}
            icon={<MessagesSquare size={13} />} label={lang === 'pt' ? 'Conversa' : 'Chat'}
          />
          <Segment
            on={sessionView === 'terminal'} onClick={() => setSessionView('terminal')}
            icon={<TerminalSquare size={13} />} label="Terminal"
          />
        </div>
      )}

      {/* THE ARTIFACTS BUTTON, beside the view tabs — the panel is a view OF this session, so it
          belongs with the two that already are.

          ABSENT ON A CENTRAL, not disabled: the list is derived from the session's own
          conversation, and the conversation does not leave the machine. A control that cannot work
          is not rendered inert — the same rule the fleet's verbs keep. The sentence is on the row
          in the panel's place, so the absence is explained where the button would have been. */}
      {/* WHAT THIS CONVERSATION HAS SPENT. The context percentage rides the button, because it is
          the one figure that changes what you do next: a session near its window is one to finish
          rather than extend. The record comes from the store by CONVERSATION id — a session the
          store has not seen yet reads as "not recorded yet", never as zero. */}
      {selectedFleetSession && (
        <SessionStatsMenu
          harness={selectedFleetSession.harness}
          sessionId={selectedFleetSession.conversationId ?? selectedFleetSession.id}
          meta={selectedFleetSession.conversationId
            ? data?.sessions?.find(x => x.session_id === selectedFleetSession.conversationId)
            : undefined}
          lang={lang === 'pt' ? 'pt' : 'en'}
          currency={currency}
          brlRate={brlRate}
          {...(selectedFleetSession.model ? { startedModel: selectedFleetSession.model } : {})}
          {...(selectedFleetSession.effort ? { startedEffort: selectedFleetSession.effort } : {})}
        />
      )}

      {selectedFleetSession && !isCentral && (
        <button
          onClick={toggleArtifacts}
          aria-pressed={artifacts.open}
          title={lang === 'pt'
            ? 'Conteúdo desta sessão — arquivos, docs, atividade, galeria e skills'
            : 'This session’s contents — files, docs, activity, gallery and skills'}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
            height: 30, padding: '0 10px', borderRadius: 9, cursor: 'pointer',
            border: '1px solid ' + (artifacts.open ? 'var(--anthropic-orange)' : 'var(--border-subtle)'),
            background: artifacts.open ? 'var(--anthropic-orange-dim)' : 'var(--bg-elevated)',
            color: artifacts.open ? 'var(--anthropic-orange)' : 'var(--text-secondary)',
            fontFamily: 'inherit', fontSize: 12,
          }}
        >
          {/* A DOCUMENT, and no number.
              The count went because it counts everything the session ever touched — past fifty on
              an ordinary afternoon — and a figure nobody acts on is furniture with a number on it.
              What deserves attention is a file being written NOW, which has its own announcement on
              the edge of the screen (`edgeHint`) and names the action instead of counting it.
              `FileText` rather than a panel glyph: a panel glyph says "something opens here" and
              leaves the reader to find out what. No single icon covers docs, the live feed AND the
              gallery, so it names what the panel opens on nine times out of ten and the tooltip
              carries the rest. `Files` (two sheets) was tried and reads as "copy". */}
          <FileText size={14} />
        </button>
      )}

      {selectedSessionRow && (
        <SessionActions
          row={selectedSessionRow}
          lang={lang === 'pt' ? 'pt' : 'en'}
          act={headerFleetAct}
          onGone={() => navigate('/sessions')}
          // A reopen mints a NEW session; going to it is what makes the verb visibly do something.
          onOpened={id => navigate(sessionPath(id))}
        />
      )}
    </div>
  ) : null

  /**
   * The DASHBOARD's own one bar — the same move the sessions workspace just made, for the same
   * reason: a fixed strip holding a mark and one icon, with the entire filter row as a second band
   * directly beneath it, is two bands doing one band's work.
   *
   * Everything that was in that band is here, unchanged: the filters, the filtered totals, the
   * health warnings, the hardware overlay, the bell, the Live toggle, the refresh, and the
   * collapsible fleet-stats tab that hangs under the row. This is a RELOCATION — dropping any of
   * them would be a regression nobody asked for.
   *
   * MOBILE IS UNTOUCHED. The strip is a desktop element; the phone keeps its collapsible filter
   * band and its bottom nav, which are sized for a viewport this row would not fit in.
   */
  const dashboardTopBar = (!inSessionsWorkspace && !isMobile && !isCustomPage) ? (
    <div style={{
      // Full width, for the reason the sessions strip records: a bar centred in the body's box
      // leaves dead chrome at both ends and pulls the action cluster off the edge it belongs to.
      width: '100%', padding: `0 ${PAGE_INSET}px`, boxSizing: 'border-box',
      display: 'flex', alignItems: 'center', gap: 14, minWidth: 0,
    }}>
      {/* THE FILTERS give up width FIRST. The cluster to their right is how you act on the page
          and how you read what it currently totals; a narrowed filter bar is still a filter bar,
          because its own `+ Filtro` popover holds every row it drops. */}
      {/* No clipping here either — see the sessions strip's note.
          `paddingLeft` is the action cluster's own width, mirrored on this side so the filters land
          on the STRIP's centre line rather than the centre of what is left beside them. */}
      <div ref={setFilterSlotEl} style={{
        flex: 1, minWidth: 90, display: 'flex', justifyContent: 'center',
        paddingLeft: stripPad, boxSizing: 'border-box',
      }}>
        <FiltersBar
          inline
          dateCompact={stripFit.date === 'compact'}
          activeFiltersIcon={stripFit.activeFilters === 'icon'}
          addFilterIcon={stripFit.addFilter === 'icon'}
          only={filterDimsForRoute}
          // THE SWITCH BELONGS ON BOTH PAGES — the user asked for exactly that, and Task 8 put it
          // inside the + Filter menu so it reads as a dimension rather than a pill beside them.
          // The sessions strip carried it and this one did not, which would have left "active
          // only" existing on one page of two.
          //
          // It stays ABSENT rather than disabled where no fleet can be read (an exposed profile,
          // a central with no machine chosen): `fleetReadable` withholds the callback, and
          // FiltersBar renders nothing for a dimension it was given no way to change. A control
          // whose only possible answer is "nothing" is not offered.
          activeOnly={activeOnly}
          onActiveOnlyChange={fleetReadable ? setActiveOnly : undefined}
          costBasis={costBasis}
          onCostBasisChange={isCentral ? undefined : setCostBasis}
          costBasisReady={billingReady.ready && planBasis.basis !== null}
          onCostBasisSetup={openBillingSetup}
          filters={filters}
          onChange={setFilters}
          projects={availableProjects}
          sessionCountByProject={sessionCountByProject}
          models={models}
          modelGroups={modelGroups}
          modelsInProject={modelsInProject}
          users={usersWithMachines}
          // The METRICS' harnesses, because this bar is the dashboard's. The fleet's own
          // narrower list belongs to the sessions strip (see `sessionTopBar`), which is where
          // that override moved when the workspace stopped rendering this header.
          harnesses={availableHarnesses}
          presence={data?.presence}
          lang={lang}
          teams={teamsList}
          machines={machinesList}
          tags={tagsList}
          canFilterMembers={canFilterMembers}
          onCreateTagFromFilters={createTagFromFilters}
        />
      </div>

      {/* Right column: the action cluster (alerts/live/refresh) on top, and the fleet
          stats strip right-aligned directly beneath it — so "Updated · members · machines ·
          projects · repos" lines up under the refresh button instead of stretching the bar.
          Absent for Sessions: those are stored-metrics totals and a page-data "Live" refresh
          toggle, neither of which describes a fleet that already polls and shows its own
          "Connected · last sync" in the aside. */}
      {!inSessionsWorkspace && (
      <div ref={setActionsEl} style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
        {/* The filtered totals used to sit here, immediately left of the action icons. They are in
            the STATS strip now, which is where they were asked to be and where they read better:
            that strip is already the row of facts about what is on screen, and the header is where
            you ACT on the page. It also stopped the header carrying a "5 sessions" three
            centimetres from the strip's own "5 sessions" — two different numbers (this one is
            filtered, that one is all-time) whose agreement was a coincidence of this machine. */}
        {/* The magnifier pair. It rode in the desktop filter band this strip replaced, so it moves
            with everything else that band carried — a lens control that exists on the phone and
            not on the desktop is the accessibility feature missing from the wider screen. */}
        <MagnifierButton ctx={appCtx} />
        <HideLensesButton ctx={appCtx} />
        {data?.healthIssues && data.healthIssues.length > 0 && (
          <HealthWarnings issues={data.healthIssues} lang={lang} />
        )}
        {/* Hardware — an overlay, beside the other header actions rather than in the sidebar,
            because it is a question about this machine and not a place to go. */}
        <button
          onClick={() => setHardwareOpen(true)}
          title={lang === 'pt' ? 'Recursos de hardware' : 'Hardware resources'}
          aria-label={lang === 'pt' ? 'Recursos de hardware' : 'Hardware resources'}
          aria-haspopup="dialog"
          style={{ width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer', transition: 'all 0.15s' }}
          onMouseEnter={e => { const t = e.currentTarget as HTMLButtonElement; t.style.color = 'var(--text-primary)'; t.style.borderColor = 'var(--text-tertiary)' }}
          onMouseLeave={e => { const t = e.currentTarget as HTMLButtonElement; t.style.color = 'var(--text-tertiary)'; t.style.borderColor = 'var(--border)' }}
        >
          <Cpu size={14} />
        </button>
        <NotificationBell lang={lang} buttonStyle={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 32, height: 32, borderRadius: 8,
          border: '1px solid var(--border)', background: 'transparent',
          color: 'var(--text-tertiary)', cursor: 'pointer', position: 'relative',
        }} />
        {!isCentral && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px 0 10px', height: 32,
            borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-secondary)',
          }}>
            <Activity size={12} style={{ color: liveUpdates ? 'var(--anthropic-orange)' : 'var(--text-tertiary)', flexShrink: 0, transition: 'color 0.2s' }} />
            <span style={{ fontSize: 11, fontWeight: 500, color: liveUpdates ? 'var(--text-primary)' : 'var(--text-tertiary)', whiteSpace: 'nowrap', userSelect: 'none' }}>Live</span>
            <button
              onClick={() => setLiveUpdates(v => !v)}
              title={liveUpdates ? 'Pause live updates' : 'Enable live updates'}
              style={{ position: 'relative', width: 28, height: 16, borderRadius: 8, border: 'none', background: liveUpdates ? 'var(--anthropic-orange)' : 'var(--text-tertiary)', cursor: 'pointer', padding: 0, transition: 'background 0.2s', flexShrink: 0 }}
            >
              <span style={{ position: 'absolute', top: 2, left: liveUpdates ? 14 : 2, width: 12, height: 12, borderRadius: '50%', background: '#fff', transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)' }} />
            </button>
            {liveUpdates && (
              <span style={{ fontSize: 10, fontWeight: 700, color: riskyMode && updateInterval < 10 ? '#ef4444' : 'var(--anthropic-orange)', userSelect: 'none' }}>
                {riskyMode && updateInterval < 10 ? `⚡ ${updateInterval}s` : `${updateInterval >= 60 ? `${updateInterval / 60}m` : `${updateInterval}s`}`}
              </span>
            )}
          </div>
        )}
        <button
          onClick={refetch}
          title={lang === 'pt' ? 'Atualizar' : 'Refresh'}
          style={{ width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer', transition: 'all 0.15s' }}
          onMouseEnter={e => { const t = e.currentTarget as HTMLButtonElement; t.style.color = 'var(--text-primary)'; t.style.borderColor = 'var(--text-tertiary)' }}
          onMouseLeave={e => { const t = e.currentTarget as HTMLButtonElement; t.style.color = 'var(--text-tertiary)'; t.style.borderColor = 'var(--border)' }}
        >
          <RefreshCw size={14} />
        </button>
      </div>
      )}
      {/* The collapsible "fleet stats" tab, which hangs BELOW this row (position: absolute,
          top: 100%) and is therefore anchored to the fixed strip now rather than to the sticky
          header that used to hold it. Expands to updated/since + members/machines/teams/projects/
          repos. Dashboard only — these are STORED metrics, and a live fleet already states its own
          "Connected · last sync" in the aside. */}
      {/* Guarded by this row's own condition — see `dashboardTopBar`. */}
      {(() => {
        const sep = <span style={{ color: 'var(--border)' }}>·</span>
        const iconSt: React.CSSProperties = { color: 'var(--text-tertiary)', flexShrink: 0 }
        return (
          <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 300, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
            <div style={{ maxWidth: PAGE_MAX_WIDTH, width: '100%', display: 'flex', justifyContent: 'flex-end', paddingRight: PAGE_INSET, boxSizing: 'border-box', pointerEvents: 'none' }}>
              <div style={{ pointerEvents: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                <button
                  onClick={toggleFleet}
                  title={fleetOpen ? (lang === 'pt' ? 'Minimizar' : 'Collapse') : (lang === 'pt' ? 'Mostrar estatísticas' : 'Show stats')}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 5, padding: '2px 10px 3px',
                    border: '1px solid var(--border)', borderTop: 'none',
                    borderRadius: '0 0 8px 8px', background: 'var(--bg-surface)',
                    color: 'var(--text-tertiary)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 10.5,
                  }}
                >
                  {lang === 'pt' ? 'Estatísticas' : 'Stats'}
                  {fleetOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                </button>
                {fleetOpen && (
                  <div style={{
                    display: 'flex', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end', gap: '2px 9px',
                    marginTop: 4, padding: '7px 12px', borderRadius: 8, maxWidth: '80vw',
                    border: '1px solid var(--border)', background: 'var(--bg-surface)', boxShadow: '0 6px 20px rgba(0,0,0,0.25)',
                    fontSize: 11, color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums',
                  }}>
                    {/* WHAT IS ON SCREEN, first — the totals the filters actually produced. They
                        lead because they are the numbers that move when you touch a filter;
                        everything after them is the standing context of the whole machine.

                        The group is NAMED. Without the word this strip would carry two counts of
                        "sessions" — this one narrowed by the filters, the one inside `fleetSince`
                        counting every session ever recorded — and on the machine this was reported
                        from they happened to be the same number, which is exactly the coincidence
                        that makes an unlabelled pair impossible to tell apart later. */}
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ textTransform: 'uppercase', fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4, opacity: 0.75 }}>
                        {lang === 'pt' ? 'No filtro' : 'In view'}
                      </span>
                      <span><strong style={{ color: 'var(--text-secondary)', fontWeight: 700 }}>{derived.totalSessions.toLocaleString()}</strong> {lang === 'pt' ? (derived.totalSessions === 1 ? 'sessão' : 'sessões') : (derived.totalSessions === 1 ? 'session' : 'sessions')}</span>
                      <span style={{ opacity: 0.35 }}>·</span>
                      <span style={{ color: 'var(--anthropic-orange)', fontWeight: 600 }} title={headerCostTitle}>{fmtCost(headerCostUSD, currency, brlRate)}</span>
                      <span style={{ opacity: 0.35 }}>·</span>
                      <span title={headerTokensTitle}><strong style={{ color: 'var(--text-secondary)', fontWeight: 700 }}>{fmt(headerTokens)}</strong> tok</span>
                    </span>
                    {sep}
                    <span>{lang === 'pt' ? 'Atualizado em' : 'Updated'} <span style={{ color: 'var(--text-secondary)' }}>{fleetUpdated}</span></span>
                    {fleetSince && (<>{sep}<span style={{ color: 'var(--text-secondary)' }}>{fleetSince}</span></>)}
                    {isCentral && (<>
                      {sep}
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        <Users size={11} style={iconSt} />
                        <span style={{ color: 'var(--text-secondary)' }}>{memberCount} {lang === 'pt' ? (memberCount === 1 ? 'membro' : 'membros') : (memberCount === 1 ? 'member' : 'members')}</span>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} />{onlineCount}</span>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: '#ef4444', display: 'inline-block' }} />{offlineCount}</span>
                      </span>
                      {sep}
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        <Server size={11} style={iconSt} />
                        <span style={{ color: 'var(--text-secondary)' }}>{machineCount} {lang === 'pt' ? (machineCount === 1 ? 'máquina' : 'máquinas') : (machineCount === 1 ? 'machine' : 'machines')}</span>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }} title={lang === 'pt' ? 'Máquinas online' : 'Machines online'}><span style={{ width: 6, height: 6, borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} />{machinesOnline}</span>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }} title={lang === 'pt' ? 'Máquinas offline' : 'Machines offline'}><span style={{ width: 6, height: 6, borderRadius: '50%', background: '#ef4444', display: 'inline-block' }} />{machinesOffline}</span>
                      </span>
                      {sep}
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        <Users size={11} style={iconSt} />
                        <span style={{ color: 'var(--text-secondary)' }}>{teamCount} {lang === 'pt' ? (teamCount === 1 ? 'time' : 'times') : (teamCount === 1 ? 'team' : 'teams')}</span>
                      </span>
                    </>)}
                    {sep}
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      <FolderOpen size={11} style={iconSt} />
                      <span style={{ color: 'var(--text-secondary)' }}>{projectCount} {lang === 'pt' ? (projectCount === 1 ? 'projeto' : 'projetos') : (projectCount === 1 ? 'project' : 'projects')}</span>
                    </span>
                    {sep}
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      <GitBranch size={11} style={iconSt} />
                      <span style={{ color: 'var(--text-secondary)' }}>{repoCount} {lang === 'pt' ? (repoCount === 1 ? 'repositório' : 'repositórios') : (repoCount === 1 ? 'repository' : 'repositories')}</span>
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  ) : null

  /**
   * What rides in the strip. One of the two, never both — they are guarded by the same workspace
   * test from opposite sides — and both centre themselves in the page's own max-width box, which is
   * why the strip is asked to hand them the box the body has (`trailingFlush`).
   */
  const stripTrailing = sessionTopBar ?? dashboardTopBar

  // Whether some chrome already draws the magnifier buttons — mirrored from the slots themselves
  // (never re-hardcoded) so MagnifierLayer knows when NO slot exists and must draw its own
  // floating button. Two slots host them: the phone's sticky <header> below, and the desktop top
  // strip's trailing region. `stripTrailing` IS that region, so asking it is exact; a second copy
  // of its conditions would be a second place for the two to disagree.
  const headerHostsMagnifier = (!inSessionsWorkspace && isMobile) || stripTrailing !== null

  return (
    <div style={{
      // `min-height` is NOT set in the sessions workspace, and that is the whole fix.
      //
      // CSS resolves `min-height` AFTER `height`, so a `min-height: 100vh` beats any smaller
      // `height` — the column below asked for `calc(100dvh - var(--mobile-nav-h))` (608px on an
      // iPhone 12) and computed 664px anyway, because this line said it may never be shorter than
      // the full window. The composer sits at the bottom of that column, so those 56 lost pixels
      // put it exactly underneath the fixed bottom nav: rendered, inside the viewport, and covered.
      // Measured before the fix — input at 606-642, nav starting at 608.
      //
      // Everywhere else it stays, because a short page still has to fill the window.
      ...(inSessionsWorkspace ? {} : { minHeight: '100vh' }),
      // The REAL cause of the session pane's header/composer "scrolling away" and landing at the
      // wrong spot: `<main>` below sets an explicit `height` for the sessions workspace, but a flex
      // item with `flex: 1 1 0%` computes its used size from the flex algorithm, not from its own
      // `height` — and that algorithm needs the CONTAINER (this div) to have a DEFINITE height to
      // distribute. `minHeight` alone leaves it auto/content-sized, so `<main>` silently grew to fit
      // an 11.000px-tall conversation instead of clipping at the viewport, and every "scroll to the
      // bottom" call landed on an inner div that never actually had room to scroll. `position:
      // sticky` on the header/composer masked the visual symptom (they still track the PAGE's own
      // scroll) without fixing the underlying non-clipping — this fixes it at the source instead.
      // MOBILE GETS `dvh`, AND SUBTRACTS THE FIXED BOTTOM NAV — the desktop `100vh` is wrong on a
      // phone twice over, and `<main>` below could not rescue it.
      //
      // `<main>` already asks for `calc(100dvh - var(--mobile-nav-h))`, which is the right figure.
      // It never got it: `<main>` is `flex: 1 1 0%` inside THIS div, and a flex item's main-axis
      // size comes from the flex algorithm distributing its CONTAINER's height, not from its own
      // `height` — the very rule this comment block was written to record. So the child's careful
      // arithmetic was overridden by the parent's `100vh`, and `100vh` on a phone is (a) taller
      // than the visible area, because it does not shrink for the browser's collapsing URL bar,
      // and (b) measured to the window's bottom edge, under the fixed 56px-plus-inset nav.
      //
      // The composer sits at the bottom of that column, so it was pushed below the fold and behind
      // the nav — reported as "the input does not appear at all", with the conversation unable to
      // scroll because the scrolling box never had a bounded height to scroll within.
      //
      // Fixing it HERE rather than on `<main>` is the point: the container is what the flex
      // algorithm reads.
      // The nav subtraction is conditional on the nav being THERE. With a session open the bar is
      // not rendered (see its own note below), so still subtracting it would leave a 56px band of
      // nothing under the composer — the same class of mismatch as the `min-height` that used to
      // beat this line, seen from the other side.
      //
      // THE NAV'S ROOM IS PADDING, NOT A SHORTER BOX — and that distinction is the whole of the
      // floating-nav bug. `calc(100dvh - var(--mobile-nav-h))` ended this div one nav-height above
      // the bottom of the screen, and `MobileBottomNav` is rendered INSIDE it.
      //
      // A `position: fixed` descendant is supposed to ignore its ancestors and answer to the
      // viewport. It stops doing that when an ancestor clips: `index.css` gives `#root`
      // `overflow-x: clip` on mobile — deliberately, because `hidden` would compute `overflow-y`
      // to `auto` and break every `position: sticky` header (its own note records that) — and a
      // lone `clip` on one axis computes the other axis to `clip` as well. WebKit then clips and
      // anchors fixed descendants to that box rather than to the window. So `bottom: 0` resolved
      // against THIS div's bottom edge, and the bar hovered exactly one nav-height off the floor
      // with the page's ground showing beneath it.
      //
      // The dashboard was correct on the same screen at the same moment, which is what names the
      // cause: there this height is `undefined`, the div reaches the bottom, and anchoring to it
      // or to the viewport gives the same answer. The sessions list was the only page where the
      // two differed — by exactly the height of the thing that moved.
      //
      // `height: 100dvh` + `padding-bottom: var(--mobile-nav-h)` gives the flex algorithm the very
      // same definite CONTENT height it had before — `box-sizing: border-box` is global, so the
      // children see `100dvh - nav` either way, and every measurement in the notes above still
      // holds. What changes is that this div's border box now reaches the real bottom of the
      // screen, so a fixed descendant has nothing left to resolve against wrongly. The nav then
      // overlays its own padding, which is what the padding is for.
      height: inSessionsWorkspace ? (isMobile ? '100dvh' : '100vh') : undefined,
      // Only on the LIST. With a session open the bar is not rendered at all (see its own note),
      // so reserving its band would leave a strip of nothing under the composer — the same
      // mismatch the old subtraction made, seen from the other side.
      ...(inSessionsWorkspace && isMobile && !sessionOpen
        ? { paddingBottom: 'var(--mobile-nav-h)' }
        : {}),
      background: 'var(--bg-base)', display: 'flex', flexDirection: 'column',
      paddingLeft: isMobile ? 0 : (sidebarCollapsed ? SIDEBAR_W_COLLAPSED : liveAsideWidth),
      paddingTop: isMobile ? 0 : 'var(--ag-topbar-h)',
      boxSizing: 'border-box',
      transition: 'padding-left 0.22s cubic-bezier(0.22, 1, 0.36, 1)',
    }}>
      {/* The billing prompt. Mounted HERE, after the archive consent gate's early return above, so
          the two can never stack on a first launch — one blocking modal behind one dismissible one
          is a pile nobody reads. It is the same component for the first-run invite and for the
          disabled cost-basis control, which opens it with the specific gaps listed. */}
      <BillingIntroModal
        open={(billingSetupOpen || showBillingIntro) && !isCentral}
        mode={billingSetupOpen ? 'setup' : 'intro'}
        gaps={billingSetupOpen ? billingReady.gaps : []}
        lang={lang}
        onClose={() => { setBillingSetupOpen(false); setBillingIntroSeen(true) }}
        onNeverShowAgain={() => {
          setBillingIntroSeen(true)
          void saveBilling({ ...billing, introDismissed: true })
        }}
      />
      {/* The fixed strip above the aside — desktop only. */}
      {!isMobile && (
        <TopBar
          lang={lang === 'pt' ? 'pt' : 'en'}
          height={TOPBAR_H}
          asideWidth={sidebarCollapsed ? SIDEBAR_W_COLLAPSED : liveAsideWidth}
          collapsed={sidebarCollapsed}
          onToggleSidebar={toggleSidebar}
          {...(modeOfPath(location.pathname) === 'sessions'
            ? { onSearch: () => window.dispatchEvent(new CustomEvent('agentistics:focus-session-search')) }
            : {})}
          {...(stripTrailing ? { trailing: stripTrailing, trailingFlush: true } : {})}
        />
      )}
      {/* Left sidebar nav — desktop only (mobile uses the bottom nav) */}
      {!isMobile && <SideNav
        lang={lang}
        harnesses={data.harnesses}
        isCentral={isCentral}
        hasWorkflows={(data.workflows?.length ?? 0) > 0}
        collapsed={sidebarCollapsed}
        width={liveAsideWidth}
        onResize={setAsideWidth}
        onCommitWidth={commitAsideWidth}
        onToggle={toggleSidebar}
        theme={theme}
        onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        onToggleLang={() => { const next = lang === 'pt' ? 'en' : 'pt'; setLang(next); if (next === 'pt') setCurrency('BRL'); else if (currency === 'BRL') setCurrency('USD') }}
        onExport={() => navigate('/export')}
        principal={iam?.account}
        sessionsFilters={filters}
        sessionsActiveOnly={activeOnly}
      />}
      {/* Header */}
      {/* Page chrome — the MOBILE dashboard's, and only that.
          The sessions workspace used to render this too, on desktop, purely to carry `FiltersBar`:
          a whole sticky band with its own rule, one row of controls in it, directly beneath the
          fixed strip that was already there. The filters now ride IN that strip (see
          `sessionTopBar`), so the workspace has ONE bar and this element is not rendered in it at
          all — on mobile it never was, because `SessionsPage` draws its own bars.
          The root cause of "the pane's own header scrolled away" was never this strip's presence —
          it was `<main>` lacking a DEFINITE height to clip to, fixed at the wrapper `<div>` above.
          On DESKTOP the dashboard now does the same thing, for the same reason (see
          `dashboardTopBar`), so what is left in here is the phone's own chrome: the logo/bell row
          and the collapsible filter band, both sized for a viewport the strip's row would not fit
          in. Nothing about mobile changed. */}
      {!inSessionsWorkspace && isMobile && (
      <header style={{
        background: 'var(--bg-surface)',
        position: 'sticky',
        // Beneath the fixed strip, never at the viewport top: one is window chrome and the other is
        // page chrome, and neither may slide under the other.
        top: isMobile ? 0 : 'var(--ag-topbar-h)',
        // The status-bar band belongs to the BAR, not to the page under it: the header's own
        // background and blur run up behind the clock, and its content starts below. Zero in a
        // browser tab — see `--safe-top`.
        ...(isMobile ? { paddingTop: 'var(--safe-top)' } : {}),
        zIndex: 100,
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        boxShadow: scrolled ? '0 4px 24px rgba(0,0,0,0.25)' : 'none',
        borderBottom: '1px solid var(--border)',
        transition: 'box-shadow 0.25s ease',
      }}>
        {/* Mobile top bar — logo + bell. On desktop the header is a single row (the filters
            bar below), with the sidebar carrying identity/config and the filters row carrying
            live/alerts, so there are no longer two stacked header rows. */}
        {isMobile && (
          <div style={{
            maxWidth: 1400, margin: '0 auto', padding: '0 16px', height: 48,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <img src='/minimalistLogo.png' alt="agentistics" style={{ height: 44, width: 'auto' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <MagnifierButton ctx={appCtx} />
              <HideLensesButton ctx={appCtx} />
              {data?.healthIssues && data.healthIssues.length > 0 && (
                <HealthWarnings issues={data.healthIssues} lang={lang} />
              )}
              <NotificationBell lang={lang} buttonStyle={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 32, height: 32, borderRadius: 8,
                border: '1px solid var(--border)', background: 'transparent',
                color: 'var(--text-tertiary)', cursor: 'pointer', position: 'relative',
              }} />
            </div>
          </div>
        )}


        {/* Filters — full bar, fixed in the sticky header so it's reachable at any
            scroll position. Hidden on /custom. On mobile the bar is collapsible
            (a slim summary row) so it doesn't eat the viewport while scrolling;
            the harness chips sit on their own row above the date/projects/models
            controls. Desktop always shows the full bar. */}
        {data && !isCustomPage && !inSessionsWorkspace && isMobile && (
          <div style={{ borderTop: '1px solid var(--border)', width: '100%', boxSizing: 'border-box' }}>
            {/* Collapsed slim row — visible only when minimized; tap to expand. */}
            {filtersCollapsed && (
              <button
                onClick={expandFilters}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                  padding: '9px 14px', background: 'transparent', border: 'none',
                  color: 'var(--text-secondary)', fontFamily: 'inherit', fontSize: 13,
                  fontWeight: 600, cursor: 'pointer',
                }}
              >
                <SlidersHorizontal size={15} style={{ color: 'var(--anthropic-orange)' }} />
                <span>{lang === 'pt' ? 'Filtros' : 'Filters'}</span>
                {activeFilterCount > 0 && (
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    minWidth: 18, height: 18, padding: '0 5px', borderRadius: 9,
                    background: 'var(--anthropic-orange)', color: '#fff',
                    fontSize: 11, fontWeight: 700,
                  }}>
                    {activeFilterCount}
                  </span>
                )}
                <ChevronDown size={18} style={{ marginLeft: 'auto', opacity: 0.6 }} />
              </button>
            )}
            {/* Animated panel — collapses via a grid-rows transition so minimize
                and expand both glide instead of snapping. */}
            <div
              style={{
                display: 'grid',
                gridTemplateRows: filtersCollapsed ? '0fr' : '1fr',
                transition: 'grid-template-rows 0.3s cubic-bezier(0.22, 1, 0.36, 1)',
              }}
              onTransitionEnd={() => { if (!filtersCollapsed) setFiltersClip(false) }}
            >
              <div style={{ overflow: (filtersCollapsed || filtersClip) ? 'hidden' : 'visible', minHeight: 0 }}>
                <FiltersBar
                  only={filterDimsForRoute}
                  costBasis={costBasis}
                  onCostBasisChange={isCentral ? undefined : setCostBasis}
                  costBasisReady={billingReady.ready && planBasis.basis !== null}
                  onCostBasisSetup={openBillingSetup}
                  activeOnly={activeOnly}
                  onActiveOnlyChange={fleetReadable ? setActiveOnly : undefined}
                  filters={filters}
                  onChange={setFilters}
                  projects={availableProjects}
                  sessionCountByProject={sessionCountByProject}
                  models={models}
                  modelGroups={modelGroups}
                  modelsInProject={modelsInProject}
                  users={usersWithMachines}
                  harnesses={availableHarnesses}
                  presence={data?.presence}
                  lang={lang}
                  compact
                  teams={teamsList}
                  machines={machinesList}
                  tags={tagsList}
                  canFilterMembers={canFilterMembers}
                  onCreateTagFromFilters={createTagFromFilters}
                />
                {/* Collapse handle */}
                <button
                  onClick={collapseFilters}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                    width: '100%', padding: '5px 0 7px', background: 'transparent', border: 'none',
                    color: 'var(--text-tertiary)', fontFamily: 'inherit', fontSize: 12,
                    fontWeight: 600, cursor: 'pointer',
                  }}
                >
                  <ChevronUp size={15} />
                  {lang === 'pt' ? 'Minimizar filtros' : 'Minimize filters'}
                </button>
              </div>
            </div>

            {/* Totals + fleet stats — the mobile counterpart of the desktop action-cluster numbers
                and the collapsible fleet tab that hangs under the desktop header. Shares fleetOpen
                with the desktop tab, so the choice survives a resize. */}
            <div style={{ borderTop: '1px solid var(--border)' }}>
              <button
                onClick={toggleFleet}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 40,
                  padding: '0 14px', background: 'transparent', border: 'none',
                  fontFamily: 'inherit', fontSize: 12, cursor: 'pointer',
                  color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums',
                }}
              >
                <span><strong style={{ color: 'var(--text-secondary)', fontWeight: 700 }}>{derived.totalSessions.toLocaleString()}</strong> {lang === 'pt' ? 'sessões' : 'sessions'}</span>
                <span style={{ opacity: 0.35 }}>·</span>
                <span style={{ color: 'var(--anthropic-orange)', fontWeight: 600 }} title={headerCostTitle}>{fmtCost(headerCostUSD, currency, brlRate)}</span>
                <span style={{ opacity: 0.35 }}>·</span>
                <span title={headerTokensTitle}><strong style={{ color: 'var(--text-secondary)', fontWeight: 700 }}>{fmt(headerTokens)}</strong> tok</span>
                <ChevronDown size={16} style={{ marginLeft: 'auto', opacity: 0.6, transform: fleetOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
              </button>
              {fleetOpen && (() => {
                const chip: React.CSSProperties = {
                  display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 999,
                  background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                }
                const val: React.CSSProperties = { color: 'var(--text-secondary)', fontWeight: 600 }
                return (
                  <div style={{
                    display: 'flex', flexWrap: 'wrap', gap: 6, padding: '2px 14px 10px',
                    fontSize: 11, color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums',
                  }}>
                    {/* The same "what is on screen" group the desktop strip leads with, as one
                        chip. Parity is the point: the totals moved OUT of the desktop header into
                        this strip, and a phone that never got them would be the one layout where
                        the filters produce no readable total at all. */}
                    <span style={chip}>
                      <span style={{ textTransform: 'uppercase', fontSize: 9, fontWeight: 700, letterSpacing: 0.4, opacity: 0.75 }}>
                        {lang === 'pt' ? 'No filtro' : 'In view'}
                      </span>
                      <span style={val}>{derived.totalSessions.toLocaleString()}</span>
                      <span style={{ opacity: 0.35 }}>·</span>
                      <span style={{ color: 'var(--anthropic-orange)', fontWeight: 600 }}>{fmtCost(headerCostUSD, currency, brlRate)}</span>
                      <span style={{ opacity: 0.35 }}>·</span>
                      <span style={val}>{fmt(headerTokens)}</span> tok
                    </span>
                    <span style={chip}>{lang === 'pt' ? 'Atualizado' : 'Updated'} <span style={val}>{fleetUpdated}</span></span>
                    {fleetSince && <span style={chip}><span style={val}>{fleetSince}</span></span>}
                    {isCentral && (<>
                      <span style={chip}>
                        <Users size={11} />
                        <span style={val}>{memberCount}</span>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} />{onlineCount}</span>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: '#ef4444', display: 'inline-block' }} />{offlineCount}</span>
                      </span>
                      <span style={chip}>
                        <Server size={11} />
                        <span style={val}>{machineCount}</span> {lang === 'pt' ? (machineCount === 1 ? 'máquina' : 'máquinas') : (machineCount === 1 ? 'machine' : 'machines')}
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} />{machinesOnline}</span>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: '#ef4444', display: 'inline-block' }} />{machinesOffline}</span>
                      </span>
                      <span style={chip}><Users size={11} /> <span style={val}>{teamCount}</span> {lang === 'pt' ? (teamCount === 1 ? 'time' : 'times') : (teamCount === 1 ? 'team' : 'teams')}</span>
                    </>)}
                    <span style={chip}><FolderOpen size={11} /> <span style={val}>{projectCount}</span> {lang === 'pt' ? (projectCount === 1 ? 'projeto' : 'projetos') : (projectCount === 1 ? 'project' : 'projects')}</span>
                    <span style={chip}><GitBranch size={11} /> <span style={val}>{repoCount}</span> {lang === 'pt' ? (repoCount === 1 ? 'repositório' : 'repositórios') : (repoCount === 1 ? 'repository' : 'repositories')}</span>
                  </div>
                )
              })()}
            </div>
          </div>
        )}

        {/* Nav moved to the left sidebar (SideNav) on desktop; mobile uses the bottom nav. */}

      </header>
      )}

      {/* Main content — routed pages render here via <Outlet /> */}
      {/* The sessions workspace is an APPLICATION PANE, not a document: it holds a terminal and a
          conversation, both of which scroll inside themselves and must fill the window exactly.
          Every dashboard page is the opposite — a column of cards, centred and padded, that grows
          past the fold. So the two get different frames rather than one frame with the sessions
          case fighting a max-width, a page-level scroll and a footer it has no use for. */}
      <main style={
        inSessionsWorkspace
          ? {
              width: '100%', boxSizing: 'border-box', flex: 1, minWidth: 0,
              // The exact window minus the fixed strip. This is only correct because the filters
              // bar is NOT rendered in this workspace — see the header's own condition. While it
              // was, root content exceeded the viewport by that bar's height, the PAGE scrolled,
              // and the session's own header scrolled away with it.
              // On MOBILE this fills the parent, which already subtracts the fixed nav (see the
              // root's own note) — repeating the arithmetic here is what let the two disagree.
              // Desktop still subtracts its own fixed top strip, which the root does not know about.
              height: isMobile ? undefined : 'calc(100vh - var(--ag-topbar-h))',
              minHeight: 0,
              display: 'flex', flexDirection: 'column', overflow: 'hidden',
            }
          : {
              maxWidth: 1400,
              margin: '0 auto',
              width: '100%',
              boxSizing: 'border-box',
              flex: 1,
              // Fill at least the viewport so the footer always sits below the fold (a scroll away),
              // even on short pages — it never floats up into a half-empty screen.
              minHeight: '100vh',
              // The bottom padding clears the fixed nav, so it has to grow with it: installed as a
              // PWA the bar is 56px + the home-indicator inset, and a flat 80px hid the last card.
              padding: isMobile ? '16px 16px calc(24px + var(--mobile-nav-h))' : '24px 32px',
              display: 'flex',
              flexDirection: 'column',
              gap: isMobile ? 14 : 20,
            }
      }>
        <Outlet context={appCtx} />
      </main>

      {/* Install Modal — shown once after first data load */}
      {showInstallModal && (
        <InstallModal
          lang={lang}
          pwaPrompt={pwaPrompt}
          onClose={(dontShowAgain) => {
            setShowInstallModal(false)
            if (dontShowAgain) {
              setInstallDismissedPref(true)
              try { localStorage.setItem(INSTALL_DISMISSED_KEY, 'true') } catch {}
              // Persist server-side so it survives incognito windows / a cleared localStorage.
              fetch('/api/preferences', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ installDismissed: true }),
              }).catch(() => {})
            }
          }}
          onPwaInstalled={() => { setPwaInstalled(true); setPwaPrompt(null) }}
        />
      )}

      {/* Update available modal — opt-in only, opened via the toast/bell (see
          'agentistics:open-update-modal'). Never auto-opens: see `showUpdateModal` above. */}
      {updateInfo && showUpdateModal && (
        <UpdateModal
          current={updateInfo.current}
          latest={updateInfo.latest}
          lang={lang}
          isCentral={isCentral}
          isMember={isMember}
          onClose={() => setShowUpdateModal(false)}
        />
      )}

      {/* Info Modal */}
      {infoModalIndex !== null && (
        <InfoModal
          items={infoItems}
          currentIndex={infoModalIndex}
          onClose={() => setInfoModalIndex(null)}
          onNavigate={setInfoModalIndex}
          lang={lang}
        />
      )}

      {/* Chart expand modals */}
      {expandedChart === 'activity' && (
        <ChartModal
          title={<><BarChart2 size={14} /> {lang === 'pt' ? 'Atividade ao longo do tempo' : 'Activity over time'}</>}
          onClose={() => setExpandedChart(null)}
        >
          <ActivityChart data={derived.heatmapData} height={480} theme={theme} />
        </ChartModal>
      )}
      {expandedChart === 'heatmap' && (
        <ChartModal
          title={lang === 'pt' ? 'Heatmap de atividade' : 'Activity heatmap'}
          onClose={() => setExpandedChart(null)}
        >
          <ActivityHeatmap data={derived.heatmapData} weeks={52} />
        </ChartModal>
      )}
      {expandedChart === 'hours' && (
        <ChartModal
          title={lang === 'pt' ? 'Uso por hora do dia' : 'Usage by hour'}
          onClose={() => setExpandedChart(null)}
        >
          <HourChart hourCounts={derived.hourCounts} hourMeta={derived.hourMeta} height={520} />
        </ChartModal>
      )}
      {expandedChart === 'models' && (
        <ChartModal
          title={<><TrendingUp size={14} /> {lang === 'pt' ? 'Uso por modelo' : 'Model usage & cost'}</>}
          onClose={() => setExpandedChart(null)}
        >
          <ModelBreakdown
            modelUsage={derived.modelUsage}
            currency={currency}
            brlRate={brlRate}
            fallbackInputTokens={filters.projects.length > 0 ? derived.inputTokens : undefined}
            fallbackOutputTokens={filters.projects.length > 0 ? derived.outputTokens : undefined}
            fallbackCostUSD={filters.projects.length > 0 ? derived.totalCostUSD : undefined}
          />
        </ChartModal>
      )}

      {/* Session drilldown modal */}
      {selectedSession && (
        <SessionDrilldownModal
          session={selectedSession}
          globalModelUsage={data.statsCache.modelUsage ?? {}}
          currency={currency}
          brlRate={brlRate}
          lang={lang}
          workflows={data.workflows}
          onClose={() => setSelectedSession(null)}
        />
      )}

      <TranscriptModal lang={lang} />

      {/* PDF Direct Export — triggered from chat, no modal */}
      {pdfDirectExportRange !== null && (
        <PDFDirectExporter
          data={data}
          range={pdfDirectExportRange}
          currentFilters={filters}
          lang={lang}
          currency={currency}
          brlRate={brlRate}
          onDone={() => setPdfDirectExportRange(null)}
        />
      )}

      {hardwareOpen && <HardwareModal lang={lang} onClose={() => setHardwareOpen(false)} />}

      {/* Mobile bottom navigation bar — HIDDEN while a session is open.
          A session's panel is a full-screen reading-and-typing surface: the conversation fills the
          column and the composer sits at its foot. Five destinations under a keyboard is chrome
          competing with the thing it wraps, on a screen only 664px tall to begin with — the nav
          was costing 56 of them plus the safe-area inset. It costs nothing to leave: the panel has
          its own back arrow in the top bar, which is the way out and the only one a reader needs
          while they are in it. The root's height drops the matching subtraction — see its note. */}
      {isMobile && !sessionOpen && (
        <MobileBottomNav
          lang={lang}
          harnesses={data.harnesses}
            onRefresh={refetch}
          onOpenHardware={() => setHardwareOpen(true)}
          liveUpdates={liveUpdates}
          onToggleLive={() => setLiveUpdates(v => !v)}
          updateInterval={updateInterval}
          healthIssues={data.healthIssues}
          isCentral={isCentral}
          hasWorkflows={(data.workflows?.length ?? 0) > 0}
          principal={iam?.account}
          theme={theme}
          onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          onToggleLang={() => { const next = lang === 'pt' ? 'en' : 'pt'; setLang(next); if (next === 'pt') setCurrency('BRL'); else if (currency === 'BRL') setCurrency('USD') }}
          a11yEnabled={a11y.prefs.enabled}
        />
      )}

      {/* TTY Chat (Nay) — floating button + panel. Hidden on a pure central (aggregator with
          no local harness): the chat needs a locally-installed harness to be meaningful.
          Also hidden when the server revoked the localChat capability (an exposed instance
          answers /api/chat-tty and /api/exec with 403 — see server/capability-guard.ts), so the
          UI never offers an action that cannot work. */}
      {!teamSession?.aggregatorOnly && teamSession?.capabilities?.localChat !== false && chatOffered && (
        <TtyChat
          lang={lang}
          chatModel={chatModel}
          chatSoundEnabled={chatSoundEnabled}
          chatSoundId={chatSoundId}
          filters={filters}
          setFilters={setFilters}
          onPdfExport={(range) => setPdfDirectExportRange(range)}
          isMobile={isMobile}
          onModelSet={(model) => {
            setChatModel(model)
            fetch('/api/preferences', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chatModel: model }),
            }).catch(() => {})
          }}
        />
      )}

      {/* Footer — dashboard only. The sessions workspace is an application pane that fills the
          window exactly and scrolls inside itself; a marketing footer under a terminal is a strip
          of links nobody can reach without first scrolling a pane that does not scroll. */}
      {!inSessionsWorkspace && (
      <footer style={{
        borderTop: '1px solid var(--border)',
        background: 'var(--bg-surface)',
      }}>
        <div style={{ maxWidth: 1400, margin: '0 auto', padding: '56px 32px 36px' }}>

          {/* Main row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 80, flexWrap: 'wrap', marginBottom: 48 }}>

            {/* Logo only — no text */}
            <div style={{ flexShrink: 0 }}>
              <img
                src='/logo.png'
                alt="agentistics"
                style={{ height: 180, width: 'auto', display: 'block' }}
              />
            </div>

            {/* Description + stats + version — middle */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, flex: '1 1 200px' }}>
              <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.7, margin: 0 }}>
                {lang === 'pt'
                  ? 'Dashboard local de uso do Claude Code. Seus dados ficam no seu computador — sem servidores, sem rastreamento.'
                  : 'Local Claude Code usage dashboard. Your data stays on your machine — no servers, no tracking.'}
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {/* Live stats pill */}
                <div style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '4px 12px', borderRadius: 20,
                  background: 'var(--bg-card)', border: '1px solid var(--border)',
                }}>
                  <div style={{
                    width: 6, height: 6, borderRadius: '50%',
                    background: 'var(--accent-green)', boxShadow: '0 0 8px var(--accent-green)',
                  }} />
                  <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                    {derived.totalSessions.toLocaleString()} {lang === 'pt' ? 'sessões' : 'sessions'}
                    {' · '}
                    {derived.totalMessages.toLocaleString()} {lang === 'pt' ? 'mensagens' : 'messages'}
                  </span>
                </div>
                {/* Version badge */}
                <a
                  href="https://github.com/blpsoares/agentistics/releases/latest"
                  target="_blank" rel="noreferrer"
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 5,
                    padding: '4px 10px', borderRadius: 20,
                    background: 'var(--anthropic-orange-dim)',
                    border: '1px solid var(--anthropic-orange-dim)',
                    fontSize: 11, color: 'var(--anthropic-orange-light)',
                    textDecoration: 'none', fontWeight: 600,
                    transition: 'opacity 0.15s',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.opacity = '0.75')}
                  onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
                >
                  <Zap size={11} />
                  v{version}
                </a>
              </div>
            </div>

            {/* Link columns — right */}
            <div style={{ display: 'flex', gap: 56, flexShrink: 0, flexWrap: 'wrap' }}>
              {([
                {
                  title: lang === 'pt' ? 'Projeto' : 'Project',
                  links: [
                    { href: 'https://github.com/blpsoares/agentistics', label: lang === 'pt' ? 'Repositório' : 'Repository' },
                    { href: 'https://github.com/blpsoares/agentistics/releases', label: 'Releases' },
                    { href: 'https://github.com/blpsoares/agentistics/issues', label: 'Issues' },
                    { href: 'https://github.com/blpsoares/agentistics/pulls', label: 'Pull Requests' },
                    { href: 'https://github.com/blpsoares/agentistics#readme', label: 'README' },
                  ],
                },
                {
                  title: 'Stack',
                  links: [
                    { href: 'https://bun.sh', label: 'Bun' },
                    { href: 'https://react.dev', label: 'React 19' },
                    { href: 'https://www.typescriptlang.org', label: 'TypeScript' },
                    { href: 'https://vitejs.dev', label: 'Vite' },
                    { href: 'https://recharts.org', label: 'Recharts' },
                  ],
                },
                {
                  title: lang === 'pt' ? 'Comunidade' : 'Community',
                  links: [
                    { href: 'https://github.com/blpsoares/agentistics', label: lang === 'pt' ? 'Star no GitHub' : 'Star on GitHub' },
                    { href: 'https://github.com/blpsoares/agentistics/fork', label: 'Fork' },
                    { href: 'https://github.com/blpsoares/agentistics/issues/new', label: lang === 'pt' ? 'Contribuir' : 'Contribute' },
                    { href: 'https://github.com/blpsoares', label: '@blpsoares' },
                  ],
                },
              ] as { title: string; links: { href: string; label: string }[] }[]).map(({ title, links }) => (
                <div key={title} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-primary)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                    {title}
                  </span>
                  {links.map(({ href, label }) => (
                    <a key={href} href={href} target="_blank" rel="noreferrer" style={{
                      fontSize: 13, color: 'var(--text-tertiary)', textDecoration: 'none',
                      transition: 'color 0.15s',
                    }}
                      onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-primary)')}
                      onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-tertiary)')}
                    >
                      {label}
                    </a>
                  ))}
                </div>
              ))}
            </div>
          </div>

          {/* Bottom bar */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            flexWrap: 'wrap', gap: 12, paddingTop: 24,
            borderTop: '1px solid var(--border-subtle)',
          }}>
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
              {lang === 'pt' ? 'Feito com' : 'Made with'}{' '}
              <span style={{ color: 'var(--anthropic-orange)', fontWeight: 700 }}>♥</span>
              {' '}{lang === 'pt' ? 'por' : 'by'}{' '}
              <a href="https://github.com/blpsoares" target="_blank" rel="noreferrer" style={{
                color: 'var(--text-secondary)', textDecoration: 'none', fontWeight: 500, transition: 'color 0.15s',
              }}
                onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-primary)')}
                onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
              >
                Bryan Soares
              </a>
            </span>
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
              {lang === 'pt' ? 'Não afiliado à Anthropic' : 'Not affiliated with Anthropic'}
            </span>
          </div>
        </div>
      </footer>
      )}

      {/* Global notification toasts (auto-dismiss with an exit animation; history in the bell) */}
      <NotificationToasts lang={lang} />

      {/* Accessibility magnifiers — a portal appended to document.body, outside #root. */}
      <MagnifierLayer ctx={appCtx} hasHeaderSlot={headerHostsMagnifier} />

      {/* Mounted once, at the ROOT: stepUpFetch opens this whenever the server demands re-auth,
          and every page can trigger that. It used to live inside SideNav — desktop-only chrome —
          so on a phone the prompter was never registered at all and a protected action just
          failed with the 403 nobody could answer. */}
      <StepUpPrompt lang={lang} />
    </div>
  )
}

function TagCloud({ data, color }: { data: Record<string, number>; color: string }) {
  const entries = Object.entries(data)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)

  if (entries.length === 0) {
    return (
      <div style={{ color: 'var(--text-tertiary)', fontSize: 13, textAlign: 'center', padding: 16 }}>
        No data
      </div>
    )
  }

  const max = Math.max(...entries.map(([, v]) => v), 1)

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {entries.map(([name, count]) => {
        const pct = count / max
        const opacity = 0.3 + pct * 0.7
        return (
          <div
            key={name}
            style={{
              padding: '4px 10px',
              borderRadius: 20,
              background: `${color}18`,
              border: `1px solid ${color}${Math.round(opacity * 40).toString(16).padStart(2, '0')}`,
              fontSize: 11 + pct * 2,
              fontWeight: pct > 0.6 ? 600 : 400,
              color: 'var(--text-secondary)',
              display: 'flex',
              alignItems: 'center',
              gap: 5,
            }}
          >
            {name}
            <span style={{ opacity: 0.5, fontSize: 10 }}>{count}</span>
          </div>
        )
      })}
    </div>
  )
}
