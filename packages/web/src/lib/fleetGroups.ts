/**
 * fleetGroups.ts — which PROJECT band a fleet row belongs to, for the sidebar — PURE.
 *
 * It arranges nothing itself. The bucketing, the band ordering and the ordering inside each band
 * all come from `groupSessions` in `@agentistics/tui/control/session-fleet` — the very function the
 * terminal cockpit and `agentop session ls` resolve their bands with. A second implementation of
 * "which band does this row belong to" is exactly the defect that module exists to remove, and the
 * project key is the one most worth not re-deriving: it is `projectGroup || (dirGone ? gone :
 * project)`, so a worktree files under its main checkout and a directory that no longer exists gets
 * its own bucket instead of being named after a path that resolves to nothing.
 *
 * What lives here is the WORDS, which that module deliberately owns none of, and one rule.
 *
 * The rule: a band holding ONE project draws no heading (`showsProjectHeadings`). A heading naming
 * the only project under it repeats what the band above already said and costs a row — the same
 * reason the cockpit's cascade drops its root when the grouping is already the project. On a
 * machine whose whole fleet sits in one checkout this feature is therefore INVISIBLE, and that is
 * the correct amount of screen for it to take.
 */

import {
  DEFAULT_ORDER, dimensionWordBook, groupSessions,
  type ControlSession, type DimensionWordBook, type SessionGroup,
} from '@agentistics/tui/control/session-fleet'

type Lang = 'pt' | 'en'

/**
 * The word book, built for the PROJECT dimension only.
 *
 * `DimensionWordBook` is a `Record` over every dimension because `groupSessions` takes the whole
 * book, and the sidebar groups by exactly one of them. The other entries carry their real names so
 * nothing reads as a placeholder, but they have no `values` map: a `status` band drawn from this
 * book would be headed by the raw state key. That is a limit, not an oversight — a surface that
 * groups this fleet by another dimension has to supply that dimension's words, exactly as the
 * cockpit's `sessionWordBook` does, and must not reach for this one.
 */
function wordBook(lang: Lang): DimensionWordBook {
  const pt = lang === 'pt'
  return dimensionWordBook({
    labels: {
      day: pt ? 'Dia' : 'Day',
      status: pt ? 'Estado' : 'Status',
      harness: pt ? 'Assistente' : 'Assistant',
      model: pt ? 'Modelo' : 'Model',
      project: pt ? 'Projeto' : 'Project',
      repo: pt ? 'Repositório' : 'Repository',
      task: pt ? 'Tarefa' : 'Task',
      marked: pt ? 'Marcadas' : 'Marked',
    },
    // Each absence is its OWN sentence: "the folder was never recorded" and "no model recorded" are
    // different facts, and one blank heading shared between them is how a list starts lying.
    unfiled: {
      day: pt ? 'Sem data' : 'No date',
      status: pt ? 'Sem estado' : 'No status',
      harness: pt ? 'Assistente desconhecido' : 'Unknown assistant',
      model: pt ? 'Sem modelo' : 'No model',
      project: pt ? 'Sem projeto' : 'No project',
      repo: pt ? 'Fora de um repositório' : 'Outside a repository',
      task: pt ? 'Sem tarefa' : 'No task',
      marked: pt ? 'Não marcadas' : 'Not marked',
    },
    states: {},
    goneProject: pt ? 'Pasta removida' : 'Folder is gone',
    marked: pt ? 'Marcadas' : 'Marked',
  })
}

/**
 * The fleet as project bands — most urgent band first, and the rows inside each in `DEFAULT_ORDER`.
 *
 * `DEFAULT_ORDER` is the same ranking the cockpit breaks ties on, so a session that needs a person
 * is at the top of its band here for the same reason it is there in the terminal.
 */
export function projectGroups(rows: readonly ControlSession[], lang: Lang): SessionGroup[] {
  if (rows.length === 0) return []
  return groupSessions(rows, 'project', wordBook(lang), [], DEFAULT_ORDER)
}

/** Whether these bands are worth heading at all — see the module header for the rule. */
export function showsProjectHeadings(groups: readonly SessionGroup[]): boolean {
  return groups.length > 1
}
