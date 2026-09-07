/**
 * projectTabs.ts — PURE: the wizard's "where" tabs, their words, and why a tab is empty.
 *
 * The KINDS themselves are `@agentistics/core`'s `projectKind` — one rule, read by the server that
 * budgets its results per kind and by the picker that files them into tabs. This module is only
 * what a person reads: the tab names, and the sentence an empty list gets.
 *
 * The empty sentence is the part worth testing. Three different things can empty this list and they
 * send a reader to three different actions — clear the box, switch tab, or nothing is startable at
 * all — and one shared "no folder found" named none of them. It is the same rule
 * `liveEmptyNotice` applies to the live-sessions list and `emptyReason` applies to `session ls`.
 */

import { PROJECT_KIND_ORDER, type ProjectKind } from '@agentistics/core'

/** `all` first and default: the ranked merge is what most people want, and the tabs narrow it. */
export type ProjectTab = ProjectKind | 'all'

export const KIND_TABS: ProjectTab[] = ['all', ...PROJECT_KIND_ORDER]

export function kindLabel(tab: ProjectTab, pt: boolean): string {
  switch (tab) {
    case 'all': return pt ? 'Tudo' : 'All'
    // "Repositório" rather than "Git": the word names the thing, not the tool that makes it one.
    case 'repo': return pt ? 'Repositórios' : 'Repositories'
    case 'project': return pt ? 'Projetos' : 'Projects'
    case 'folder': return pt ? 'Pastas' : 'Folders'
  }
}

/** One line under the tabs saying what this one holds. The division asked for, said in words. */
export function kindHint(tab: ProjectTab, pt: boolean): string {
  switch (tab) {
    case 'all':
      return pt
        ? 'Tudo que dá para abrir aqui, do mais conhecido ao menos.'
        : 'Everything startable here, from the best known to the least.'
    case 'repo':
      return pt
        ? 'Diretórios que são repositórios git — com remote registrado ou com um .git encontrado.'
        : 'Directories that are git repositories — a recorded remote, or a .git that was found.'
    case 'project':
      return pt
        ? 'Sem git, mas com sessões já rodadas ali: lugares onde você trabalha.'
        : 'No git, but sessions have run there: places you work.'
    case 'folder':
      return pt
        ? 'Nem repositório nem histórico — pastas encontradas na sua home, ou um caminho digitado.'
        : 'Neither a repository nor history — folders found in your home, or a path typed in full.'
  }
}

/**
 * WHY this list is empty, which is never one fact.
 *
 * - a search is running and matched nothing → clear or shorten it.
 * - no search, and a tab that holds nothing → switch tab; the others may have rows.
 * - no search, and NOTHING anywhere → this machine has nothing to offer, which is a different
 *   problem from a filter.
 *
 * `anyProjects` is what tells the last two apart, and it is why this takes the whole picture rather
 * than just the tab's own rows.
 */
export function kindEmpty(tab: ProjectTab, query: string, anyProjects: boolean, pt: boolean): string {
  const searching = query.trim() !== ''
  if (searching) {
    return pt
      ? `Nada em "${query.trim()}"${tab === 'all' ? '' : ` em ${kindLabel(tab, pt).toLowerCase()}`}. Tente menos letras, ou outra aba.`
      : `Nothing matches "${query.trim()}"${tab === 'all' ? '' : ` under ${kindLabel(tab, pt).toLowerCase()}`}. Try fewer letters, or another tab.`
  }
  if (anyProjects && tab !== 'all') {
    return pt
      ? `Nenhum item desta aba. ${kindHint(tab, pt)} As outras abas têm itens.`
      : `Nothing of this kind. ${kindHint(tab, pt)} The other tabs have items.`
  }
  return pt
    ? 'Nada para abrir aqui ainda. Digite um caminho completo para usar qualquer pasta da máquina.'
    : 'Nothing to open here yet. Type a full path to use any folder on the machine.'
}

/** How long the field runs ahead of the search. Imperceptible, and one request per word. */
export const SEARCH_DEBOUNCE_MS = 180
