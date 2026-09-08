/**
 * agy-conversation.ts — PURE. Which conversation an antigravity process is writing, read off the
 * log agy keeps open for itself.
 *
 * ## Why this exists at all
 *
 * `SpawnSpec.assignId` is how every other exact link is made, and agy has no such flag. Measured
 * 2026-09-08 against agy 1.1.27: `agy --conversation <fresh-uuid> -p "say ok"` answers
 * `warning: conversation "…" not found`, replies normally, and creates a conversation under an id
 * of its OWN — `--conversation` resumes and never assigns. So that route is closed.
 *
 * The fallback everything else leans on — find the conversation in the store by harness and
 * directory — is closed here too, and for a reason peculiar to agy: the adapter takes a
 * conversation's `project_path` from the GLOBAL `~/.gemini/antigravity-cli/history.jsonl`, and agy
 * writes that file only for a prompt TYPED IN ITS UI. A session agentop starts is given its first
 * prompt as `--prompt-interactive`, so it never appears there and its store record carries
 * `project_path: ""`. Measured on this machine the same day: 15 of 38 agy conversations had a cwd,
 * and the 23 without were exactly the ones agentop had opened. A conversation with no cwd is
 * dropped by `loadConversations`, so `planFirstSightingClaims` never even sees it as a candidate —
 * which is why every agy session agentop starts was unlinkable BY CONSTRUCTION, and why its chat
 * view had nothing to read while the terminal worked perfectly.
 *
 * ## What replaces it, and why it is exact rather than another guess
 *
 * agy opens one log per process, `~/.gemini/antigravity-cli/log/cli-<YYYYMMDD_HHMMSS>.log`, and
 * HOLDS IT OPEN — verified in `/proc/<pid>/fd` of a live agy started under tmux. Into it it writes
 * one line per conversation it creates:
 *
 *     … 218 server.go:1153] Created conversation 39783297-b1b0-49bf-9f56-b809ee1933db
 *
 * So the chain is `managed row -> tmux pane pid -> open fd -> log -> conversation`, and every link
 * in it is a fact somebody can point at. Nothing is inferred from a directory, which is the
 * standing guess `session-view.ts`'s `metricsOf` refuses precisely because it gives every session
 * of one repository the same conversation.
 *
 * ## Read like the private file it is
 *
 * The format is undocumented and internal to agy; it can change shape in any release. So every
 * function here is TOTAL and answers `null` for anything it does not positively recognise — the
 * same discipline `antigravity-protobuf.ts` and `harness-session-file.ts` keep. An absent link
 * leaves the row exactly as it behaves today; a wrong one puts somebody else's conversation on
 * screen under this session's name, which the reader cannot detect and the user cannot either.
 *
 * ## The stated limit
 *
 * The fd is a `/proc` read, so this works on Linux and answers nothing anywhere else. That is a
 * degradation, not a lie: with no link the chat view says "this session has no linked conversation
 * yet" (`chat-web.ts`), which is true.
 */

/** A conversation id as agy writes it: a plain lowercase UUID. */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

/**
 * The one line that means "this process now owns that conversation".
 *
 * Anchored on agy's own wording, and deliberately NOT on the `server.go:1153` frame beside it: a
 * source line number is the single most volatile thing in that log, and matching it would make the
 * reader fail on the next release for no gain. `getConversationDetail: found conversation …` names
 * a conversation the process merely LOOKED UP, which is not the same fact, so `Created` carries the
 * whole meaning and the test pins that difference.
 */
const CREATED_RE = new RegExp(String.raw`Created conversation (${UUID})\b`, 'g')

/**
 * agy's own per-process log — the file, not the directory.
 *
 * `crashes/crash_<pid>_<uuid>.log` lives in the same tree and also ends in `.log`, and the uuid in
 * ITS name is a crash id, not a conversation. Keying on the `log/cli-<timestamp>.log` shape is what
 * keeps the two apart.
 */
const AGY_LOG_RE = new RegExp(String.raw`/antigravity-cli/log/cli-\d{8}_\d{6}\.log$`)

/**
 * The conversation agy last said it CREATED, or `null`.
 *
 * Last wins: one process can create a second conversation (agy's own `/new`), and the one it is
 * writing now is the most recent. Taking the first would name a conversation the session has
 * already left, and it would look entirely right.
 */
export function conversationFromAgyLog(text: string): string | null {
  if (!text) return null
  let last: string | null = null
  // `matchAll` over a fresh regex each call: a `g` flag carries `lastIndex` across calls, and a
  // module-level one shared between reads would skip lines depending on what was read before it.
  for (const m of text.matchAll(new RegExp(CREATED_RE.source, 'g'))) {
    if (m[1]) last = m[1]
  }
  return last
}

/**
 * agy's session log among a process's open files, or `null`.
 *
 * Refuses on ambiguity, like every other rule in this feature: two distinct session logs open at
 * once is a shape nobody has observed and nothing here can resolve, so picking one would be a guess
 * wearing a measurement's clothes. The same path on two descriptors is one file, not two, and is
 * accepted.
 */
export function agyLogFromFds(targets: readonly string[]): string | null {
  const found = new Set<string>()
  for (const t of targets) {
    if (AGY_LOG_RE.test(t)) found.add(t)
  }
  if (found.size !== 1) return null
  return [...found][0]!
}
