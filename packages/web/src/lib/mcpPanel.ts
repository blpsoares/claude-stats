/**
 * mcpPanel.ts — PURE: the words and the rules of the aside's MCP tab.
 *
 * Two things are decided here rather than in the JSX, because both are honesty rules.
 *
 * **THE STATUS IS NEVER "OFFLINE".** The server reports what it could actually establish
 * (`mcp-status.ts`): a process is running this command, nothing is running it, it runs somewhere
 * else, its config names no command, or we could not look — with the reason. A stdio MCP server
 * exists only while a session that uses it runs, so "nothing is running it" is the NORMAL state and
 * calling it offline would be a fault reported where there is none.
 *
 * **A SCOPE IS A DECISION ABOUT REACH, so it is said in a sentence, not shown as a code.** `user`
 * configures every project on this machine; `project` is written into a repository other people
 * pull; `local` is this directory on this machine only. A picker that offered three words and no
 * consequences would be a picker people choose from at random.
 */

export type McpScope = 'user' | 'local' | 'project'
export type McpTransport = 'stdio' | 'http' | 'sse' | 'ws'

export type McpRunState =
  | { state: 'running'; pids: number[] }
  | { state: 'idle' }
  | { state: 'remote' }
  | { state: 'unrunnable' }
  | { state: 'unknown'; reason: string }

export interface McpEntry {
  name: string
  scope: McpScope
  transport: McpTransport
  command?: string
  args?: string[]
  envKeys?: string[]
  url?: string
  projectPath?: string
  /**
   * The server's own configuration as JSON, with every env VALUE stripped and the keys kept.
   *
   * The panel shows it so a person can read and edit what is actually configured. The values never
   * cross the boundary — one server configured here holds a database URI with credentials in it.
   */
  config: string
  run: McpRunState
}

export interface McpListPayload {
  servers: McpEntry[]
  projectPath?: string
  canWrite: boolean
}

/** The status, as a word and a colour. Never a colour alone, and never the word "offline". */
export function runText(run: McpRunState, pt: boolean): { text: string; color: string; detail?: string } {
  switch (run.state) {
    case 'running':
      return {
        text: pt ? 'rodando' : 'running',
        color: '#22c55e',
        detail: pt
          ? `${run.pids.length} processo${run.pids.length === 1 ? '' : 's'} nesta máquina`
          : `${run.pids.length} process${run.pids.length === 1 ? '' : 'es'} on this machine`,
      }
    case 'idle':
      return {
        text: pt ? 'configurado' : 'configured',
        color: 'var(--text-tertiary)',
        // NOT "offline": a stdio server runs only while a session that uses it runs.
        detail: pt
          ? 'nenhum processo agora — um servidor stdio só roda enquanto uma sessão que o usa está aberta'
          : 'no process right now — a stdio server only runs while a session using it is open',
      }
    case 'remote':
      return {
        text: pt ? 'remoto' : 'remote',
        color: '#60a5fa',
        detail: pt
          ? 'roda em outro lugar; esta máquina não tem como ver se está no ar'
          : 'runs elsewhere; this machine cannot see whether it is up',
      }
    case 'unrunnable':
      return {
        text: pt ? 'sem comando' : 'no command',
        color: '#f59e0b',
        detail: pt
          ? 'a configuração não diz o que executar, então nada consegue rodá-lo'
          : 'the config does not say what to run, so nothing can run it',
      }
    case 'unknown':
      return {
        text: pt ? 'não dá para saber' : 'cannot tell',
        color: 'var(--text-tertiary)',
        detail: unknownReason(run.reason, pt),
      }
  }
}

/** The `LiveUnavailableReason` codes, in words — the same sentences the live-sessions panel uses. */
function unknownReason(reason: string, pt: boolean): string {
  switch (reason) {
    case 'not-linux': return pt ? 'esta máquina não é Linux, e /proc é a única fonte de processos aqui' : 'this machine is not Linux, and /proc is the only process source here'
    case 'no-proc': return pt ? '/proc não está acessível' : '/proc is not readable'
    case 'container-isolated': return pt ? 'este container não enxerga os processos do host' : 'this container cannot see the host’s processes'
    case 'permission-denied': return pt ? 'os processos do host não podem ser lidos por este usuário' : 'the host’s processes cannot be read by this user'
    case 'capability-off': return pt ? 'este perfil de exposição não permite ler processos' : 'this exposure profile does not allow reading processes'
    default: return reason
  }
}

/** What a scope MEANS — the sentence that goes beside the choice, not a code. */
export function scopeText(scope: McpScope, pt: boolean): { label: string; reach: string } {
  switch (scope) {
    case 'user':
      return {
        label: pt ? 'Esta máquina' : 'This machine',
        reach: pt ? 'todos os projetos que você abrir aqui' : 'every project you open here',
      }
    case 'local':
      return {
        label: pt ? 'Só este diretório' : 'This directory only',
        reach: pt ? 'este diretório, nesta máquina, e mais nada' : 'this directory, on this machine, and nothing else',
      }
    case 'project':
      return {
        label: pt ? 'Este repositório' : 'This repository',
        // It is a file other people pull — that is the consequence worth stating.
        reach: pt
          ? 'gravado em .mcp.json e versionado — vale para quem clonar o repositório'
          : 'written into .mcp.json and committed — it applies to everyone who clones the repository',
      }
  }
}

/**
 * Which scopes may be offered here.
 *
 * `local` and `project` are resolved against a directory, so with no directory they are ABSENT
 * rather than present-and-failing — the same rule the cockpit applies to a rebuild that cannot work
 * here. Silently turning either into `user` would configure every project on the machine from a
 * button that said "this repository".
 */
export function offerableScopes(projectPath: string | undefined): McpScope[] {
  return projectPath ? ['user', 'local', 'project'] : ['user']
}

/** The sentence for the one thing a machine without the harness's CLI cannot do. */
export function cannotWriteText(pt: boolean): string {
  return pt
    ? 'O comando `claude` não está nesta máquina, e é ele que grava a configuração de MCP — aqui dá para ver, não para mudar.'
    : 'The `claude` command is not on this machine, and it is what writes the MCP configuration — this panel can show it, not change it.'
}

/** How many are running right now. The reason to look, and the dot on the tab. */
export function runningMcpCount(servers: readonly McpEntry[] | null): number {
  return servers ? servers.filter(s => s.run.state === 'running').length : 0
}
