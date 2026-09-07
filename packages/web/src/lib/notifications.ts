import { useSyncExternalStore } from 'react'

export type NotificationType = 'error' | 'warning' | 'info' | 'success'

export interface AppNotification {
  id: string
  type: NotificationType
  /** Localization code — when set, the title/message are resolved at render time
   *  from NOTIFICATION_TEXT so they follow the language toggle. */
  code?: string
  /** Interpolation values for the localized copy (e.g. an HTTP status). */
  meta?: Record<string, unknown>
  /** Raw pre-localized strings — used as a fallback when there is no `code`. */
  title?: string
  message?: string
  ts: number
  read: boolean
}

type Localized = { title: string; message?: string }

/** Localized copy for server- and client-emitted notification codes. Resolved at
 *  render time by resolveNotification so switching the language re-translates. */
export const NOTIFICATION_TEXT: Record<string, { pt: Localized; en: Localized }> = {
  // The five member.* codes below name the central they are about via `{central}` (the
  // connection's label, else its endpoint host — never a token). With several centrals connected,
  // an unattributed "can't reach the central" is unactionable: the bell showed two byte-identical
  // rows while only one central was down. `meta.central` is missing on rows persisted by an older
  // build, so the placeholder falls back to a generic noun — see resolveNotification.
  // Raised when an owner recovers their password with the second factor. It is a WARNING, not a
  // success: the whole point of showing it to every other owner is that this is what an account
  // takeover would look like, and the only chance anyone has to notice it.
  // Raised for a MANAGER, about somebody else's account — it carries no `meta` at all, which is
  // why `notifications-store.ts` keys it by SUBJECT: two people asking at once must not collapse
  // into one row that shows only the second one.
  'iam.reset_requested': {
    pt: {
      title: 'Pedido de redefinição de senha',
      message: 'Alguém pediu para redefinir a senha de uma conta que você administra. Confirme com a pessoa antes de aprovar.',
    },
    en: {
      title: 'Password reset requested',
      message: 'Someone asked to reset the password of an account you administer. Confirm with them before approving.',
    },
  },
  'iam.password_recovered': {
    pt: {
      title: 'Senha de owner redefinida',
      message: 'A conta {email} redefiniu a senha pelo segundo fator ({factor}). Se não foi você, revogue o acesso e troque a senha agora.',
    },
    en: {
      title: 'Owner password was reset',
      message: 'The account {email} reset its password using its second factor ({factor}). If this was not you, revoke access and change the password now.',
    },
  },
  'member.auth_rejected': {
    pt: { title: 'Central rejeitou esta máquina', message: 'Não autorizado por {central} — o token pode ser inválido ou revogado. Gere um novo no Team Manager dessa central.' },
    en: { title: 'Central rejected this machine', message: 'Unauthorized from {central} — the token may be invalid or revoked. Mint a new one in that central’s Team Manager.' },
  },
  'member.unreachable': {
    pt: { title: 'Sem conexão com a central', message: 'Não foi possível alcançar {central}; tentando novamente em segundo plano.' },
    en: { title: 'Can’t reach the central', message: 'Couldn’t reach {central}; retrying in the background.' },
  },
  'member.reconnected': {
    pt: { title: 'Conectado à central', message: 'Os envios para {central} voltaram a funcionar.' },
    en: { title: 'Connected to the central', message: 'Pushes to {central} are working again.' },
  },
  // The backup's own toasts. A backup can take minutes and, on a schedule, nobody pressed
  // anything to start it — so a machine that is busy backing up would otherwise look exactly like
  // one that is idle, and a FAILED backup exactly like one that never ran. That last pair is the
  // dangerous one: it is the case where the person believes they are covered.
  'backup.started': {
    pt: { title: 'Backup em andamento', message: 'Salvando {layers}. Você pode continuar usando a máquina.' },
    en: { title: 'Backup running', message: 'Saving {layers}. You can keep using the machine.' },
  },
  'backup.done': {
    pt: { title: 'Backup concluído', message: '{layers} · {size}.' },
    en: { title: 'Backup complete', message: '{layers} · {size}.' },
  },
  // A clean run and a partial one are different facts, so they are different codes — one sentence
  // covering both would let a backup quietly stop carrying something.
  'backup.done.skipped': {
    pt: { title: 'Backup concluído, com ressalvas', message: '{layers} · {size}. {skipped} caminho(s) não puderam ser lidos e ficaram de fora — veja o log.' },
    en: { title: 'Backup complete, with caveats', message: '{layers} · {size}. {skipped} path(s) could not be read and were left out — see the log.' },
  },
  'backup.failed': {
    pt: { title: 'Backup FALHOU', message: 'Nada foi gravado. Motivo: {reason}' },
    en: { title: 'Backup FAILED', message: 'Nothing was written. Reason: {reason}' },
  },
  'backup.uploaded': {
    pt: { title: 'Backup versionado no GitHub', message: 'Release {tag} — conferido byte a byte.' },
    en: { title: 'Backup versioned on GitHub', message: 'Release {tag} — confirmed byte for byte.' },
  },
  // A WARNING, deliberately, not an error: the archive was written and is on disk and restores.
  // Calling this a failed backup would tell someone they have nothing when they have everything
  // except the copy on GitHub.
  'backup.upload_failed': {
    pt: { title: 'Backup salvo, envio falhou', message: 'O arquivo está no disco desta máquina e restaura normalmente — só a cópia no GitHub não foi feita. Motivo: {reason}' },
    en: { title: 'Backup saved, upload failed', message: 'The archive is on this machine and restores normally — only the GitHub copy was not made. Reason: {reason}' },
  },
  'member.removed': {
    pt: { title: 'Removido da central', message: 'O acesso desta máquina a {central} foi revogado. A conexão foi removida — gere um novo token nessa central para reconectar.' },
    en: { title: 'Removed from the central', message: 'Access to {central} was revoked for this machine. The connection was removed — mint a new token there to reconnect.' },
  },
  // Raised once per retroactive removal (never once per cycle — the uploader guards the
  // transition), so a rules change that takes several cycles to land is one "removing" toast and
  // one "done", not a stream of them.
  'member.rules_proposed': {
    pt: { title: 'Outra máquina sua restringiu repositórios', message: '{name} enviou {count} proposta(s) de regra para {central}. Nada mudou aqui — abra a conexão para decidir.' },
    en: { title: 'Another of your machines restricted repositories', message: '{name} sent {count} rule proposal(s) for {central}. Nothing changed here — open the connection to decide.' },
  },
  // Same failure mode COPY.peersTitle had: "will receive your rules" reads as "will apply them".
  // A newly pinned machine is only TOLD when these rules change; whoever owns it decides.
  'member.peer_pinned': {
    pt: { title: 'Nova máquina será avisada das suas regras', message: '{count} nova(s) máquina(s) da sua conta em {central} passará(ão) a ser avisada(s) quando você mudar suas regras de compartilhamento — nada é aplicado lá: {name}. Se você não reconhece, confira o código nas configurações da conexão.' },
    en: { title: 'A new machine will be told about your rules', message: '{count} new machine(s) of your account on {central} will now be told when you change your sharing rules — nothing is applied there: {name}. If you do not recognise it, check the code in the connection settings.' },
  },
  'member.peer_key_changed': {
    pt: { title: 'A chave de uma máquina mudou', message: 'A chave publicada para {name} em {central} não é a que esta máquina fixou. Nada foi descriptografado. Compare o código mostrado para ela nas duas máquinas.' },
    en: { title: "A machine's key changed", message: 'The key published for {name} on {central} is not the one this machine pinned. Nothing was decrypted. Compare the code shown for it on both machines.' },
  },
  'member.resync_started': {
    pt: { title: 'Removendo dados da central', message: 'Removendo {count} sessão(ões) de {central} conforme as novas regras de repositório.' },
    en: { title: 'Removing data from the central', message: 'Removing {count} session(s) from {central} to match the new repository rules.' },
  },
  'member.resync_done': {
    pt: { title: 'Regras aplicadas', message: '{count} sessão(ões) removida(s) de {central}.' },
    en: { title: 'Rules applied', message: '{count} session(s) removed from {central}.' },
  },
  'member.disconnected': {
    pt: { title: 'Desconectado da central', message: 'A conexão com {central} foi removida.' },
    en: { title: 'Disconnected from the central', message: 'The connection to {central} was removed.' },
  },
  'central.connect_failed': {
    pt: { title: 'Falha ao conectar na central', message: 'Não foi possível conectar na central. Verifique o endereço e o token.' },
    en: { title: 'Failed to connect to the central', message: 'Couldn’t connect to the central. Check the endpoint and token.' },
  },
  'central.token_unrecognized': {
    pt: { title: 'Token não reconhecido', message: 'A central não reconheceu este token. Gere um token para esta máquina no Team Manager da central.' },
    en: { title: 'Token not recognized', message: "The central didn't recognize this token. Mint a token for this machine in the central's Team Manager." },
  },
  'central.member_connected': {
    pt: { title: 'Máquina conectada', message: '{user} conectou à central.' },
    en: { title: 'Machine connected', message: '{user} connected to the central.' },
  },
  'machine.renamed': {
    pt: { title: 'Máquina renomeada', message: 'Esta máquina foi renomeada para "{name}" por {actor}.' },
    en: { title: 'Machine renamed', message: 'This machine was renamed to "{name}" by {actor}.' },
  },
  'machine.reassigned': {
    pt: { title: 'Máquina reatribuída', message: 'Esta máquina agora pertence a {account} (alterado por {actor}).' },
    en: { title: 'Machine reassigned', message: 'This machine now belongs to {account} (changed by {actor}).' },
  },
  'machine.session_acted': {
    // Says WHICH verb: "somebody acted on a session" is unfalsifiable reassurance, while "killed"
    // and "renamed" are things the person at this keyboard can check.
    pt: { title: 'Sessão alterada pela central', message: 'A central executou "{verb}" numa sessão desta máquina.' },
    en: { title: 'Session acted on from the central', message: 'The central performed "{verb}" on a session of this machine.' },
  },
  'app.update_available': {
    pt: { title: 'Atualização disponível', message: 'Uma nova versão do agentistics ({version}) está disponível.' },
    en: { title: 'Update available', message: 'A new version of agentistics ({version}) is available.' },
  },
}

/** Resolve a notification to display strings in the CURRENT language. Localizes by
 *  `code` (interpolating `meta`, e.g. an HTTP status) and falls back to the raw
 *  title/message baked in at creation time. */
/** The codes whose `{name}` is another machine of this account — see the fallback below. */
const PEER_CODES = new Set(['member.rules_proposed', 'member.peer_pinned', 'member.peer_key_changed'])

export function resolveNotification(n: AppNotification, lang: 'pt' | 'en'): Localized {
  const loc = n.code ? NOTIFICATION_TEXT[n.code]?.[lang] : undefined
  // A CODE WITH NO TEXT MUST NOT RENDER AS A BLANK CARD.
  //
  // Only `code` + `meta` are stored, so a code this table has not met resolves to empty strings —
  // and both surfaces then draw a card with an icon, a timestamp, a dismiss button and NOTHING to
  // read. It is the worst possible failure for a notification: the product is telling the user
  // something happened and refusing to say what, and it is indistinguishable from a rendering bug.
  //
  // `notificationCoverage.test.ts` makes an unmapped code fail the build, so this should never
  // fire. It exists anyway because that test can only see the codes the server emits TODAY, and a
  // notification stored by a newer build and read by an older one is the case no lint can reach.
  // The code itself is a poor title and an honest one.
  const fallbackTitle = n.code
    ? (lang === 'pt' ? `Evento: ${n.code}` : `Event: ${n.code}`)
    : ''
  const title = loc?.title ?? n.title ?? fallbackTitle
  let message = loc?.message ?? n.message
  // Interpolate {user} from meta (e.g. "{user} connected to the central").
  if (message && n.meta?.user) {
    message = message.replace('{user}', String(n.meta.user))
  }
  // Interpolate {version} from meta (e.g. "A new version ({version}) is available").
  if (message && n.meta?.version) {
    message = message.replace('{version}', `v${String(n.meta.version).replace(/^v/, '')}`)
  }
  // Interpolate {central} from meta — the connection's label or endpoint host, set by every
  // per-connection notification the uploader and the WS client raise (`meta.central`). Rows
  // persisted before this field existed have no `central`, so the placeholder degrades to a
  // generic noun instead of rendering a literal "{central}" in the bell's history.
  if (message && message.includes('{central}')) {
    const central = String(n.meta?.central ?? '').trim()
    message = message.replace(/\{central\}/g, central || (lang === 'pt' ? 'a central' : 'the central'))
  }
  // Interpolate {count} from meta (the retroactive-removal notifications).
  if (message && n.meta?.count !== undefined) {
    message = message.replace('{count}', String(n.meta.count))
  }
  // Interpolate {name}/{actor} from meta (e.g. machine.renamed).
  if (message && n.meta?.name) message = message.replace('{name}', String(n.meta.name))
  // The three sealed-envelope codes name another machine of this account, and that machine may
  // have no name at all on the central. It is NEVER filled in with the machine id (sha256 of a
  // token) and never left as a raw placeholder — it is said in words.
  if (message && message.includes('{name}') && PEER_CODES.has(n.code ?? '')) {
    message = message.replace(/\{name\}/g, lang === 'pt' ? 'uma máquina sem nome' : 'an unnamed machine')
  }
  if (message && n.meta?.actor) message = message.replace('{actor}', String(n.meta.actor))
  // machine.reassigned carries the new owning account (empty when ownership was cleared).
  if (message && n.meta?.account !== undefined) {
    const acct = String(n.meta.account || '')
    message = message.replace('{account}', acct || (lang === 'pt' ? 'nenhuma conta' : 'no account'))
  }
  // Append the HTTP status to the auth-rejected message when the central provided one.
  if (n.code === 'member.auth_rejected' && n.meta?.status && message) {
    message = `${message} (HTTP ${n.meta.status})`
  }

  // EVERY remaining {placeholder}, from `meta` under the same name.
  //
  // The cases above are the ones that TRANSFORM their value — a `v` prefix, a fallback noun when
  // the fact is missing, a whole different sentence for the peer codes — and they run first so
  // this never overrides them. What was missing was the ordinary case, and its absence was a bug
  // factory: interpolation was a hand-written list, so every new code with a new placeholder
  // shipped showing its own braces. Seen on screen as "Salvando {layers}." and "Motivo: {reason}".
  //
  // A placeholder with NO value in `meta` is LEFT ALONE rather than replaced: printing the word
  // `undefined` inside a sentence a person reads is worse than a visible brace, because it looks
  // like the value.
  if (message && n.meta) {
    const meta = n.meta
    message = message.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (whole, key: string) => {
      const v = meta[key]
      return v === undefined || v === null ? whole : String(v)
    })
  }
  return { title, message }
}

/**
 * Where a notification LEADS, or `null` when it is only news.
 *
 * A notification about a decision the user has to make must reach that decision in one click —
 * "another of your machines restricted repositories, open the connection to decide" is useless if
 * the user then has to find the connection themselves. The three connection-scoped codes carry
 * `meta.connectionId` already; the route opens that card with its notices modal up.
 *
 * PURE and total: an unknown code, or a known one that predates `connectionId`, leads nowhere
 * rather than to a card that does not exist.
 */
export function notificationLink(n: Pick<AppNotification, 'code' | 'meta'>): string | null {
  const NOTICE_CODES = new Set(['member.rules_proposed', 'member.peer_key_changed', 'member.peer_pinned'])
  if (!n.code || !NOTICE_CODES.has(n.code)) return null
  const id = String(n.meta?.connectionId ?? '').trim()
  if (!id) return null
  return `/settings/connection?conn=${encodeURIComponent(id)}&notices=1`
}

/**
 * PERSISTENCE — the server is the source of truth.
 *
 * The history lives on the machine (or on the central) at ~/.agentistics/notifications*.json and
 * is reached over /api/notifications. It is deliberately NOT localStorage: the bell is the user's
 * inbox, and opening the dashboard from a phone has to show the same notifications the desktop
 * shows — a per-browser store would always start empty there. Whichever instance serves the page
 * owns its own history, so a central's bell and a machine's bell never mix.
 *
 * The in-memory list below is a CACHE of the server's list, replaced by every response. Ids are
 * minted by the server, which is what lets a phone dismiss the same row the desktop is showing.
 * Only `code` + `meta` are ever stored — never the rendered text — so `resolveNotification` keeps
 * localizing at render time and the language toggle still re-translates old notifications.
 */
const API = '/api/notifications'

// External store — a single immutable array reference that changes on every mutation,
// so useSyncExternalStore re-renders subscribers without extra bookkeeping.
let items: AppNotification[] = []
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

/** Replace the cache with the server's list. Every endpoint answers with the full list, so one
 *  code path covers add / read / dismiss / clear and two devices converge on the same state. */
function apply(next: unknown): void {
  if (!Array.isArray(next)) return
  const valid = next.filter((x): x is AppNotification =>
    !!x && typeof x === 'object'
    && typeof (x as AppNotification).id === 'string'
    && typeof (x as AppNotification).ts === 'number'
    && typeof (x as AppNotification).type === 'string')
  items = valid.map(x => ({ ...x, read: x.read === true }))
  emit()
}

async function call(init?: RequestInit, query = ''): Promise<void> {
  try {
    const r = await fetch(`${API}${query}`, init)
    if (!r.ok) return
    apply(await r.json())
  } catch {
    // Server unreachable (offline, restarting). The cache keeps rendering what it has; the next
    // refresh reconciles. Never throws — a failed bell must not break the page.
  }
}

/** Load the history from the server. Called on mount and whenever an SSE notification arrives. */
export async function refreshNotifications(): Promise<void> {
  await call()
}

/**
 * Add a notification. Client-originated only (an update detected in the browser, a failed central
 * connection): notifications the SERVER raises are already persisted by broadcastNotification, and
 * the client just refreshes when the SSE event lands — otherwise every open tab would re-report
 * the same event.
 *
 * De-dupe happens server-side against the whole history, read items included, so the same event
 * re-reported on every page load updates one row instead of stacking copies.
 *
 * Pass a `code` for render-time i18n, or raw title/message for already-localized copy.
 */
export function pushNotification(n: {
  type: NotificationType
  code?: string
  meta?: Record<string, unknown>
  title?: string
  message?: string
}): void {
  void call({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(n),
  })
}

export function markAllRead(): void {
  if (!items.some(x => !x.read)) return
  // Optimistic: the badge clears the instant the panel opens, then the server response confirms.
  items = items.map(x => (x.read ? x : { ...x, read: true }))
  emit()
  void call({ method: 'PATCH' })
}

/** Remove ONE notification. */
export function dismissNotification(id: string): void {
  const next = items.filter(x => x.id !== id)
  if (next.length !== items.length) { items = next; emit() }
  void call({ method: 'DELETE' }, `?id=${encodeURIComponent(id)}`)
}

/** Remove every notification. */
export function clearNotifications(): void {
  if (items.length > 0) { items = []; emit() }
  void call({ method: 'DELETE' })
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Non-reactive snapshot of the cached list (newest first) — for tests and for callers outside
 *  React. Components must use `useNotifications()` so they re-render on change. */
export function readNotifications(): AppNotification[] {
  return items
}

/** Reactive list of notifications (newest first). */
export function useNotifications(): AppNotification[] {
  return useSyncExternalStore(subscribe, () => items, () => items)
}
