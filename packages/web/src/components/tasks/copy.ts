/**
 * copy.ts — the board's words, in one place, in both languages.
 *
 * Two problems this exists to end.
 *
 * **The board was the only page in the product that ignored the language toggle**: `TasksPage`
 * passed a hardcoded `lang="en"` to its children, so a dashboard read in Portuguese answered
 * "Deliveries", "Mark delivered" and "Working on it" in English. Every other page threads the
 * language it gets from `AppContext`; this one now does too.
 *
 * **And the same thing had three names.** The nav said *Entregas*, the components said *task*, the
 * pickers said *Vincular a uma tarefa* on one surface and *File under a task* on another. A reader
 * has to work out that all three are one concept before they can act, which is most of what "está
 * bem confuso" was. The interface word is now **Entrega / Delivery**, everywhere and only.
 * `task` survives in the code, the routes and the CLI, where it confuses nobody.
 *
 * Shaped after `components/team/copy.ts`, which established the pattern here. A component may hold
 * no sentence of its own: a string written inline is a string the other language never gets.
 */

export type Lang = 'pt' | 'en'

export interface BoardCopy {
  /** The board itself. */
  deliveries: string
  delivery: string
  /** The filing gesture — the SAME words on every surface that offers it. */
  fileUnder: string
  noDelivery: string
  changeDelivery: string
  filed: string
  unfiled: string
  couldNotFile: string
  couldNotUnfile: string
  /** The reverse direction, offered only from a delivery's own screen. */
  addSession: string
  /** The spawn form's field. */
  deliveryOptional: string
  pickOrCreate: string
  dropSuggestion: string
  /** The statuses, which are a vocabulary and not free text. */
  status: Record<string, string>
  /** Verbs that used to be standalone buttons and are now rows of the status menu. */
  markDelivered: string
  markAbandoned: string
  /** Rail sections that still carry verbs of their own (linking, deleting). */
  actions: string
  /** The picker's own two lines. */
  searchOrCreate: string
  newWithDetails: string
}

const EN: BoardCopy = {
  deliveries: 'Deliveries',
  delivery: 'Delivery',
  fileUnder: 'File under a delivery',
  noDelivery: 'no delivery',
  changeDelivery: 'Delivery',
  filed: 'Session filed under the delivery.',
  unfiled: 'No longer filed under a delivery.',
  couldNotFile: 'Could not file that session.',
  couldNotUnfile: 'Could not unfile that session.',
  addSession: 'Add a session',
  deliveryOptional: 'Delivery (optional)',
  pickOrCreate: 'None — pick or create…',
  dropSuggestion: 'Do not use the suggestion',
  status: {
    backlog: 'Backlog',
    todo: 'To do',
    in_progress: 'In progress',
    blocked: 'Blocked',
    in_review: 'In review',
    done: 'Delivered',
    abandoned: 'Abandoned',
  },
  markDelivered: 'Mark delivered',
  markAbandoned: 'Mark abandoned',
  actions: 'Actions',
  searchOrCreate: 'Search deliveries, or type a new name',
  newWithDetails: 'New delivery with all the details…',
}

const PT: BoardCopy = {
  deliveries: 'Entregas',
  delivery: 'Entrega',
  fileUnder: 'Filiar a uma entrega',
  noDelivery: 'sem entrega',
  changeDelivery: 'Entrega',
  filed: 'Sessão filiada à entrega.',
  unfiled: 'Sessão desfiliada.',
  couldNotFile: 'Não foi possível filiar a sessão.',
  couldNotUnfile: 'Não foi possível desfiliar a sessão.',
  addSession: 'Adicionar sessão',
  deliveryOptional: 'Entrega (opcional)',
  pickOrCreate: 'Nenhuma — escolher ou criar…',
  dropSuggestion: 'Não usar a sugestão',
  status: {
    backlog: 'Backlog',
    todo: 'A fazer',
    in_progress: 'Em andamento',
    blocked: 'Bloqueada',
    in_review: 'Em revisão',
    // "Entregue", not "Concluída": the whole board measures DELIVERY, and the status has to be the
    // same word as the thing being counted.
    done: 'Entregue',
    abandoned: 'Abandonada',
  },
  markDelivered: 'Marcar entregue',
  markAbandoned: 'Marcar abandonada',
  actions: 'Ações',
  searchOrCreate: 'Buscar entregas, ou digitar um nome novo',
  newWithDetails: 'Nova entrega, com todos os detalhes…',
}

export function boardCopy(lang: Lang): BoardCopy {
  return lang === 'pt' ? PT : EN
}

/** The status word alone, which is what most cells need. Unknown ids render as themselves. */
export function statusLabel(status: string, lang: Lang): string {
  return boardCopy(lang).status[status] ?? status
}
