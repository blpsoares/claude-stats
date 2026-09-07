import { expect, test } from 'bun:test'
import { splitSlashLine } from './slashLine'

test('a leading skill invocation is split off', () => {
  expect(splitSlashLine('/superpowers:tdd faz o teste')).toEqual({
    command: '/superpowers:tdd', rest: ' faz o teste',
  })
  expect(splitSlashLine('/graphify')).toEqual({ command: '/graphify', rest: '' })
})

test('a PATH is not an invocation', () => {
  // The reason the match is anchored AND shaped: `/home/u/x` would otherwise be coloured as a
  // command in half the messages in this product.
  expect(splitSlashLine('/home/mithrandir/x.png').command).toBe('')
})

test('a slash mid-sentence is left alone', () => {
  expect(splitSlashLine('roda o /tdd depois').command).toBe('')
})

test('a lone slash is not a command', () => {
  expect(splitSlashLine('/').command).toBe('')
  expect(splitSlashLine('/ x').command).toBe('')
})

test('the rest keeps its own structure', () => {
  expect(splitSlashLine('/tdd\nlinha dois').rest).toBe('\nlinha dois')
})
