/**
 * sessions.ts — the fleet, one poll, any number of surfaces.
 *
 * A surface is a webview: the docked sidebar view, or an editor tab pinned to one session. They are
 * the SAME document driven by the SAME poll — two panels with a timer each would double the traffic
 * and, worse, could show two different fleets a second apart, with the one the user is not looking
 * at being the correct one.
 *
 * The hub is also the only thing that acts. A webview posts an intent; the hub calls the server,
 * takes the server's own sentence back, and broadcasts it — so an action taken in the sidebar
 * reports itself in the tab as well.
 */

import * as vscode from 'vscode'
import { AgentopClient } from './api'
import { readAttention, type AttentionMemory } from './attention'
import { fill } from './i18n'
import {
  DEFAULT_ARRANGEMENT,
  type Arrangement, type FleetPayload, type HostMessage, type LinkStatus, type Route,
  type ViewMessage,
} from './protocol'
import { InputSockets } from './input'
import { TerminalStreams, type TerminalEvent } from './streams'
import { attachInTerminal, startServerInTerminal } from './terminal'
import { sessionsHtml } from './webview/html'

/** The cockpit polls at 5s; matching it keeps the two in step on the same machine. */
const POLL_MS = 5_000

const EMPTY: FleetPayload = { sessions: [], attention: 0, tasks: [] }

/** Where the pins live. Global rather than per-workspace: a session is not a property of a folder. */
const PINNED_KEY = 'agentistics.pinnedSessions'

/**
 * Where the ARRANGEMENT lives.
 *
 * Held by the host and shared by every surface, the way the cockpit persists `sessionView`: two
 * panels showing the same fleet grouped two different ways is two answers to one question, and the
 * one you are not looking at is always the one that is right.
 */
const ARRANGE_KEY = 'agentistics.arrangement'

export interface HubDeps {
  client(): AgentopClient
  api(): string
  strings(): Record<string, string>
  lang(): 'en' | 'pt'
  notifyOnAttention(): boolean
  onAttention(count: number): void
  /** Open one session as its own editor tab. Wired in `extension.ts`, which owns panel creation. */
  openTab(id: string): void
}

interface Surface {
  webview: vscode.Webview
  route: Route
  /** True for an editor tab: it belongs to one session and has no list to go back to. */
  pinned: boolean
  /** This surface's stream listener, so its watches can all be dropped when it closes. */
  onTerminal: (event: TerminalEvent) => void
}

export function themeKind(): 'dark' | 'light' {
  const kind = vscode.window.activeColorTheme.kind
  // High contrast light is a LIGHT theme; the two high-contrast kinds differ and collapsing both
  // into dark puts black text on black for anyone using the light one.
  return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight
    ? 'light'
    : 'dark'
}

export class SessionsHub implements vscode.Disposable {
  private readonly surfaces = new Map<vscode.Webview, Surface>()
  private readonly streams: TerminalStreams
  private readonly inputs: InputSockets
  private timer: ReturnType<typeof setInterval> | undefined
  private memory: AttentionMemory = null
  private link: LinkStatus = { state: 'down', url: '' }
  private fleet: FleetPayload = EMPTY

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly deps: HubDeps,
  ) {
    this.streams = new TerminalStreams(() => this.deps.api())
    this.inputs = new InputSockets(() => this.deps.api())
  }

  /** Wire a webview up: its HTML, its route, its messages, and its share of the current state. */
  register(webview: vscode.Webview, route: Route, pinned: boolean): void {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    }
    webview.html = sessionsHtml({
      cspSource: webview.cspSource,
      nonce: nonce(),
      scriptUri: webview.asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'),
      ).toString(),
      styleUri: webview.asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, 'media', 'style.css'),
      ).toString(),
    })
    const surface: Surface = {
      webview,
      route,
      pinned,
      onTerminal: event => {
        void webview.postMessage({
          type: 'terminal',
          id: event.id,
          event: event.event,
          data: event.data,
        } satisfies HostMessage)
      },
    }
    this.surfaces.set(webview, surface)
    webview.onDidReceiveMessage((msg: ViewMessage) => void this.handle(surface, msg))
    this.start()
  }

  unregister(webview: vscode.Webview): void {
    const surface = this.surfaces.get(webview)
    // Every stream this surface was watching goes with it. Left registered, the host would keep a
    // capture loop alive on the server for a panel that no longer exists.
    if (surface) this.streams.unwatchAll(surface.onTerminal)
    this.surfaces.delete(webview)
    if (this.surfaces.size === 0) this.stop()
  }

  /** The editor's theme changed — the terminal's palette follows it. */
  setTheme(theme: 'dark' | 'light'): void {
    this.broadcast({ type: 'theme', theme })
  }

  /**
   * Poll only while something is looking.
   *
   * A background timer running with every panel closed would keep capturing each live session's
   * screen for a window nobody has open — the cheapest possible way to spend someone's battery.
   */
  private start(): void {
    if (this.timer) return
    void this.poll()
    this.timer = setInterval(() => void this.poll(), POLL_MS)
  }

  private stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  async refresh(): Promise<void> {
    await this.poll()
  }

  /** Open the wizard on every surface that has a list to open it on. */
  openWizard(cwd?: string): void {
    this.broadcast({ type: 'openWizard', ...(cwd ? { cwd } : {}) })
  }

  private async poll(): Promise<void> {
    const { link, payload } = await this.deps.client().fleet(this.arrangement())
    this.link = link
    // A failed poll keeps the PREVIOUS fleet, exactly as the cockpit's poller does: the last known
    // truth beats a confident empty list, and the banner above it already says the link is down.
    if (payload) this.fleet = payload

    const update = readAttention(this.memory, this.fleet.sessions)
    this.memory = update.memory
    this.deps.onAttention(update.count)
    if (this.deps.notifyOnAttention()) {
      for (const row of update.announce) this.announce(row.id, row.title)
    }
    this.broadcast(this.stateMessage())
  }

  private stateMessage(): HostMessage {
    return {
      type: 'state',
      link: this.link,
      fleet: this.fleet,
      strings: this.deps.strings(),
      lang: this.deps.lang(),
      pinned: this.pinned(),
      arrangement: this.arrangement(),
    }
  }

  private arrangement(): Arrangement {
    return { ...DEFAULT_ARRANGEMENT, ...this.context.globalState.get<Partial<Arrangement>>(ARRANGE_KEY, {}) }
  }

  /**
   * Merge one change into the arrangement and re-read.
   *
   * A PARTIAL from the surface, merged here: sending the whole thing would make two panels race
   * each other back to whatever each last rendered.
   */
  private async setArrangement(change: Partial<Arrangement>): Promise<void> {
    await this.context.globalState.update(ARRANGE_KEY, { ...this.arrangement(), ...change })
    await this.poll()
  }

  /**
   * The pinned ids, from VS Code's own global storage.
   *
   * The HOST keeps them, not the panel: a pin is a decision about a session and has to survive a
   * reload and read the same in the sidebar and in every tab. Deliberately not written into the
   * server's `preferences.json` — that file is the cockpit's arrangement, and an editor reaching
   * into it would be a second writer of somebody else's settings.
   */
  private pinned(): string[] {
    return this.context.globalState.get<string[]>(PINNED_KEY, [])
  }

  private async setPinned(id: string, pinned: boolean): Promise<void> {
    const current = new Set(this.pinned())
    if (pinned) current.add(id)
    else current.delete(id)
    await this.context.globalState.update(PINNED_KEY, [...current])
    this.broadcast(this.stateMessage())
  }

  /** One toast per transition, with a way straight to the session it is about. */
  private announce(id: string, title: string): void {
    const strings = this.deps.strings()
    void vscode.window
      .showWarningMessage(fill(strings.attentionToast ?? '{0}', title), strings.attentionOpen ?? 'Open')
      .then(picked => {
        if (!picked) return
        this.deps.openTab(id)
      })
  }

  private broadcast(msg: HostMessage): void {
    for (const surface of this.surfaces.values()) void surface.webview.postMessage(msg)
  }

  private async handle(surface: Surface, msg: ViewMessage): Promise<void> {
    const webview = surface.webview
    switch (msg.type) {
      case 'ready':
        // The route first: the webview must know whether it is a list or one pinned session before
        // it draws anything, or a tab flashes the whole fleet on the way to its own session.
        void webview.postMessage({
          type: 'mount',
          route: surface.route,
          pinned: surface.pinned,
          theme: themeKind(),
        } satisfies HostMessage)
        void webview.postMessage(this.stateMessage())
        return
      case 'refresh':
        await this.poll()
        return
      case 'act': {
        const out = await this.deps.client().act(msg)
        this.broadcast({ type: 'result', ok: out.ok, message: out.message })
        // Re-read straight away rather than waiting up to five seconds: the user just did
        // something and the list is the only evidence it happened.
        await this.poll()
        return
      }
      case 'input':
        // Straight onto this session's socket. No result on success: a toast per keystroke is not
        // feedback, the screen is. A REFUSED keystroke is reported, because a key that silently did
        // nothing is indistinguishable from a session that is ignoring you — and the ack is what
        // makes that distinction available at all.
        this.inputs.send(
          msg.id,
          msg.text !== undefined ? { text: msg.text } : msg.key!,
          ack => {
            if (ack.ok) return
            const strings = this.deps.strings()
            this.broadcast({
              type: 'result',
              ok: false,
              message: fill(strings.keyRefused ?? '{0}', ack.reason ?? 'error'),
            })
          },
        )
        return
      case 'watch':
        this.streams.watch(msg.id, surface.onTerminal)
        return
      case 'unwatch':
        this.streams.unwatch(msg.id, surface.onTerminal)
        // The write socket goes with the read stream: nobody is looking at that session any more,
        // and a socket held open for a screen nobody can see counts against the server's ceiling.
        this.inputs.close(msg.id)
        return
      case 'pin':
        await this.setPinned(msg.id, msg.pinned)
        return
      case 'arrange':
        await this.setArrangement(msg.change)
        return
      case 'reopenFell': {
        // The cockpit's own grouping of what fell together — the host resolves it; nothing here
        // decides which sessions were in it.
        const out = await this.deps.client().act({ id: '', action: 'reopenFell' })
        this.broadcast({ type: 'result', ok: out.ok, message: out.message })
        await this.poll()
        return
      }
      case 'openTab':
        this.deps.openTab(msg.id)
        // The sidebar goes BACK to the list. Otherwise the same session is open twice, in two
        // panels, side by side — and the one in the sidebar is the smaller copy of the one the
        // user just asked to see bigger.
        if (!surface.pinned) {
          surface.route = { view: 'list' }
          void webview.postMessage({
            type: 'mount',
            route: { view: 'list' },
            pinned: false,
            theme: themeKind(),
          } satisfies HostMessage)
        }
        return
      case 'kill': {
        // Asked with VS Code's own modal: unmissable, keyboard-accessible, and impossible to
        // dismiss by clicking past it. Stopping a session ends work in progress.
        const strings = this.deps.strings()
        const answer = await vscode.window.showWarningMessage(
          fill(strings.killConfirm ?? 'Stop {0}?', msg.title),
          { modal: true, detail: strings.killDetail ?? '' },
          strings.killAction ?? 'Stop',
        )
        if (!answer) return
        const out = await this.deps.client().act({ id: msg.id, action: 'kill' })
        this.broadcast({ type: 'result', ok: out.ok, message: out.message })
        await this.poll()
        return
      }
      case 'attach': {
        const ticket = await this.deps.client().attach(msg.id)
        const strings = this.deps.strings()
        if (!ticket) {
          this.broadcast({
            type: 'result',
            ok: false,
            message: strings.attachUnavailable ?? 'This session cannot be attached from here.',
          })
          return
        }
        attachInTerminal(msg.id, ticket, strings)
        return
      }
      case 'copy':
        await vscode.env.clipboard.writeText(msg.text)
        this.broadcast({ type: 'result', ok: true, message: this.deps.strings().copied ?? 'Copied.' })
        return
      case 'openFolder':
        // A new window, always: replacing the current one would close the panel the user is
        // standing in, along with whatever else they had open.
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(msg.path), {
          forceNewWindow: true,
        })
        return
      case 'newOptions': {
        const options = await this.deps.client().newOptions(msg.query)
        void webview.postMessage({ type: 'newOptions', options } satisfies HostMessage)
        return
      }
      case 'spawn': {
        const out = await this.deps.client().spawn(msg.request)
        this.broadcast({ type: 'result', ok: out.ok, message: out.message })
        await this.poll()
        // Act on the session that was actually started, by the id the spawn returned — never by
        // looking for "the newest row in that directory", which on a machine already running three
        // sessions there is a guess.
        if (out.ok && out.id) {
          if (msg.attach) {
            const ticket = await this.deps.client().attach(out.id)
            if (ticket) attachInTerminal(out.id, ticket, this.deps.strings())
          } else {
            this.deps.openTab(out.id)
          }
        }
        return
      }
      case 'startServer':
        startServerInTerminal(this.deps.strings())
        return
    }
  }

  dispose(): void {
    this.stop()
    this.streams.dispose()
    this.inputs.dispose()
    this.surfaces.clear()
  }
}

/** The docked view. Compact by circumstance, identical in content to a tab. */
export class SessionsViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'agentistics.sessions'

  constructor(private readonly hub: SessionsHub) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.hub.register(view.webview, { view: 'list' }, false)
    view.onDidDispose(() => this.hub.unregister(view.webview))
  }
}

/**
 * A fresh value per document.
 *
 * `Math.random` is not a cryptographic source and does not need to be: the nonce keeps a stray
 * injected `<script>` from running in a document whose contents this extension wrote, not an
 * attacker who can already read the page from guessing it.
 */
export function nonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < 32; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)]
  return out
}
