import { beforeEach, expect, test } from 'bun:test'
import { resetPaneWriters, writeToPane } from './pane-writer'

beforeEach(() => { resetPaneWriters() })

const defer = () => {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

test('a second write into the same pane waits for the first', async () => {
  const order: string[] = []
  const gate = defer()

  const first = writeToPane('s1', async () => {
    order.push('first:start')
    await gate.promise
    order.push('first:end')
  })
  const second = writeToPane('s1', async () => { order.push('second') })

  // The chain runs on a microtask, so let the first one actually start before looking.
  await Promise.resolve()
  // The second must not have run while the first is still typing — that overlap is what put two
  // prompts into one input box.
  expect(order).toEqual(['first:start'])
  gate.resolve()
  await Promise.all([first, second])
  expect(order).toEqual(['first:start', 'first:end', 'second'])
})

test('two panes do not wait on each other', async () => {
  const order: string[] = []
  const gate = defer()

  const a = writeToPane('a', async () => { await gate.promise; order.push('a') })
  const b = writeToPane('b', async () => { order.push('b') })

  await b
  expect(order).toEqual(['b'])
  gate.resolve()
  await a
})

test('a failed write does not wedge the pane forever', async () => {
  await expect(writeToPane('s1', async () => { throw new Error('tmux gone') })).rejects.toThrow('tmux gone')
  expect(await writeToPane('s1', async () => 'through')).toBe('through')
})

test('the caller still sees a rejection, it is only the chain that is protected', async () => {
  const boom = writeToPane('s2', async () => { throw new Error('nope') })
  await expect(boom).rejects.toThrow('nope')
})

test('order is the order asked for, across many writes', async () => {
  const seen: number[] = []
  await Promise.all([1, 2, 3, 4, 5].map(n =>
    writeToPane('s3', async () => { await new Promise(r => setTimeout(r, 6 - n)); seen.push(n) })))
  expect(seen).toEqual([1, 2, 3, 4, 5])
})
