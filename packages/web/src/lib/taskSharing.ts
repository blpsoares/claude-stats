/**
 * taskSharing.ts — PURE. What sharing a delivery actually does, said in words.
 *
 * The switch is one click and its consequence is text on somebody else's server, so the sentence
 * beside it is not decoration: it is the only place a person learns WHAT travels (a title, a
 * description, comments, the NAMES of files), what does not (the files themselves, the claim, any
 * number this machine computed) and what is decided elsewhere (the sessions, by the repository
 * rules this connection already has — sharing a delivery can never widen them).
 *
 * Three states, and the third is the one that would otherwise mislead: a machine connected to no
 * central can turn the switch on and nothing travels, which must be SAID rather than left to look
 * like a share that happened.
 */

export type SharingMode = 'solo' | 'member' | 'central' | 'unknown'

export interface SharingCopy {
  /** The switch's own label. */
  label: string
  /** What happens, in one or two sentences. */
  body: string
  /** The caveat about the sessions, when there is something to share. */
  sessions?: string
}

export function sharingCopy(o: {
  shared: boolean
  mode: SharingMode
  /** How many centrals this machine pushes to. */
  connections: number
  lang: 'pt' | 'en'
}): SharingCopy {
  const pt = o.lang === 'pt'
  const connected = o.mode === 'member' && o.connections > 0
  const many = o.connections > 1

  if (!o.shared) {
    return {
      label: pt ? 'Compartilhar com a central' : 'Share with the central',
      body: pt
        ? 'Esta entrega fica só nesta máquina. Nada dela viaja.'
        : 'This delivery stays on this machine. None of it travels.',
    }
  }

  if (!connected) {
    return {
      label: pt ? 'Compartilhar com a central' : 'Share with the central',
      // Marked shared and nothing to share: said out loud, or the switch reads as a share that
      // already happened.
      body: pt
        ? 'Marcada para compartilhar — mas esta máquina não está conectada a nenhuma central, então nada viaja. Se você conectar uma, esta entrega passa a ser enviada.'
        : 'Marked as shared — but this machine is connected to no central, so nothing travels. Connect one and this delivery starts being sent.',
    }
  }

  const where = many
    ? (pt ? `às ${o.connections} centrais conectadas` : `to the ${o.connections} connected centrals`)
    : (pt ? 'à central conectada' : 'to the connected central')

  return {
    label: pt ? 'Compartilhar com a central' : 'Share with the central',
    body: pt
      ? `O título, a descrição, os comentários, as subtarefas e os NOMES dos arquivos vão ${where}. Os arquivos em si não viajam, e nenhum número calculado aqui viaja: a central soma o que ela já tem.`
      : `The title, the description, the comments, the subtasks and the NAMES of the files go ${where}. The files themselves do not travel, and no figure computed here travels: the central adds up what it already holds.`,
    sessions: pt
      ? 'As sessões seguem as regras de compartilhamento desta conexão, sem exceção — um repositório que você retém continua retido, e a central mostra que a entrega está medida a menos.'
      : 'The sessions still follow this connection’s sharing rules, without exception — a repository you withhold stays withheld, and the central says the delivery is measured short.',
  }
}
