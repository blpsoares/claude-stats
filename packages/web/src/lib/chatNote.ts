/**
 * chatNote.ts — PURE: what a system NOTE in the conversation says, what it MEANS, and where its
 * action lives.
 *
 * THE REPORT THIS EXISTS FOR: "quando aparecem esses cardzinhos embaixo de mensagens eu nunca sei
 * o que eles significam". A note is the harness acting under the user's role — `chat-envelope.ts`
 * names the kind in one short phrase and deliberately drops the BODY, which is right (a
 * `system-reminder` is a page of text nobody wants in their chat) and leaves a chip whose whole
 * content is a label. `background task reported back` is a true sentence about something the
 * reader cannot see, cannot reach, and has no way to ask about.
 *
 * ONE ROW PER NOTE, carrying all three answers together. Deliberately one table and not three: a
 * note that gained a translation without anyone deciding whether it leads anywhere would be the
 * silent half-answer this is replacing, and `chatNote.test.ts` fails the build when the server can
 * emit a note this table does not carry.
 *
 * `tab` IS NOT FILLED IN WHEREVER IT WOULD FIT. It names the aside tab where the thing the note is
 * about actually is — and only where that tab IS the answer. `command output` would point at the
 * `live` feed, which is hundreds of rows, and without a step id the click lands on the top of a
 * list the reader then has to search: the codebase already calls that a mistake, in the edge
 * strip's own comment ("landing on the top of the feed made the strip a navigation control rather
 * than an answer"). A chat turn carries no step id, so those notes explain and do not navigate.
 */

/** The aside tabs a note may send someone to. A subset of `ArtifactsAside`'s `TabId`, on purpose. */
export type ChatNoteTab = 'agents' | 'skills' | 'gallery'

export interface ChatNote {
  /** The note itself, in Portuguese. English is the key. */
  pt: string
  /** One sentence: what this actually was. The half the reader was missing. */
  help: { en: string; pt: string }
  /** Where its action is, when the tab IS the answer. Absent means: explain, do not navigate. */
  tab?: ChatNoteTab
}

const n = (pt: string, en: string, ptHelp: string, tab?: ChatNoteTab): ChatNote =>
  ({ pt, help: { en, pt: ptHelp }, ...(tab ? { tab } : {}) })

export const CHAT_NOTES: Record<string, ChatNote> = {
  'background task reported back': n(
    'tarefa em segundo plano respondeu',
    'A subagent this session started finished and handed its answer back.',
    'Um subagente que esta sessão iniciou terminou e devolveu a resposta.',
    'agents',
  ),
  'a skill was loaded': n(
    'uma skill foi carregada',
    'The assistant pulled in a set of instructions for this kind of task.',
    'O assistente carregou um conjunto de instruções para este tipo de tarefa.',
    'skills',
  ),
  'a skill was re-invoked': n(
    'uma skill foi reinvocada',
    'The same instructions were loaded again, later in the conversation.',
    'As mesmas instruções foram carregadas de novo, mais adiante na conversa.',
    'skills',
  ),
  'an image was attached': n(
    'uma imagem foi anexada',
    'A picture was sent into the conversation.',
    'Uma imagem foi enviada para a conversa.',
    'gallery',
  ),

  // ---- Explain only. Each is the harness talking to itself; none has a place to go. ----
  'system reminder': n(
    'lembrete do sistema',
    'The harness re-injected context for itself. Nothing you wrote.',
    'O assistente reinjetou contexto para si mesmo. Nada que você escreveu.',
  ),
  'local-command caveat': n(
    'aviso de comando local',
    'A note the harness attaches to a slash command it ran locally.',
    'Um aviso que o assistente anexa a um comando de barra que rodou localmente.',
  ),
  'command output': n(
    'saída de comando',
    'What a command printed. The text is in the Live feed, with the step that ran it.',
    'O que um comando imprimiu. O texto está no feed Live, junto do passo que o rodou.',
  ),
  'slash command': n(
    'comando de barra',
    'You ran a slash command; what it expanded to is not part of the conversation.',
    'Você rodou um comando de barra; o que ele expandiu não faz parte da conversa.',
  ),
  'shell command': n(
    'comando de shell',
    'A command was run in the shell. The step is in the Live feed.',
    'Um comando foi rodado no shell. O passo está no feed Live.',
  ),
  'a system message': n(
    'uma mensagem do sistema',
    'The harness wrote this to itself, not to you.',
    'O assistente escreveu isso para si mesmo, não para você.',
  ),
  'the conversation was truncated': n(
    'a conversa foi truncada',
    'The harness cut earlier turns to fit the window. They are gone from its view.',
    'O assistente cortou turnos anteriores para caber na janela. Eles sumiram da visão dele.',
  ),
  'the harness reported an error': n(
    'o assistente reportou um erro',
    'Something failed on the assistant’s side; the detail is in its own log.',
    'Algo falhou do lado do assistente; o detalhe está no log dele.',
  ),
  'instructions from the harness': n(
    'instruções do assistente',
    'Standing instructions the tool gives itself at the start of a turn.',
    'Instruções permanentes que a ferramenta dá a si mesma no início de um turno.',
  ),
  'project instructions were loaded': n(
    'instruções do projeto foram carregadas',
    'The repository’s own instruction file (AGENTS.md, CLAUDE.md) was read in.',
    'O arquivo de instruções do repositório (AGENTS.md, CLAUDE.md) foi lido.',
  ),
  'the environment was described to the assistant': n(
    'o ambiente foi descrito ao assistente',
    'The machine, the directory and the git state were stated to it.',
    'A máquina, o diretório e o estado do git foram informados a ele.',
  ),
  'the system prompt was set': n(
    'o prompt de sistema foi definido',
    'The instructions the assistant runs under were established for this session.',
    'As instruções sob as quais o assistente roda foram definidas para esta sessão.',
  ),
  'the model was changed': n(
    'o modelo foi trocado',
    'From here on the conversation is answered by a different model.',
    'Daqui em diante a conversa é respondida por um modelo diferente.',
  ),
  'the model was switched': n(
    'o modelo foi trocado',
    'From here on the conversation is answered by a different model.',
    'Daqui em diante a conversa é respondida por um modelo diferente.',
  ),
  'the session ended': n(
    'a sessão terminou',
    'The assistant’s process stopped here.',
    'O processo do assistente parou aqui.',
  ),
  'the session reported an error': n(
    'a sessão reportou um erro',
    'The session itself failed, not a single command inside it.',
    'A sessão em si falhou, não um comando isolado dentro dela.',
  ),
  'the turn was aborted': n(
    'o turno foi interrompido',
    'This turn was stopped before it finished — usually you pressed escape.',
    'Este turno foi parado antes de terminar — normalmente você apertou esc.',
  ),
  'context from the editor': n(
    'contexto vindo do editor',
    'The editor told the assistant what file you had open.',
    'O editor informou ao assistente qual arquivo você tinha aberto.',
  ),
  'the collaboration mode changed': n(
    'o modo de colaboração mudou',
    'How much the assistant may do on its own changed here.',
    'Quanto o assistente pode fazer por conta própria mudou aqui.',
  ),
  'a reminder about the task list': n(
    'um lembrete sobre a lista de tarefas',
    'The harness reminded itself what is still open on its to-do list.',
    'O assistente relembrou a si mesmo o que ainda está aberto na lista de tarefas dele.',
  ),
  'the harness stated its permissions': n(
    'o assistente informou suas permissões',
    'It recorded what it is allowed to do without asking.',
    'Ele registrou o que pode fazer sem perguntar.',
  ),
  'the permission mode was announced': n(
    'o modo de permissão foi anunciado',
    'It recorded whether it must ask before acting.',
    'Ele registrou se precisa perguntar antes de agir.',
  ),
  'a message from another session': n(
    'uma mensagem de outra sessão',
    'Another session on this machine wrote to this one.',
    'Outra sessão desta máquina escreveu para esta.',
  ),
  'the conversation was compacted': n(
    'a conversa foi compactada — o resumo do que veio antes',
    'Everything before this was replaced by a summary, to fit the window.',
    'Tudo antes disto foi trocado por um resumo, para caber na janela.',
  ),
  'the session was resumed': n(
    'a sessão foi retomada',
    'This conversation was reopened and continued from here.',
    'Esta conversa foi reaberta e continuou a partir daqui.',
  ),
  'an idle notice about another session': n(
    'aviso de ociosidade sobre outra sessão',
    'A different session reported it had gone quiet.',
    'Uma outra sessão avisou que ficou parada.',
  ),
  'a context-usage report': n(
    'relatório de uso de contexto',
    'How full the window was at that point. The gauge on the header says it now.',
    'Quão cheia estava a janela naquele ponto. O medidor no cabeçalho diz isso agora.',
  ),
  'injected by the assistant': n(
    'injetado pelo assistente',
    'Text the harness put here itself, under your role.',
    'Texto que o assistente colocou aqui sozinho, sob o seu papel.',
  ),
}

export interface ResolvedChatNote {
  /** What the chip prints. */
  label: string
  /** What it means, or `null` for a note this table does not carry. */
  help: string | null
  /** The aside tab to open, or `null` — explain, do not navigate. */
  tab: ChatNoteTab | null
}

/**
 * Resolve one note. TOTAL: an unmapped note keeps its own text and gains nothing.
 *
 * That fall-through is deliberate and predates this table — a missing translation is a small
 * thing, a missing line is the defect the notes exist to fix. It applies to the other two answers
 * for the same reason: no help is a gap, an invented sentence about an unknown note is a lie, and
 * a guessed destination is a click that lands somewhere unrelated.
 */
export function chatNote(note: string, pt: boolean): ResolvedChatNote {
  const row = CHAT_NOTES[note]
  if (!row) return { label: note, help: null, tab: null }
  return {
    label: pt ? row.pt : note,
    help: pt ? row.help.pt : row.help.en,
    tab: row.tab ?? null,
  }
}
