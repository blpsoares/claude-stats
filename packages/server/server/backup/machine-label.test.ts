/**
 * machine-label.test.ts — what this machine calls itself in its backup release tags.
 */
import { describe, test, expect } from 'bun:test'
import { defaultMachineLabel, suggestedLabel } from './machine-label'

test('a central that already named this machine wins over the hostname', () => {
  // The hostname is what a laptop was called at the factory. `BRAIAODE2` names nothing to anyone,
  // and the person has ALREADY named this machine once — on the central they connected it to
  // ("Alienware", measured on a real machine). Asking them to name it a second time, in a second
  // place, for the same machine, is the kind of duplication that ends with the two disagreeing.
  expect(defaultMachineLabel('BRAIAODE2', [{ id: 'c1', machineName: 'Alienware' }])).toBe('Alienware')
})

test('no central, or no name on it, falls back to the hostname', () => {
  expect(defaultMachineLabel('BRAIAODE2', [])).toBe('BRAIAODE2')
  expect(defaultMachineLabel('BRAIAODE2', [{ id: 'c1', machineName: '' }])).toBe('BRAIAODE2')
  expect(defaultMachineLabel('BRAIAODE2', [{ id: 'c1' }])).toBe('BRAIAODE2')
})

test('several centrals are resolved by connection id, deterministically', () => {
  // Two centrals can hold two different names for one machine, and there is no way to know which
  // the person meant. A STABLE choice matters more than a clever one: the label rides in the
  // release tag, so a label that changes between two backups splits one machine's history into
  // two, and retention would then only ever prune half of it.
  const conns = [{ id: 'c_b', machineName: 'Desk' }, { id: 'c_a', machineName: 'Alienware' }]
  expect(defaultMachineLabel('BRAIAODE2', conns)).toBe('Alienware')
  expect(defaultMachineLabel('BRAIAODE2', [...conns].reverse())).toBe('Alienware')
})

test('a hostname is still the answer when nothing else exists', () => {
  // Never an empty label: `releaseTag` would then mint the unlabelled shape, and this machine's
  // backups would be indistinguishable from every other machine's in the same repository.
  expect(defaultMachineLabel('', [])).toBe('')
  expect(defaultMachineLabel('  ', [{ id: 'c1', machineName: '  ' }])).toBe('  ')
})

describe('suggestedLabel — offering the better name without taking the choice away', () => {
  test('a stored label that is exactly the hostname was never CHOSEN, so a central name is offered', () => {
    // The label is written once, at connect time, from whatever the default was then. A stored
    // value equal to the hostname is that default showing through — nobody typed `BRAIAODE2`. When
    // a central holds a real name for the same machine, saying so is the whole of the fix.
    expect(suggestedLabel('BRAIAODE2', 'BRAIAODE2', 'Alienware')).toBe('Alienware')
  })

  test('a label the user actually chose is never second-guessed', () => {
    // Silently switching would be worse than the original problem: the label rides in the release
    // tag, so changing it splits one machine's history into two that retention then treats as two
    // machines. Offering is right; deciding is not ours.
    expect(suggestedLabel('meu-note', 'BRAIAODE2', 'Alienware')).toBe(null)
  })

  test('nothing is offered when there is nothing better to offer', () => {
    expect(suggestedLabel('BRAIAODE2', 'BRAIAODE2', 'BRAIAODE2')).toBe(null)
    expect(suggestedLabel('BRAIAODE2', 'BRAIAODE2', null)).toBe(null)
    expect(suggestedLabel('Alienware', 'BRAIAODE2', 'Alienware')).toBe(null)
  })

  test('case and surrounding space do not make two names look different', () => {
    expect(suggestedLabel('braiaode2', 'BRAIAODE2', 'Alienware')).toBe('Alienware')
    expect(suggestedLabel(' BRAIAODE2 ', 'BRAIAODE2', 'Alienware')).toBe('Alienware')
  })
})
