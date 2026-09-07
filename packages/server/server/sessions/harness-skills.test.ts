import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HARNESS_SKILLS, parseSkillFrontmatter, readHarnessSkills, skillLine, skillsReason } from './harness-skills'

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
