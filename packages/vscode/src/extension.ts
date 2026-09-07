/**
 * extension.ts — activation, and the wiring between the pieces.
 *
 * This extension is a CLIENT of the local `agentop server` and nothing else. It never reads
 * `~/.agentistics`, never talks to tmux, and never imports the session manager: a second process
 * read-modify-writing `managed-sessions.json` beside the running server is the registry race
 * `registry.ts` documents — a record added by a short-lived process has been observed erased by a
 * longer-lived one, leaving a user sitting in a session no verb could name.
 */

import * as vscode from 'vscode'
import { AgentopClient } from './api'
import { resolveEndpoints, type Endpoints } from './config'
import { resolveLang, strings, type Lang } from './i18n'
import { disposePanels, openFleetPanel, openSessionPanel, retitleSessionPanel } from './panels'
import { SessionsHub, SessionsViewProvider, themeKind } from './sessions'
import { StatusBar } from './status-bar'
import { attachInTerminal, forgetClosedTerminal, startServerInTerminal } from './terminal'

export function activate(context: vscode.ExtensionContext): void {
  let endpoints: Endpoints = read().endpoints
  let lang: Lang = read().lang
  let words = strings(lang)
  const statusBar = new StatusBar(words)

  function read(): { endpoints: Endpoints; lang: Lang } {
    const config = vscode.workspace.getConfiguration('agentistics')
    return {
      endpoints: resolveEndpoints({ apiUrl: config.get<string>('apiUrl') }),
      lang: resolveLang(config.get<string>('language'), vscode.env.language),
    }
  }

  function setting<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration('agentistics').get<T>(key) ?? fallback
  }

  const hub = new SessionsHub(context, {
    client: () => new AgentopClient(endpoints.api, lang),
    api: () => endpoints.api,
    strings: () => words,
    lang: () => lang,
    notifyOnAttention: () => setting('notifyOnAttention', true),
    onAttention: count => statusBar.setAttention(count),
    openTab: id => void openSessionTab(id),
  })

  /**
   * Open one session as its own tab, titled with what the session is CALLED.
   *
   * The title is read from the fleet rather than from the id: a tab strip full of `3f5f21a8b0c1`
   * is a tab strip nobody can use, which is the whole reason several of these can be open at once.
   * An id that is not in the fleet still opens — the panel itself says the session is gone, which
   * is a better answer than a command that appears to do nothing.
   */
  async function openSessionTab(id: string): Promise<void> {
    const { payload } = await new AgentopClient(endpoints.api, lang).fleet()
    const row = payload?.sessions.find(r => r.id === id)
    const title = row ? `${row.title} · agentop` : `agentop · ${id.slice(0, 8)}`
    openSessionPanel(hub, id, title)
    if (row) retitleSessionPanel(id, title)
  }

  // A setting that could not be read is REPORTED, not silently replaced: a panel quietly reading a
  // machine the user did not name is worse than a complaint they can act on.
  if (endpoints.invalid) void vscode.window.showWarningMessage(invalidNotice(lang, endpoints.invalid))

  context.subscriptions.push(
    hub,
    statusBar,
    { dispose: disposePanels },
    vscode.window.registerWebviewViewProvider(
      SessionsViewProvider.viewType,
      new SessionsViewProvider(hub),
      // The panel keeps its search text, its open session and its half-typed line while it is
      // hidden behind another view — losing those on every switch is what makes a sidebar unusable.
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.window.onDidCloseTerminal(forgetClosedTerminal),
    // The terminal's palette follows the editor's theme, so a light window does not get a black
    // screen with the dashboard's dark ANSI colours on it.
    vscode.window.onDidChangeActiveColorTheme(() => hub.setTheme(themeKind())),
    vscode.commands.registerCommand('agentistics.openSessions', () => {
      openFleetPanel(hub, `Agentistics — ${words.title}`)
    }),
    vscode.commands.registerCommand('agentistics.refresh', () => hub.refresh()),
    vscode.commands.registerCommand('agentistics.startServer', () => startServerInTerminal(words)),
    vscode.commands.registerCommand('agentistics.focusSessions', () =>
      vscode.commands.executeCommand('agentistics.sessions.focus')),
    vscode.commands.registerCommand('agentistics.newSession', async () => {
      await vscode.commands.executeCommand('agentistics.sessions.focus')
      // "Here" is the open workspace folder — the one directory the editor knows and the server
      // cannot guess. With several folders open there is no single "here", so the wizard opens on
      // its own search rather than picking one of them for the user.
      const folders = vscode.workspace.workspaceFolders ?? []
      hub.openWizard(folders.length === 1 ? folders[0]!.uri.fsPath : undefined)
    }),
    vscode.commands.registerCommand('agentistics.openSession', () => pickSession('open')),
    vscode.commands.registerCommand('agentistics.attachSession', () => pickSession('attach')),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('agentistics')) return
      const next = read()
      endpoints = next.endpoints
      lang = next.lang
      words = strings(lang)
      statusBar.setStrings(words)
      statusBar.show(setting('statusBar', true))
      restartTodayTimer()
      void hub.refresh()
    }),
  )

  /**
   * The palette route in, for the keyboard-first user who never opens the sidebar.
   *
   * It asks the SERVER which rows exist and what each one is called rather than composing a list
   * here: the labels, the state words and which rows can be attached to at all are decisions that
   * were already made, in the cockpit's own wording.
   */
  async function pickSession(then: 'open' | 'attach'): Promise<void> {
    const client = new AgentopClient(endpoints.api, lang)
    const { link, payload } = await client.fleet()
    if (link.state !== 'ok' || !payload) {
      // Three facts, three sentences — see `LinkState`. Collapsing them into one generic "no
      // answer" told someone whose server was merely slow to go start one that was already running.
      const message = link.state === 'slow'
        ? words.linkSlow
        : link.state === 'refused'
          ? words.linkRefused
          : words.networkError
      void vscode.window.showWarningMessage(message ?? 'No answer.')
      return
    }
    const rows = then === 'attach' ? payload.sessions.filter(r => r.actionable) : payload.sessions
    if (rows.length === 0) {
      void vscode.window.showInformationMessage(words.emptyNone ?? 'Nothing to open.')
      return
    }
    const picked = await vscode.window.showQuickPick(
      rows.map(row => ({
        label: row.title,
        description: row.stateLabel,
        detail: `${row.harness} · ${row.cwd}`,
        id: row.id,
      })),
      { placeHolder: then === 'attach' ? words.attach : words.openTab },
    )
    if (!picked) return
    if (then === 'open') {
      await openSessionTab(picked.id)
      return
    }
    const ticket = await client.attach(picked.id)
    if (!ticket) {
      void vscode.window.showWarningMessage(words.attachUnavailable ?? 'Cannot attach.')
      return
    }
    attachInTerminal(picked.id, ticket, words)
  }

  // ---------------------------------------------------------------------------
  // today's totals — a separate, much slower timer. See status-bar.ts.

  let todayTimer: ReturnType<typeof setInterval> | undefined

  async function readToday(): Promise<void> {
    if (!setting('statusBar', true)) return
    const client = new AgentopClient(endpoints.api, lang)
    const currency = setting<string>('currency', 'usd') === 'brl' ? 'BRL' : 'USD'
    // The rate is only asked for when it is going to be used. It rides the same slow timer as the
    // totals: an exchange rate that moved during the day does not change what today cost enough to
    // be worth a request of its own.
    const rate = currency === 'BRL' ? await client.brlRate() : null
    statusBar.setCurrency(currency, rate)
    statusBar.setTotals(await client.today(new Date()))
  }

  function restartTodayTimer(): void {
    if (todayTimer) clearInterval(todayTimer)
    const seconds = Math.max(15, setting('statusBarRefreshSeconds', 300))
    void readToday()
    todayTimer = setInterval(() => void readToday(), seconds * 1_000)
  }

  context.subscriptions.push({ dispose: () => { if (todayTimer) clearInterval(todayTimer) } })
  statusBar.show(setting('statusBar', true))
  restartTodayTimer()
}

export function deactivate(): void {
  /* Everything is registered in `context.subscriptions` and disposed by VS Code. */
}

function invalidNotice(lang: Lang, value: string): string {
  return lang === 'pt'
    ? `Agentistics: não consegui ler o endereço “${value}”. Usando o padrão.`
    : `Agentistics: could not read the address “${value}”. Falling back to the default.`
}
