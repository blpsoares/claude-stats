/**
 * panels.ts — the editor tabs.
 *
 * Two kinds, and the difference is what they are pinned to:
 *
 * - **A session tab.** One session, its live screen, its composer and its verbs, with no list to go
 *   back to. Several can be open at once — one per session — which is the point: a fleet is
 *   something you work across, and the sidebar can only ever show one at a time. Keyed by session
 *   id so asking twice REVEALS the tab that exists rather than opening a second one attached to the
 *   same screen.
 * - **The whole fleet**, for when the sidebar is too narrow to work in. One of these, revealed
 *   again if it is already open.
 *
 * `retainContextWhenHidden` on every one of them: a tab that rebuilt itself on each switch would
 * throw away the scroll position of a 200-line screen and whatever line the user had half-typed.
 */

import * as vscode from 'vscode'
import type { SessionsHub } from './sessions'

const sessionPanels = new Map<string, vscode.WebviewPanel>()
let fleetPanel: vscode.WebviewPanel | undefined

export function openSessionPanel(hub: SessionsHub, id: string, title: string): void {
  const existing = sessionPanels.get(id)
  if (existing) {
    existing.reveal()
    return
  }
  const panel = vscode.window.createWebviewPanel(
    'agentistics.session',
    title,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  )
  sessionPanels.set(id, panel)
  hub.register(panel.webview, { view: 'session', id }, true)
  panel.onDidDispose(() => {
    hub.unregister(panel.webview)
    sessionPanels.delete(id)
  })
}

/** Rename an open session tab — a row renamed in the sidebar must not leave a stale tab title. */
export function retitleSessionPanel(id: string, title: string): void {
  const panel = sessionPanels.get(id)
  if (panel && panel.title !== title) panel.title = title
}

export function openFleetPanel(hub: SessionsHub, title: string): void {
  if (fleetPanel) {
    fleetPanel.reveal()
    return
  }
  fleetPanel = vscode.window.createWebviewPanel(
    'agentistics.sessionsPanel',
    title,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  )
  hub.register(fleetPanel.webview, { view: 'list' }, false)
  const panel = fleetPanel
  panel.onDidDispose(() => {
    hub.unregister(panel.webview)
    fleetPanel = undefined
  })
}

export function disposePanels(): void {
  for (const panel of sessionPanels.values()) panel.dispose()
  sessionPanels.clear()
  fleetPanel?.dispose()
  fleetPanel = undefined
}
