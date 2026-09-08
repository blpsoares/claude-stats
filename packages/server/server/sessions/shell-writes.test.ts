import { test, expect } from 'bun:test'
import { commandSegments, commandSummary, hasUnreadableWrite, shellWrites } from './shell-writes'

test('a plain redirection names the file', () => {
  expect(shellWrites('cat > src/a.ts')).toEqual(['src/a.ts'])
  expect(shellWrites('echo hi >> notes.md')).toEqual(['notes.md'])
  expect(shellWrites('cmd >out.txt')).toEqual(['out.txt'])
})

test('A COMMAND LINE IS A CHAIN — the write is found past the cd that precedes it', () => {
  // The whole reason this is segment-by-segment: a whole-line test attributes it to `cd`. And the
  // `cd` is not merely skipped — it MOVES what follows, so the path comes back rooted.
  expect(shellWrites('cd /repo && cat > packages/web/x.ts')).toEqual(['/repo/packages/web/x.ts'])
  expect(shellWrites('mkdir -p a; touch b; echo x > a/c.txt')).toEqual(['a/c.txt'])
})

test('several writes in one line all count, in order, without repeating', () => {
  expect(shellWrites('echo a > one.txt && echo b > two.txt && echo c >> one.txt'))
    .toEqual(['one.txt', 'two.txt'])
})

test('tee writes every file it is given, and its flags are not files', () => {
  expect(shellWrites('cmd | tee -a log.txt other.txt')).toEqual(['log.txt', 'other.txt'])
})

test('cp and mv name their DESTINATION, never their source', () => {
  expect(shellWrites('cp release/agentop ~/bin/agentop-dev')).toEqual(['~/bin/agentop-dev'])
  expect(shellWrites('mv -f old.ts new.ts')).toEqual(['new.ts'])
  // One argument is not a copy anybody can name a destination for.
  expect(shellWrites('cp onlyone')).toEqual([])
})

test('devices and descriptors are not files anybody wants listed', () => {
  expect(shellWrites('cmd > /dev/null 2>&1')).toEqual([])
  expect(shellWrites('cmd 2>&1')).toEqual([])
})

test('quotes are stripped, so a path with a space is one path', () => {
  expect(shellWrites('cat > "my file.md"')).toEqual(['my file.md'])
})

test('a command that writes nothing yields nothing', () => {
  for (const c of ['git status', 'bun test', 'ls -la', 'grep -rn foo .']) {
    expect(shellWrites(c), c).toEqual([])
  }
})

test('an interpreter fed a heredoc is UNREADABLE, and says so rather than guessing', () => {
  // The paths live inside the script body; reading them would be inventing paths, which is the
  // failure this panel exists to avoid.
  expect(hasUnreadableWrite("python3 - <<'PY'\np='x.ts'\nPY")).toBe(true)
  expect(hasUnreadableWrite('node -e "require(\'fs\').writeFileSync(1)"')).toBe(true)
  expect(hasUnreadableWrite('cd /repo && python3 - <<PY')).toBe(true)
})

test('an ordinary command is not reported as unreadable', () => {
  for (const c of ['git status', 'cat > a.ts', 'bun test', 'python3 script.py']) {
    expect(hasUnreadableWrite(c), c).toBe(false)
  }
})

test('segments split on every separator a shell treats as one', () => {
  expect(commandSegments('a && b || c; d\ne | f')).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
})

test('a heredoc BODY offers up junk, and shape is what rejects it', () => {
  // The splitter cannot tell a command list from a script, so a body containing `if x > 0` yields
  // `0` as a redirection target. Measured on a real conversation: 3 such entries out of 70.
  expect(shellWrites("python3 - <<'PY'\nif x > 0:\n  pass\nPY")).toEqual([])
  expect(shellWrites("s.replace(a, b > c)")).toEqual([])
  expect(shellWrites('echo x > =')).toEqual([])
})

test('a path with a separator or an extension still passes', () => {
  expect(shellWrites('cat > packages/web/src/x.ts')).toEqual(['packages/web/src/x.ts'])
  expect(shellWrites('cat > notes.md')).toEqual(['notes.md'])
  expect(shellWrites('cat > /tmp/out')).toEqual(['/tmp/out'])
})

test('a bare word with neither is refused — it names no file anybody could open', () => {
  expect(shellWrites('cmd > outfile')).toEqual([])
})

test('a `cd` in the chain moves what follows it — the COMMAND says the directory', () => {
  // Without this the path is recorded relative and later resolved against the session's own
  // directory, which for a session working in worktrees is the wrong checkout. Measured: all 17
  // real files resolved to paths that did not exist.
  expect(shellWrites('cd /repo/wt && cat > packages/x.ts')).toEqual(['/repo/wt/packages/x.ts'])
  expect(shellWrites('cd /a/b\ncat > c.md')).toEqual(['/a/b/c.md'])
})

test('an absolute write is not moved by a preceding cd', () => {
  expect(shellWrites('cd /repo && cat > /tmp/out.log')).toEqual(['/tmp/out.log'])
})

test('a RELATIVE cd is refused — it moves from a base this module does not know', () => {
  // Resolving on a guess would name a different file, which is the failure this reader avoids.
  expect(shellWrites('cd sub && cat > x.ts')).toEqual(['x.ts'])
})

test('the summary skips the cd — it says where the work happened, never what it was', () => {
  // A session that opens nearly every command with `cd <worktree>` otherwise shows a column of
  // identical `cd` rows.
  expect(commandSummary('cd /repo/wt\nbun test')).toBe('bun test')
  expect(commandSummary('cd /repo && git status')).toBe('git status')
  expect(commandSummary('export X=1 && bun run build')).toBe('bun run build')
})

test('a command that is ONLY a cd shows the cd — that is what it did', () => {
  // Dropping it would leave the tool call with nothing beside it, which reads as a missing detail.
  expect(commandSummary('cd /repo/wt')).toBe('cd /repo/wt')
})

test('the summary is one line and is capped', () => {
  expect(commandSummary('a'.repeat(500))).toHaveLength(201)
  expect(commandSummary('echo one\necho two')).toBe('echo one')
})
