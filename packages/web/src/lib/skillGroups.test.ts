import { expect, test } from 'bun:test'
import {
  countSkills, groupSkills, matchesSkill, packageOf, shortName, skillInvocation, splitFrontmatter,
} from './skillGroups'

const plugin = (name: string, description = '') =>
  ({ name, description, scope: 'plugin' as const })
const mine = (name: string, description = '') =>
  ({ name, description, scope: 'user' as const })

test('the package is the prefix the harness itself uses', () => {
  expect(packageOf(plugin('superpowers:brainstorming'))).toBe('superpowers')
  expect(shortName(plugin('superpowers:brainstorming'))).toBe('brainstorming')
})

test('a skill with no package is filed under one named in WORDS, never an invented package', () => {
  expect(packageOf(mine('graphify'))).toBe('')
  const groups = groupSkills([mine('graphify')], '', 'en')
  expect(groups[0]!.key).toBe('')
  expect(groups[0]!.label).toMatch(/no package/)
})

test('a colon in a NON-plugin name is not a package', () => {
  // Only `scope: 'plugin'` means the CLI put a package prefix there.
  expect(packageOf(mine('apps/web:deploy'))).toBe('')
})

test('packages come first, alphabetically; the package-less group is last', () => {
  const groups = groupSkills(
    [mine('zzz'), plugin('beta:one'), plugin('alpha:two')], '', 'en',
  )
  expect(groups.map(g => g.key)).toEqual(['alpha', 'beta', ''])
})

test('search matches the name and the description, and nothing invisible', () => {
  const sk = plugin('superpowers:tdd', 'test driven development')
  expect(matchesSkill(sk, 'TDD')).toBe(true)
  expect(matchesSkill(sk, 'driven')).toBe(true)
  expect(matchesSkill(sk, 'plugin')).toBe(false)   // the scope is not searched
})

test('an empty search is not a filter', () => {
  const all = [plugin('a:one'), mine('two')]
  expect(countSkills(groupSkills(all, '', 'en'))).toBe(2)
  expect(countSkills(groupSkills(all, '   ', 'en'))).toBe(2)
  expect(countSkills(groupSkills(all, 'one', 'en'))).toBe(1)
})

test('the invocation is what a person would type, with the trailing space', () => {
  expect(skillInvocation(plugin('superpowers:tdd'))).toBe('/superpowers:tdd ')
})

test('frontmatter is separated from the document', () => {
  const md = '---\nname: tdd\ndescription: write the test first\n---\n\n# TDD\n\nSteps.'
  const { front, body } = splitFrontmatter(md)
  expect(front).toBe('name: tdd\ndescription: write the test first')
  expect(body.startsWith('# TDD')).toBe(true)
})

test('a `---` that is not the FIRST line is a rule in the document', () => {
  // Closing on it would eat half the skill.
  const md = '# Title\n\n---\n\nbody'
  expect(splitFrontmatter(md)).toEqual({ front: '', body: md })
})

test('an unterminated header is left alone rather than half-eaten', () => {
  const md = '---\nname: x\n\nstill going'
  expect(splitFrontmatter(md).front).toBe('')
  expect(splitFrontmatter(md).body).toBe(md)
})
