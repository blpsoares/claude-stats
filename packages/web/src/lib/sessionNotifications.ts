/**
 * sessionNotifications.ts — Web Notifications & Sound Effects for Live Sessions
 */

import type { SessionMeta } from '@agentistics/core'
import { sessionLabel } from '@agentistics/core'
import { HARNESS_LABELS } from './harness'

export type SessionActivity = 'working' | 'waiting' | 'waiting-approval' | 'exited'
export type SoundPreset = 'chime' | 'soft' | 'alert' | 'ping'

export interface NotificationSettings {
  enabled: boolean
  askedPrompt: boolean
  events: {
    'waiting-approval': boolean
    'waiting': boolean
    'working': boolean
    'exited': boolean
  }
  /**
   * REQUIRED, because it always exists.
   *
   * It was declared optional while `getNotificationSettings` fills it from the defaults on every
   * read — so the `?` described a state the code cannot produce, and made `keyof` on it resolve to
   * `never`. That is what broke the typecheck on `dev`: three errors in the settings screen, all of
   * them the type disagreeing with its own reader rather than a real absence.
   *
   * A stored blob written before this field existed is still handled — the reader spreads the
   * defaults under whatever it parsed, which is where the guarantee comes from.
   */
  eventSounds: {
    'waiting-approval': SoundPreset
    'waiting': SoundPreset
    'working': SoundPreset
    'exited': SoundPreset
  }
  soundEnabled: boolean
  soundPreset: SoundPreset
  soundVolume: number // 0.0 to 1.0
}

const STORAGE_KEY = 'agentistics-notification-settings'

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: true,
  askedPrompt: false,
  events: {
    'waiting-approval': true,
    'waiting': true,
    'working': false,
    'exited': true,
  },
  eventSounds: {
    'waiting-approval': 'alert',
    'waiting': 'chime',
    'working': 'soft',
    'exited': 'ping',
  },
  soundEnabled: true,
  soundPreset: 'chime',
  soundVolume: 0.8,
}

export function getNotificationSettings(): NotificationSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_NOTIFICATION_SETTINGS
    const parsed = JSON.parse(raw)
    return {
      ...DEFAULT_NOTIFICATION_SETTINGS,
      ...parsed,
      events: {
        ...DEFAULT_NOTIFICATION_SETTINGS.events,
        ...(parsed.events || {}),
      },
      eventSounds: {
        ...DEFAULT_NOTIFICATION_SETTINGS.eventSounds,
        ...(parsed.eventSounds || {}),
      },
    }
  } catch {
    return DEFAULT_NOTIFICATION_SETTINGS
  }
}

export function saveNotificationSettings(settings: NotificationSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    window.dispatchEvent(new CustomEvent('agentistics:notification-settings-changed', { detail: settings }))
  } catch {
    /* ignore quota/disabled */
  }
}

// ----------------------------------------------------------------------------
// Audio Synthesis Engine (Web Audio API)
// ----------------------------------------------------------------------------

let audioCtx: AudioContext | null = null

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (AudioContextClass) {
      audioCtx = new AudioContextClass()
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    void audioCtx.resume().catch(() => {})
  }
  return audioCtx
}

export function playNotificationSound(preset: SoundPreset = 'chime', volume: number = 0.8): void {
  try {
    const ctx = getAudioContext()
    if (!ctx) return

    const now = ctx.currentTime
    const masterGain = ctx.createGain()
    masterGain.gain.setValueAtTime(Math.max(0, Math.min(1, volume)), now)
    masterGain.connect(ctx.destination)

    if (preset === 'chime') {
      // Warm dual-tone chord: C5 (523.25 Hz) -> E5 (659.25 Hz) -> G5 (783.99 Hz)
      const freqs = [523.25, 659.25, 783.99]
      freqs.forEach((freq, idx) => {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.setValueAtTime(freq, now + idx * 0.08)

        gain.gain.setValueAtTime(0.01, now + idx * 0.08)
        gain.gain.exponentialRampToValueAtTime(0.3, now + idx * 0.08 + 0.03)
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.08 + 0.6)

        osc.connect(gain)
        gain.connect(masterGain)

        osc.start(now + idx * 0.08)
        osc.stop(now + idx * 0.08 + 0.65)
      })
    } else if (preset === 'soft') {
      // Gentle double pulse (A4 -> C#5)
      const freqs = [440, 554.37]
      freqs.forEach((freq, idx) => {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.setValueAtTime(freq, now + idx * 0.12)

        gain.gain.setValueAtTime(0.01, now + idx * 0.12)
        gain.gain.exponentialRampToValueAtTime(0.2, now + idx * 0.12 + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.12 + 0.4)

        osc.connect(gain)
        gain.connect(masterGain)

        osc.start(now + idx * 0.12)
        osc.stop(now + idx * 0.12 + 0.45)
      })
    } else if (preset === 'alert') {
      // Triple ascending alert tone (E5 -> G#5 -> B5)
      const freqs = [659.25, 830.61, 987.77]
      freqs.forEach((freq, idx) => {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = 'triangle'
        osc.frequency.setValueAtTime(freq, now + idx * 0.09)

        gain.gain.setValueAtTime(0.01, now + idx * 0.09)
        gain.gain.exponentialRampToValueAtTime(0.35, now + idx * 0.09 + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.09 + 0.4)

        osc.connect(gain)
        gain.connect(masterGain)

        osc.start(now + idx * 0.09)
        osc.stop(now + idx * 0.09 + 0.45)
      })
    } else if (preset === 'ping') {
      // High crystal bell (A5 -> A6)
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(880, now)
      osc.frequency.exponentialRampToValueAtTime(1760, now + 0.05)

      gain.gain.setValueAtTime(0.4, now)
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5)

      osc.connect(gain)
      gain.connect(masterGain)

      osc.start(now)
      osc.stop(now + 0.55)
    }
  } catch {
    /* AudioContext blocked or unsupported */
  }
}

// ----------------------------------------------------------------------------
// Browser Notifications
// ----------------------------------------------------------------------------

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'denied'
  }
  if (Notification.permission === 'granted') {
    return 'granted'
  }
  return await Notification.requestPermission()
}

export function getBrowserNotificationPermission(): NotificationPermission {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'denied'
  }
  return Notification.permission
}

export function triggerSessionNotification(options: {
  title: string
  body: string
  tag?: string
  soundPreset?: SoundPreset
  soundVolume?: number
  soundEnabled?: boolean
}): void {
  const settings = getNotificationSettings()
  if (!settings.enabled) return

  if (settings.soundEnabled && (options.soundEnabled ?? true)) {
    playNotificationSound(options.soundPreset ?? settings.soundPreset, options.soundVolume ?? settings.soundVolume)
  }

  if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(options.title, {
        body: options.body,
        icon: '/favicon.ico',
        tag: options.tag,
      })
    } catch {
      /* ignore notification errors */
    }
  }
}

/**
 * What a notification needs to know about a session in order to NAME it.
 *
 * Widened from `SessionMeta` so the live FLEET can be notified about — which is the whole point of
 * the feature and was, for a while, the one caller that did not exist: the settings screen could
 * send a test notification, the tests exercised the transitions, and nothing in the running app
 * ever called this. Reported as "as notificações web não estão funcionando", and it was exactly
 * that: a feature wired to nothing.
 *
 * A fleet row is not a `SessionMeta` and never will be — it is a live process, not a transcript —
 * so the parameter states the three things actually read here instead of demanding the whole type.
 */
export interface NotifiableSession {
  user_label?: string
  title?: string
  first_prompt?: string
  project_path?: string
  harness?: string
}

export function handleSessionStateTransitions(
  prevActivities: Record<string, SessionActivity>,
  nextActivities: Record<string, SessionActivity>,
  sessionsMap: Map<string, NotifiableSession>,
  lang: 'pt' | 'en' = 'pt'
): void {
  const settings = getNotificationSettings()
  if (!settings.enabled) return

  for (const [id, nextState] of Object.entries(nextActivities)) {
    const prevState = prevActivities[id]
    if (prevState && prevState === nextState) continue

    // Check if this event type is enabled in settings
    if (!settings.events[nextState]) continue

    const session = sessionsMap.get(id)
    const sessionTitle = session ? sessionLabel(session) : ''
    const folderName = session?.project_path ? (session.project_path.split('/').filter(Boolean).pop() || '') : ''
    const sessionSubject = sessionTitle || folderName || id.slice(0, 8)
    const harnessName = session?.harness
      ? ((HARNESS_LABELS as Record<string, string>)[session.harness] || session.harness.toUpperCase())
      : ''
    // The connector is LOCALIZED. It was a hardcoded Portuguese `em` used by both branches, so an
    // English notification read "Session X (CLAUDE CODE em agentistics) is waiting for your
    // response" — one Portuguese word in the middle of an English sentence, on the surface a user
    // reads at a glance while doing something else.
    const inWord = lang === 'pt' ? 'em' : 'in'
    const locationInfo = folderName ? ` (${harnessName} ${inWord} ${folderName})` : harnessName ? ` (${harnessName})` : ''

    let title = ''
    let body = ''

    if (nextState === 'waiting-approval') {
      title = lang === 'pt'
        ? `[Precisa de Aprovação] ${sessionSubject}`
        : `[Needs Approval] ${sessionSubject}`
      body = lang === 'pt'
        ? `A sessão "${sessionSubject}"${locationInfo} está aguardando sua autorização para continuar.`
        : `Session "${sessionSubject}"${locationInfo} is waiting for your authorization to proceed.`
    } else if (nextState === 'waiting') {
      title = lang === 'pt'
        ? `[Aguardando Resposta] ${sessionSubject}`
        : `[Waiting Input] ${sessionSubject}`
      body = lang === 'pt'
        ? `A sessão "${sessionSubject}"${locationInfo} concluiu o turno e aguarda sua resposta.`
        : `Session "${sessionSubject}"${locationInfo} finished its turn and is waiting for your response.`
    } else if (nextState === 'working') {
      title = lang === 'pt'
        ? `[Em Andamento] ${sessionSubject}`
        : `[Working] ${sessionSubject}`
      body = lang === 'pt'
        ? `A sessão "${sessionSubject}"${locationInfo} iniciou o processamento.`
        : `Session "${sessionSubject}"${locationInfo} started working.`
    } else if (nextState === 'exited') {
      title = lang === 'pt'
        ? `[Sessão Encerrada] ${sessionSubject}`
        : `[Session Closed] ${sessionSubject}`
      body = lang === 'pt'
        ? `A sessão "${sessionSubject}"${locationInfo} foi finalizada.`
        : `Session "${sessionSubject}"${locationInfo} was closed.`
    }

    if (title && body) {
      triggerSessionNotification({
        title,
        body,
        tag: `session-${id}`,
      })
    }
  }
}


/**
 * The live fleet's transitions, as notifications. THE CALLER THAT WAS MISSING.
 *
 * Two rules it must keep, and they are the same two the cockpit's bell and the VS Code extension
 * keep — stated here because this is a third implementation of the same idea and they have to agree:
 *
 * - IT RINGS ON THE TRANSITION, NEVER ON THE LEVEL. A session sitting in `waiting` is the normal
 *   end of every turn; notifying on the state rather than the change is a notification per poll.
 * - THE FIRST SNAPSHOT ANNOUNCES NOTHING. Opening a machine with nine blocked sessions would
 *   otherwise greet the reader with nine toasts about things that happened while they were away —
 *   the header's own counter is what reports a standing situation.
 *
 * `states` is exported for the caller to hold: it keeps the previous snapshot, and holding it here
 * would make the module remember something across a page it no longer belongs to.
 */
export function fleetActivityStates(
  rows: readonly { id: string; state: string }[],
): Record<string, SessionActivity> {
  const out: Record<string, SessionActivity> = {}
  for (const r of rows) {
    // Only the four this feature has words for. `lost`, `closed` and `unknown` are not events that
    // happened to a person — they are what a row IS — and inventing a sentence for them would put
    // "your session is unknown" on someone's desktop.
    if (r.state === 'working' || r.state === 'waiting' || r.state === 'waiting-approval' || r.state === 'exited') {
      out[r.id] = r.state
    }
  }
  return out
}

export function notifyFleetTransitions(
  prev: Record<string, SessionActivity> | null,
  rows: readonly { id: string; state: string; title?: string; cwd?: string; harness?: string }[],
  lang: 'pt' | 'en',
): Record<string, SessionActivity> {
  const next = fleetActivityStates(rows)
  // `null` is the first snapshot — see the rule above. It is deliberately distinct from `{}`, which
  // is a machine that genuinely had no sessions a moment ago and now has one.
  if (prev === null) return next
  const map = new Map<string, NotifiableSession>()
  for (const r of rows) {
    map.set(r.id, {
      ...(r.title ? { title: r.title } : {}),
      ...(r.cwd ? { project_path: r.cwd } : {}),
      ...(r.harness ? { harness: r.harness } : {}),
    })
  }
  handleSessionStateTransitions(prev, next, map, lang)
  return next
}
