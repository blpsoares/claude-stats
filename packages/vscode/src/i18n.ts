/**
 * i18n.ts — the extension's OWN words, EN and PT.
 *
 * Only the chrome belongs here. Every sentence about a session — its state, its verbs, why a verb
 * is off, what a refused action means — is already localized by the server, because that is where
 * the decision was made. A second copy here would drift from the cockpit's wording and, worse,
 * would eventually disagree with it about what is true.
 *
 * Flat `Record<string, string>` rather than a typed interface with functions: these strings cross
 * the `postMessage` boundary into the webview, where a function cannot go. Interpolation is done at
 * the call site with `fill()`.
 */

export type Lang = 'en' | 'pt'

/**
 * VS Code's display language → ours. Anything that is not Portuguese reads as English, exactly as
 * the rest of the product treats an unknown language.
 */
export function resolveLang(setting: string | undefined, editorLanguage: string): Lang {
  if (setting === 'pt' || setting === 'en') return setting
  return editorLanguage.toLowerCase().startsWith('pt') ? 'pt' : 'en'
}

const EN: Record<string, string> = {
  title: 'Sessions',
  refresh: 'Refresh',
  openFull: 'Open in an editor tab',
  newSession: 'New session',
  attach: 'Attach',
  attachHint: 'Opens a terminal in this window and enters the session. Detach with {0}.',
  copyCommand: 'Copy the attach command',
  copied: 'Copied.',
  openFolder: 'Open this folder',
  cancel: 'Cancel',
  start: 'Start',
  startAndAttach: 'Start and attach',
  loading: 'Reading the fleet…',

  // Link states — three different facts, three different sentences.
  linkDown: 'No agentop server is answering at {0}.',
  linkDownAction: 'Start it',
  linkRefused: 'This machine will not answer questions about sessions.',
  linkSlow: 'The agentop server is taking longer than usual to answer — the fleet will refresh as soon as it does.',
  attentionOne: '1 session is waiting on you',
  attentionMany: '{0} sessions are waiting on you',

  // Emptiness. Which sentence is shown depends on what emptied the list — pointing someone at the
  // wrong switch is worse than saying nothing.
  emptyNone: 'No sessions on this machine yet.',
  emptyNoneHint: 'Start one and it appears here, alongside anything running outside agentop.',
  emptyFiltered: 'Nothing matches “{0}”.',
  emptyOnlyActive: 'Nothing is running right now.',
  emptyOnlyActiveHint: 'The sessions you named are still here — they are just not running.',
  emptyOnlyActiveAction: 'Show them',
  searchPlaceholder: 'Filter by name, project, task…',
  onlyActive: 'Only running',

  // The row.
  externalNote: 'Started outside agentop.',
  backToList: 'All sessions',
  openTab: 'Open as a tab',
  rename: 'Rename',
  pin: 'Pin to the top',
  attachShort: 'Terminal',
  tabShort: 'Tab',
  copyShort: 'Copy',
  folderShort: 'Folder',
  unpin: 'Unpin',
  pinnedGroup: 'Pinned',
  arrange: 'Arrange the list',
  arrangeGroup: 'Group by',
  arrangeSort: 'Sort by',
  arrangeScopes: 'Search in',
  sortDesc: 'Most urgent, newest, largest first',
  sortAsc: 'Reverse the order',
  clearFilters: 'Clear the filters',
  emptyFilters: 'Nothing matches these filters. {0} sessions are hidden by them.',
  fellCount: '{0} sessions fell together.',
  reopenFell: 'Reopen them',
  openTaskWhole: 'Reopen this whole task',
  finishTask: 'Mark this task finished',
  unfinishTask: 'Reopen this task',
  deleteTask: 'Delete this task',
  note: 'Note',
  task: 'Task',
  killConfirm: 'Stop {0}?',
  killDetail: 'The session ends and whatever it was doing stops with it. Its name, note and task are kept, and it can be reopened.',
  killAction: 'Stop the session',
  sessionGone: 'This session is no longer in the fleet.',
  screenTruncated: 'There is more scrollback above than this screen carries.',

  // The composer. Typing into a live session changes another running process mid-work, so the
  // region is read-only until somebody says otherwise.
  keyRefused: 'That keystroke was not delivered ({0}).',
  typingStart: 'Click to type',
  typingIdle: 'The screen is read-only until it has the keyboard.',
  typingLive: 'Typing goes to this session',
  typingLiveHint: 'Every key, including Enter, Esc, Tab and Ctrl-C. Click away to stop.',
  typeBlockedExternal: 'This session was started outside agentop — nothing here can write to it.',
  typeBlockedNotRunning: 'This session is not running, so there is nothing to receive a line.',
  approvalTitle: 'It is asking:',
  chooseOption: 'Pick an answer',
  promptPlaceholder: 'Type a line and send it to this session…',
  send: 'Send',
  verbsFor: 'What can be done with this session',

  // The wizard.
  wizardTitle: 'Start a session',
  wizardHarness: 'Assistant',
  wizardWhere: 'Where',
  wizardWherePlaceholder: 'Search a project, or type an absolute path…',
  wizardTask: 'Task (optional)',
  wizardTaskPlaceholder: 'The piece of work this belongs to',
  wizardLabel: 'Name (optional)',
  wizardPrompt: 'First message (optional)',
  wizardModel: 'Model (optional)',
  wizardModelNone: 'This assistant takes no model flag.',
  wizardEffort: 'Reasoning effort',
  wizardEffortDefault: 'default',
  wizardNoHarness: 'This machine cannot start sessions.',
  wizardPickWhere: 'Choose where it should run.',

  // Status bar.
  statusTitle: 'Agentistics — today',
  statusToday: 'today: {0} · {1} tokens · {2} sessions',
  statusUnknown: 'today: no answer from the server',
  statusWaiting: '{0} waiting',

  // Terminal / notifications.
  terminalName: 'agentop · {0}',
  attentionToast: '{0} is waiting on you.',
  attentionOpen: 'Open',
  serverStarting: 'Starting the local agentop server in a terminal.',
  attachUnavailable: 'This session cannot be attached from here.',
  networkError: 'Could not reach the agentop server on this machine.',
}

const PT: Record<string, string> = {
  title: 'Sessões',
  refresh: 'Atualizar',
  openFull: 'Abrir em uma aba do editor',
  newSession: 'Nova sessão',
  attach: 'Anexar',
  attachHint: 'Abre um terminal nesta janela e entra na sessão. Para sair, {0}.',
  copyCommand: 'Copiar o comando de anexar',
  copied: 'Copiado.',
  openFolder: 'Abrir esta pasta',
  cancel: 'Cancelar',
  start: 'Iniciar',
  startAndAttach: 'Iniciar e anexar',
  loading: 'Lendo a frota…',

  linkDown: 'Nenhum agentop server respondendo em {0}.',
  linkDownAction: 'Iniciar',
  linkRefused: 'Esta máquina não responde perguntas sobre sessões.',
  linkSlow: 'O agentop server está demorando mais que o normal para responder — a frota atualiza assim que ele responder.',
  attentionOne: '1 sessão precisa de você',
  attentionMany: '{0} sessões precisam de você',

  emptyNone: 'Nenhuma sessão nesta máquina ainda.',
  emptyNoneHint: 'Inicie uma e ela aparece aqui, junto com o que estiver rodando fora do agentop.',
  emptyFiltered: 'Nada corresponde a “{0}”.',
  emptyOnlyActive: 'Nada está rodando agora.',
  emptyOnlyActiveHint: 'As sessões que você nomeou continuam aqui — só não estão rodando.',
  emptyOnlyActiveAction: 'Mostrar',
  searchPlaceholder: 'Filtrar por nome, projeto, tarefa…',
  onlyActive: 'Só ativas',

  externalNote: 'Iniciada fora do agentop.',
  backToList: 'Todas as sessões',
  openTab: 'Abrir em uma aba',
  rename: 'Renomear',
  pin: 'Fixar no topo',
  attachShort: 'Terminal',
  tabShort: 'Aba',
  copyShort: 'Copiar',
  folderShort: 'Pasta',
  unpin: 'Desafixar',
  pinnedGroup: 'Fixadas',
  arrange: 'Arrumar a lista',
  arrangeGroup: 'Agrupar por',
  arrangeSort: 'Ordenar por',
  arrangeScopes: 'Buscar em',
  sortDesc: 'Mais urgente, mais novo, maior primeiro',
  sortAsc: 'Inverter a ordem',
  clearFilters: 'Limpar os filtros',
  emptyFilters: 'Nada corresponde a estes filtros. {0} sessões estão escondidas por eles.',
  fellCount: '{0} sessões caíram juntas.',
  reopenFell: 'Reabrir',
  openTaskWhole: 'Reabrir esta tarefa inteira',
  finishTask: 'Marcar a tarefa como concluída',
  unfinishTask: 'Reabrir esta tarefa',
  deleteTask: 'Apagar esta tarefa',
  note: 'Nota',
  task: 'Tarefa',
  killConfirm: 'Encerrar {0}?',
  killDetail: 'A sessão termina e o que ela estava fazendo para junto. O nome, a nota e a tarefa ficam, e dá para reabrir depois.',
  killAction: 'Encerrar a sessão',
  sessionGone: 'Esta sessão não está mais na frota.',
  screenTruncated: 'Há mais histórico acima do que esta tela carrega.',

  keyRefused: 'Essa tecla não foi entregue ({0}).',
  typingStart: 'Clique para digitar',
  typingIdle: 'A tela é só leitura até receber o teclado.',
  typingLive: 'O que você digitar vai para esta sessão',
  typingLiveHint: 'Todas as teclas, incluindo Enter, Esc, Tab e Ctrl-C. Clique fora para parar.',
  typeBlockedExternal: 'Esta sessão foi iniciada fora do agentop — nada aqui consegue escrever nela.',
  typeBlockedNotRunning: 'Esta sessão não está rodando, então não há nada para receber uma linha.',
  approvalTitle: 'Ela está perguntando:',
  chooseOption: 'Escolha uma resposta',
  promptPlaceholder: 'Escreva uma linha e envie para esta sessão…',
  send: 'Enviar',
  verbsFor: 'O que dá para fazer com esta sessão',

  wizardTitle: 'Iniciar uma sessão',
  wizardHarness: 'Assistente',
  wizardWhere: 'Onde',
  wizardWherePlaceholder: 'Busque um projeto, ou escreva um caminho absoluto…',
  wizardTask: 'Tarefa (opcional)',
  wizardTaskPlaceholder: 'O trabalho ao qual isto pertence',
  wizardLabel: 'Nome (opcional)',
  wizardPrompt: 'Primeira mensagem (opcional)',
  wizardModel: 'Modelo (opcional)',
  wizardModelNone: 'Este assistente não tem flag de modelo.',
  wizardEffort: 'Nível de esforço',
  wizardEffortDefault: 'padrão',
  wizardNoHarness: 'Esta máquina não sabe iniciar sessões.',
  wizardPickWhere: 'Escolha onde ela deve rodar.',

  statusTitle: 'Agentistics — hoje',
  statusToday: 'hoje: {0} · {1} tokens · {2} sessões',
  statusUnknown: 'hoje: sem resposta do servidor',
  statusWaiting: '{0} esperando',

  terminalName: 'agentop · {0}',
  attentionToast: '{0} precisa de você.',
  attentionOpen: 'Abrir',
  serverStarting: 'Iniciando o agentop server local em um terminal.',
  attachUnavailable: 'Não dá para anexar a esta sessão daqui.',
  networkError: 'Não foi possível falar com o agentop server desta máquina.',
}

export function strings(lang: Lang): Record<string, string> {
  return lang === 'pt' ? PT : EN
}

/** `{0}`-style interpolation. Missing arguments leave the placeholder rather than printing junk. */
export function fill(template: string, ...args: (string | number)[]): string {
  return template.replace(/\{(\d+)\}/g, (whole, i: string) => {
    const arg = args[Number(i)]
    return arg === undefined ? whole : String(arg)
  })
}
