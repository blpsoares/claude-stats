import { expect, test } from 'bun:test'
import { pendingEchoes, SAFE_CONTAINS_LEN } from './echoMatch'

test('an exact match retires the echo', () => {
  expect(pendingEchoes(['faz o merge'], ['faz o merge'])).toEqual([])
})

test('the harness merging two queued messages into one turn still retires both', () => {
  // The measured shape: one user entry holding both messages, with the terminal's `\r` in it.
  const stored = 'pode fazer tudo. so quanto aquela imagem vc n me respondeu\r\n\n'
    + '[Image #22] esse prompt ta pendurado tem uma eternidade'
  const echoes = [
    'pode fazer tudo. so quanto aquela imagem vc n me respondeu',
    '[Image #22] esse prompt ta pendurado tem uma eternidade',
  ]
  expect(pendingEchoes(echoes, [stored])).toEqual([])
})

test('a message the transcript does NOT carry stays pending', () => {
  expect(pendingEchoes(['sobe o binário do dev pra mim'], ['outra coisa qualquer'])).toEqual([
    'sobe o binário do dev pra mim',
  ])
})

test('a SHORT echo needs an exact match — a coincidence must not retire it', () => {
  const short = 'ok'
  expect(short.length).toBeLessThan(SAFE_CONTAINS_LEN)
  // "ok" occurs inside this turn by accident; the message itself has not landed.
  expect(pendingEchoes([short], ['tudo okay por aqui, segue'])).toEqual([short])
  expect(pendingEchoes([short], ['ok'])).toEqual([])
})

test('whitespace and CR differences never keep an echo standing', () => {
  expect(pendingEchoes(['faz  o\nmerge'], ['faz o merge\r\n'])).toEqual([])
})

test('an empty echo is not a message', () => {
  expect(pendingEchoes(['   '], [])).toEqual([])
})

test('an echo whose PATHS the harness rewrote into markers is retired', () => {
  // The measured pair: the composer types one path per line, the harness stores `[Image #N]`.
  const echo = '/home/u/.agentistics/attachments/ab-image.png\n'
    + '/home/u/.agentistics/attachments/cd-image.png\n'
    + 'vou te passar mais algumas pendencias e voce abre uma nova sessao'
  const stored = '[Image #26] [Image #27]vou te passar mais algumas pendencias e voce abre uma nova sessao'
  expect(pendingEchoes([echo], [stored])).toEqual([])
})

test('a files-only message is retired by the MARKER COUNT, and only then', () => {
  const echo = '/home/u/.agentistics/attachments/ab-image.png\n/home/u/.agentistics/attachments/cd-image.png'
  expect(pendingEchoes([echo], ['[Image #1] [Image #2]'])).toEqual([])
  // A different number of files is a different message.
  expect(pendingEchoes([echo], ['[Image #1]'])).toEqual([echo])
  // A turn that HAS words is never matched by the count rule.
  expect(pendingEchoes([echo], ['[Image #1] [Image #2] olha isso'])).toEqual([echo])
})

test('the prose rule does not retire a message that never landed', () => {
  const echo = '/home/u/.agentistics/attachments/ab-image.png\nsobe o binário do dev pra mim'
  expect(pendingEchoes([echo], ['[Image #9]outra coisa qualquer'])).toEqual([echo])
})

test('a windows path counts as an attachment line', () => {
  const echo = 'C:\\Users\\u\\shot.png\nolha esse print aqui e me diz'
  expect(pendingEchoes([echo], ['[Image #3]olha esse print aqui e me diz'])).toEqual([])
})

test('a SHORT prose still needs an exact match', () => {
  // "ok" as prose must not be retired by appearing inside an unrelated turn.
  const echo = '/home/u/x.png\nok'
  expect(pendingEchoes([echo], ['[Image #1]tudo okay por aqui'])).toEqual([echo])
  expect(pendingEchoes([echo], ['[Image #1]ok'])).toEqual([])
})

test('a short echo the comparisons cannot recognise is retired by a LATER one that landed', () => {
  // The reported shape: `btw` is under SAFE_CONTAINS_LEN, so only equality is allowed, and the
  // harness stored it joined to the next message. Delivery is FIFO, so the second landing proves
  // the first was read.
  expect(pendingEchoes(
    ['btw', 'faz o merge e sobe o binário'],
    ['btw\r\nfaz o merge e sobe o binário'],
  )).toEqual([])
})

test('the ordering rule never reaches past the last landing', () => {
  // The third was delivered AFTER the one that landed and is genuinely still waiting.
  expect(pendingEchoes(
    ['ok', 'uma frase longa o bastante para casar', 'sim'],
    ['uma frase longa o bastante para casar'],
  )).toEqual(['sim'])
})

test('with nothing landed, a short echo still waits', () => {
  expect(pendingEchoes(['btw'], ['outra coisa qualquer'])).toEqual(['btw'])
})

test('a SHORT coincidental match never retires the messages before it', () => {
  // "ok" equals an "ok" the person typed an hour ago. That is the coincidence SAFE_CONTAINS_LEN
  // guards against; it may drop its own echo and nothing else, or one stale word silently clears
  // a queue of real messages.
  expect(pendingEchoes(
    ['uma mensagem de verdade que ainda espera', 'ok'],
    ['ok'],
  )).toEqual(['uma mensagem de verdade que ainda espera'])
})
