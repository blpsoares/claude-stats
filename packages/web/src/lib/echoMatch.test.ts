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
