/**
 * machine-label.test.ts — what this machine calls itself in its backup release tags.
 */
import { test, expect } from 'bun:test'
import { defaultMachineLabel } from './machine-label'

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
