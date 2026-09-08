import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { jsonStringKey, readHarnessDefaults, tomlTopKey } from './harness-defaults'

describe('jsonStringKey', () => {
  it('reads the key it was asked for', () => {
    expect(jsonStringKey('{"model":"opus[1m]"}', 'model')).toBe('opus[1m]')
  })

  it('a document that will not parse yields nothing, never a throw', () => {
    // A default is a convenience. It may never be the reason the new-session wizard fails.
    expect(jsonStringKey('{ not json', 'model')).toBeUndefined()
    expect(jsonStringKey('', 'model')).toBeUndefined()
    expect(jsonStringKey('[1,2]', 'model')).toBeUndefined()
    expect(jsonStringKey('"a string"', 'model')).toBeUndefined()
  })

  it('a non-string or empty value is not a default', () => {
    expect(jsonStringKey('{"model":3}', 'model')).toBeUndefined()
    expect(jsonStringKey('{"model":null}', 'model')).toBeUndefined()
    expect(jsonStringKey('{"model":"  "}', 'model')).toBeUndefined()
  })
})

describe('tomlTopKey', () => {
  it('reads a top-level quoted value', () => {
    const doc = 'model = "gpt-5.4-mini"\nmodel_reasoning_effort = "low"\n'
    expect(tomlTopKey(doc, 'model')).toBe('gpt-5.4-mini')
    expect(tomlTopKey(doc, 'model_reasoning_effort')).toBe('low')
  })

  it('STOPS at the first section — a key inside one is not in force at the top level', () => {
    // Measured on a real `~/.kimi-code/config.toml`: `default_model` at the top, then several
    // provider sections each carrying their OWN `model`. Reading past the header would report one
    // provider's model as the machine's default.
    const doc = 'default_model = "a/b"\n\n[providers.ollama]\nmodel = "qwen2.5:3b"\n'
    expect(tomlTopKey(doc, 'default_model')).toBe('a/b')
    expect(tomlTopKey(doc, 'model')).toBeUndefined()
  })

  it('ignores comments and trailing comments', () => {
    expect(tomlTopKey('# model = "wrong"\nmodel = "right" # why\n', 'model')).toBe('right')
  })

  it('a bare (unquoted) value is left alone rather than half-understood', () => {
    expect(tomlTopKey('model = true\n', 'model')).toBeUndefined()
    expect(tomlTopKey('model = \n', 'model')).toBeUndefined()
  })

  it('a key that is merely a prefix of another is not matched', () => {
    expect(tomlTopKey('model_reasoning_effort = "high"\n', 'model')).toBeUndefined()
  })
})

describe('readHarnessDefaults', () => {
  it('answers for every harness without throwing, whatever this machine holds', async () => {
    for (const h of ['claude', 'codex', 'gemini', 'copilot', 'kimi', 'antigravity'] as const) {
      const out = await readHarnessDefaults(h)
      expect(typeof out).toBe('object')
      if (out.model !== undefined) expect(out.model.length).toBeGreaterThan(0)
      if (out.effort !== undefined) expect(out.effort.length).toBeGreaterThan(0)
    }
  })

  it('a harness whose settings file names no model reports nothing', async () => {
    // gemini and copilot, measured 2026-09-05. Absent IS the answer, and the picker keeps its plain
    // "Default" rather than naming something nobody configured.
    expect(await readHarnessDefaults('gemini')).toEqual({})
    expect(await readHarnessDefaults('copilot')).toEqual({})
  })
})

describe('the module names ONE key per file and nothing else', () => {
  // Same guard, and the same reason, as `billing-detect.test.ts`. The files this reads also hold
  // credentials — `~/.copilot/config.json` holds a live GitHub token — so the defence is that the
  // module cannot so much as MENTION another field, checked over its own source.
  // The CODE, with every comment stripped: the header has to be able to NAME the hazard it is
  // defending against — a guard that forbids the module from explaining itself would be deleted.
  const source = readFileSync(join(import.meta.dir, 'harness-defaults.ts'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')

  it('never names a credential-bearing field', () => {
    for (const forbidden of [
      'copilotTokens', 'loggedInUsers', 'lastLoggedInUser', 'access_token', 'refresh_token',
      'apiKey', 'api_key', 'OAuth', 'oauth', 'password', 'secret', 'credential',
    ]) {
      expect(source).not.toContain(forbidden)
    }
  })

  it('never reads copilot\'s managed config file, which is where its token lives', () => {
    expect(source).not.toContain("'config.json'")
  })

  it('resolves paths from HOME_DIR, never a harness data-dir constant', () => {
    // A container mounting somebody else's `~/.claude` read-only would otherwise report that
    // person's configured default as this machine's.
    expect(source).toContain('HOME_DIR')
    expect(source).not.toContain('CLAUDE_DIR')
  })
})
