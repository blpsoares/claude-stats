import { describe, expect, it, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HARNESS_SKILLS, parseSkillFrontmatter, readHarnessSkills, skillLine, skillNameFromDir, skillsReason } from './harness-skills'

describe('parseSkillFrontmatter', () => {
  it('reads name and description out of the frontmatter', () => {
    const out = parseSkillFrontmatter('---\nname: brainstorming\ndescription: Turn an idea into a design\n---\n# Body\n')
    expect(out.name).toBe('brainstorming')
    expect(out.description).toBe('Turn an idea into a design')
  })
  it('tolerates quotes and extra keys', () => {
    const out = parseSkillFrontmatter('---\nname: "my-skill"\nallowed-tools: Read\ndescription: \'Does a thing\'\n---\n')
    expect(out.name).toBe('my-skill')
    expect(out.description).toBe('Does a thing')
  })
  it('returns nothing for a file with no frontmatter, and never throws', () => {
    expect(parseSkillFrontmatter('# Just a heading')).toEqual({})
    expect(parseSkillFrontmatter('')).toEqual({})
    expect(parseSkillFrontmatter('---\nnot: closed')).toEqual({})
  })
  it('stops at the closing rule — a body that mentions a key is not frontmatter', () => {
    const out = parseSkillFrontmatter('---\nname: real\n---\nname: not-this\ndescription: nor this\n')
    expect(out.name).toBe('real')
    expect(out.description).toBeUndefined()
  })
})

describe('HARNESS_SKILLS', () => {
  it('names every harness, so adding one breaks the build here', () => {
    for (const h of ['claude', 'codex', 'gemini', 'copilot', 'antigravity', 'kimi']) {
      expect(h in HARNESS_SKILLS).toBe(true)
    }
  })
  it('is wired for claude only', () => {
    expect(HARNESS_SKILLS.claude).not.toBeNull()
    for (const h of ['codex', 'gemini', 'copilot', 'antigravity', 'kimi'] as const) {
      expect(HARNESS_SKILLS[h]).toBeNull()
    }
  })
  it('gives every null harness a sentence, so the menu explains itself', () => {
    expect(skillsReason('codex', 'en')).not.toBeNull()
    expect(skillsReason('claude', 'en')).toBeNull()
  })
  it('says it in both languages, and differently', () => {
    expect(skillsReason('kimi', 'pt')).not.toBe(skillsReason('kimi', 'en'))
    expect(skillsReason('kimi', 'pt')!.length).toBeGreaterThan(10)
  })
  it('refuses an unknown harness rather than inventing a source for it', () => {
    expect(skillsReason('not-a-harness', 'en')).not.toBeNull()
    expect(skillLine('not-a-harness', 'x')).toBeNull()
  })
})

describe('skillLine', () => {
  it('is the slash command the CLI itself resolves', () => {
    expect(skillLine('claude', 'brainstorming')).toBe('/brainstorming')
  })
  it('carries a plugin skill’s prefix through untouched', () => {
    expect(skillLine('claude', 'superpowers:brainstorming')).toBe('/superpowers:brainstorming')
  })
  it('has no line for a harness with no verified command, and none for an empty name', () => {
    expect(skillLine('codex', 'brainstorming')).toBeNull()
    expect(skillLine('claude', '')).toBeNull()
  })
})

describe('readHarnessSkills', () => {
  it('is empty for a harness with no source, without touching the disk', async () => {
    expect(await readHarnessSkills('codex', '/nowhere')).toEqual([])
    expect(await readHarnessSkills('not-a-harness', '/nowhere')).toEqual([])
  })
  it('reads a project’s own skills, and never throws on a directory that is not there', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentistics-skills-'))
    await mkdir(join(dir, '.claude/skills/deploy'), { recursive: true })
    await writeFile(join(dir, '.claude/skills/deploy/SKILL.md'), '---\nname: deploy\ndescription: Ship it\n---\n')
    // A directory with no SKILL.md is skipped rather than listed as a nameless skill.
    await mkdir(join(dir, '.claude/skills/not-a-skill'), { recursive: true })
    const out = await readHarnessSkills('claude', dir)
    expect(out.some(s => s.name === 'deploy' && s.description === 'Ship it' && s.scope === 'project')).toBe(true)
    expect(out.some(s => s.name === 'not-a-skill')).toBe(false)
    expect(await readHarnessSkills('claude', join(dir, 'gone'))).toBeArray()
  })
})

/**
 * THE INJECTED ENTRY NAMES THE SKILL, AND THE NOTE THREW IT AWAY.
 *
 * `chat-envelope.ts` turns `Base directory for this skill: …` into the note `a skill was loaded`
 * and drops the body — so the chip could open the skills tab and never say WHICH row. Measured on a
 * real transcript, the body carries the base directory and nothing else is needed:
 *
 *   Base directory for this skill: …/superpowers-dev/superpowers/6.0.2/skills/brainstorming
 *
 * The name has to come out as the INVOCATION name, because that is what `HarnessSkill.name` is and
 * what the panel lists; `path` deliberately never crosses to the browser. So the layout is read
 * from `HARNESS_SKILLS` itself rather than re-derived here — one declaration, two readers.
 */
test('a PLUGIN skill directory yields the invocation name, prefix included', () => {
  expect(skillNameFromDir(
    '/home/u/.claude/plugins/cache/superpowers-dev/superpowers/6.0.2/skills/brainstorming',
    HARNESS_SKILLS.claude!,
  )).toBe('superpowers:brainstorming')
})

test('a USER skill directory yields the bare name', () => {
  expect(skillNameFromDir('/home/u/.claude/skills/graphify', HARNESS_SKILLS.claude!)).toBe('graphify')
})

test('a PROJECT skill directory yields the bare name too — same segment, same rule', () => {
  expect(skillNameFromDir('/home/u/work/repo/.claude/skills/deploy', HARNESS_SKILLS.claude!))
    .toBe('deploy')
})

test('a trailing separator does not become part of the name', () => {
  expect(skillNameFromDir('/home/u/.claude/skills/graphify/', HARNESS_SKILLS.claude!)).toBe('graphify')
})

test('a directory outside every declared source names NOTHING, rather than guessing', () => {
  // A basename would be a plausible-looking answer that resolves to no row in the panel, which is
  // the confident-wrong-value this repo refuses everywhere else.
  expect(skillNameFromDir('/tmp/whatever/skills/x', HARNESS_SKILLS.claude!)).toBeNull()
  expect(skillNameFromDir('', HARNESS_SKILLS.claude!)).toBeNull()
})

test('a plugin path too short to carry a plugin segment names nothing', () => {
  expect(skillNameFromDir('/home/u/.claude/plugins/cache/skills/x', HARNESS_SKILLS.claude!)).toBeNull()
})
