import { test, expect } from 'bun:test'
import {
  applySkill,
  emptyPickerReason,
  filterSkills,
  flattenGroups,
  groupSkills,
  looseGroupLabel,
  skillPackage,
  slashQuery,
  stepSkill, slashMisplaced } from './skillMenu'

const sk = (name: string, description = '') => ({ name, description })

test('a package is everything before the FIRST colon', () => {
  expect(skillPackage('superpowers:brainstorming')).toBe('superpowers')
  expect(skillPackage('a:b:c')).toBe('a')
})

test('a name with no colon has no package', () => {
  expect(skillPackage('wrangler')).toBeNull()
})

test('a malformed name invents no group — a blank heading is a rendering fault', () => {
  expect(skillPackage(':leading')).toBeNull()
  expect(skillPackage('trailing:')).toBeNull()
})

test('skills group by package, packages alphabetical, loose ones LAST', () => {
  const groups = groupSkills([
    sk('wrangler'),
    sk('superpowers:brainstorming'),
    sk('claude-code-notifications:ccn'),
    sk('superpowers:writing-plans'),
    sk('design'),
  ], 'en')
  expect(groups.map(g => g.pkg)).toEqual(['claude-code-notifications', 'superpowers', null])
  expect(groups[1]!.skills.map(s => s.name))
    .toEqual(['superpowers:brainstorming', 'superpowers:writing-plans'])
  expect(groups[2]!.skills.map(s => s.name)).toEqual(['wrangler', 'design'])
})

test('the loose group is NAMED, in both languages', () => {
  expect(groupSkills([sk('design')], 'en')[0]!.label).toBe(looseGroupLabel('en'))
  expect(groupSkills([sk('design')], 'pt')[0]!.label).toBe('Sem pacote')
  expect(looseGroupLabel('en')).not.toBe('')
})

test('a fleet with no loose skills carries no loose group', () => {
  const groups = groupSkills([sk('superpowers:x'), sk('superpowers:y')], 'en')
  expect(groups).toHaveLength(1)
  expect(groups[0]!.pkg).toBe('superpowers')
})

test('an empty list groups into nothing rather than an empty heading', () => {
  expect(groupSkills([], 'en')).toEqual([])
})

test('the filter reads the DESCRIPTION too — half of these are named for a tool', () => {
  const list = [sk('wrangler', 'Cloudflare Workers CLI'), sk('design', 'Create a design canvas')]
  expect(filterSkills(list, 'cloudflare').map(s => s.name)).toEqual(['wrangler'])
  expect(filterSkills(list, 'WRANG').map(s => s.name)).toEqual(['wrangler'])
})

test('a blank filter is "the picker just opened", so it returns everything', () => {
  const list = [sk('a'), sk('b')]
  expect(filterSkills(list, '')).toHaveLength(2)
  expect(filterSkills(list, '   ')).toHaveLength(2)
})

test('a slash only starts a command at the START of a line', () => {
  expect(slashQuery('/')).toBe('')
  expect(slashQuery('/brain')).toBe('brain')
  expect(slashQuery('line one\n/brain')).toBe('brain')
})

test('a slash mid-sentence opens nothing — "and/or" is not an invocation', () => {
  expect(slashQuery('hello /brain')).toBeNull()
  expect(slashQuery('and/or')).toBeNull()
  expect(slashQuery('')).toBeNull()
})

test('a space ENDS the command, so the argument can be typed without a picker on the keys', () => {
  expect(slashQuery('/brain ')).toBeNull()
  expect(slashQuery('/brain arg')).toBeNull()
})

test('insertion replaces the typed partial and leaves the rest of the draft alone', () => {
  const out = applySkill('/brai', 5, 'superpowers:brainstorming')
  expect(out.text).toBe('/superpowers:brainstorming ')
  expect(out.caret).toBe(out.text.length)
})

test('text after the caret survives an insertion', () => {
  const draft = '/brai rest of it'
  const out = applySkill(draft, 5, 'x')
  expect(out.text).toBe('/x  rest of it')
  expect(out.text.slice(out.caret)).toBe(' rest of it')
})

test('a command on a later line replaces only that line', () => {
  const draft = 'first line\n/bra'
  const out = applySkill(draft, draft.length, 'y')
  expect(out.text).toBe('first line\n/y ')
})

test('with no command at the caret it APPENDS — a pick is never lost to a race', () => {
  expect(applySkill('', 0, 'x').text).toBe('/x ')
  expect(applySkill('hello  ', 7, 'x').text).toBe('hello /x ')
})

test('a caret outside the draft is clamped rather than throwing', () => {
  expect(applySkill('/br', 999, 'x').text).toBe('/x ')
  // Clamped to 0, so there is no command before the caret and the append branch takes it.
  expect(applySkill('/br', -5, 'x').text).toBe('/br /x ')
})

test('flattening is in reading order — the arrow keys and the rendering share one list', () => {
  const groups = groupSkills([sk('b:2'), sk('a:1'), sk('loose')], 'en')
  expect(flattenGroups(groups).map(s => s.name)).toEqual(['a:1', 'b:2', 'loose'])
})

test('the cursor wraps at both ends', () => {
  expect(stepSkill(2, 3, 1)).toBe(0)
  expect(stepSkill(0, 3, -1)).toBe(2)
  expect(stepSkill(0, 3, 1)).toBe(1)
})

test('stepping an empty list is 0, so a caller can index blindly', () => {
  expect(stepSkill(4, 0, 1)).toBe(0)
})

test('"none installed" and "none by that name" are different sentences', () => {
  expect(emptyPickerReason(0, 'zzz', 'en')).toBe('No skills installed for this session.')
  expect(emptyPickerReason(49, 'zzz', 'en')).toContain('49')
  expect(emptyPickerReason(49, 'zzz', 'en')).toContain('zzz')
  expect(emptyPickerReason(0, '', 'pt')).toBe('Nenhuma skill instalada para esta sessão.')
})

test('a slash where a command cannot be is EXPLAINED, not silently ignored', () => {
  expect(slashMisplaced('asdasd /')).toBe(true)
  // At the start of a line it is a real command — the picker is already open, nothing to say.
  expect(slashMisplaced('/')).toBe(false)
  expect(slashMisplaced('linha um\n/')).toBe(false)
  // Only in the instant the slash was typed: a path or a date must not raise it.
  expect(slashMisplaced('veja /home/u/x.png')).toBe(false)
  expect(slashMisplaced('asdasd / mais texto')).toBe(false)
  expect(slashMisplaced('')).toBe(false)
})
