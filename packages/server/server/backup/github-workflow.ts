/**
 * github-workflow.ts — wave G4: installs `.github/workflows/agentistics-backup-doc.yml` into the
 * backup repository through the Contents API, and never touches one that is already there.
 *
 * The workflow it installs triggers on `release: published`, reads THAT release's own body (the
 * same one `backup-github.ts`'s `buildReleaseBody` writes and `parseReleaseBody`, in
 * `github-restore.ts`, reads back), and appends one row to `BACKUPS.md` at the repository root.
 * **This is the THIRD reader of that same body format** — it runs on a GitHub Actions runner's own
 * shell, not Bun, so it cannot import `backup-github.ts` and re-parses the `- label: value` lines by
 * hand. See the paragraph on `buildReleaseBody` in `backup-github.ts`, which points back at this
 * file: a field added to the body must be added to the workflow's parsing step too, or the two
 * drift silently.
 *
 * The document is COMMITTED here; the tarball itself never is — that split (a release asset that
 * accepts up to 2 GB and can be pruned, beside a document of a few KB that lives in git history
 * forever) is the whole reason this feature uses Releases at all.
 */
import { gh, type FetchLike } from './github-api'

export const BACKUP_DOC_WORKFLOW_PATH = '.github/workflows/agentistics-backup-doc.yml'

/**
 * The workflow's own text, exported so it can be asserted on directly (its shape, its
 * `permissions:` block, that it ignores a hand-made release) without a network call — installing
 * it is the only part of this module that touches the API.
 *
 * Every step that can fail (a parse that finds nothing recognisable, a push that is rejected) is
 * swallowed with a logged reason rather than allowed to fail the job: a documentation step that
 * turns red is worse than no documentation, because it reads as "the backup broke" to anyone
 * watching the Actions tab for exactly that.
 */
export function buildBackupDocWorkflow(): string {
  // Built as a line array, never one big template literal — the body mixes literal backticks
  // (this repo's own `code identifiers` in comments) with GitHub Actions' own `${{ }}` syntax and
  // shell's `$VAR` syntax, and escaping all three inside one JS template string is exactly how a
  // stray unescaped backtick or `${` becomes a TypeScript parse error instead of a YAML line.
  const lines = [
    '# Agentistics backup document',
    '#',
    '# Keeps BACKUPS.md at the repository root in sync with every backup release this repository',
    '# receives — one row per backup, newest first. The tarball itself is never committed; only this',
    '# table and this workflow are, which is the whole reason the backup feature uses GitHub Releases',
    '# instead of committing the archive.',
    '#',
    '# This step is a THIRD reader of the release-body FORMAT that',
    "# packages/server/server/backup/backup-github.ts's buildReleaseBody() writes (and that",
    "# packages/server/server/backup/github-restore.ts's parseReleaseBody() reads back on the",
    '# machine side). It runs on this runner\'s own shell, not Bun, so it re-parses the same',
    '# "- label: value" lines by hand instead of importing that TypeScript. If a field is ever',
    '# added to buildReleaseBody(), add it here too, and to parseReleaseBody() — see the comment',
    '# on buildReleaseBody() itself, which points back at this file.',
    '#',
    '# A release whose tag does not start with `backup-` is left alone. That prefix covers BOTH',
    '# shapes releaseTag mints — `backup-<iso>` and the labelled `backup-<machine>-<iso>` — which',
    '# is why the condition is a prefix and not the strict isBackupTag regex: a doc row for a',
    '# hand-made `backup-notes` release costs a line in a table, while missing every labelled',
    '# release would silently stop documenting the machines this repository exists to keep apart.',
    '# entirely — a user\'s own releases on this repository are not this workflow\'s business.',
    '#',
    '# A failure here must never fail the release itself: every step tolerates its own failure and',
    '# explains why in the job log rather than turning a documentation problem into an alarm about',
    '# the backup.',
    '',
    'name: Agentistics backup document',
    '',
    'on:',
    '  release:',
    '    types: [published]',
    '',
    'permissions:',
    '  contents: write',
    '',
    'jobs:',
    '  update-backups-doc:',
    '    runs-on: ubuntu-latest',
    "    if: startsWith(github.event.release.tag_name, 'backup-')",
    '    steps:',
    '      - name: Check out the repository',
    '        uses: actions/checkout@v4',
    '        with:',
    '          fetch-depth: 1',
    '',
    '      - name: Update BACKUPS.md from the release body',
    '        id: update',
    '        env:',
    '          RELEASE_TAG: ' + gha('github.event.release.tag_name'),
    '          RELEASE_BODY: ' + gha('github.event.release.body'),
    '          RELEASE_URL: ' + gha('github.event.release.html_url'),
    '        run: |',
    '          set +e  # a documentation failure must never fail the release — see the header above.',
    '',
    '          # --- Read the fields buildReleaseBody() wrote (backup-github.ts) -----------------',
    '          get_field() {',
    "            printf '%s\\n' \"$RELEASE_BODY\" | grep -m1 \"^- $1: \" | sed -E \"s/^- $1: //\"",
    '          }',
    '',
    '          CREATED=$(get_field created)',
    '          HOST=$(get_field host)',
    '          LAYERS=$(get_field layers)',
    '          HARNESSES=$(get_field harnesses)',
    '          SESSIONS=$(get_field sessions)',
    '          SIZE=$(get_field size)',
    "          SHA=$(get_field sha256 | tr -d '" + BACKTICK + "')",
    '',
    '          if [ -z "$CREATED" ] || [ -z "$SHA" ]; then',
    '            echo "release body does not carry a recognisable agentop backup summary — skipping BACKUPS.md" >&2',
    '            echo "changed=false" >> "$GITHUB_OUTPUT"',
    '            exit 0',
    '          fi',
    '',
    '          # --- Which of the four layers this backup did NOT include, derived from "layers" -',
    '          # (the release body carries no separate "omitted" field — the layers line already',
    '          # names everything that WAS included, so the complement is everything left out.)',
    '          OMITTED=""',
    '          for l in metrics repos archive raw; do',
    '            case ",$LAYERS," in',
    '              *", $l,"*|*",$l,"*) ;;',
    '              *) OMITTED="$OMITTED${OMITTED:+, }$l" ;;',
    '            esac',
    '          done',
    '          [ -z "$OMITTED" ] && OMITTED="none"',
    '',
    '          ROW="| $CREATED | [$RELEASE_TAG]($RELEASE_URL) | $HOST | $SIZE | $LAYERS | '
      + '$HARNESSES | $SESSIONS | $OMITTED | ' + BACKTICK + '$SHA' + BACKTICK + ' |"',
    '          HEADER_1="| Created | Release | Host | Size | Layers | Harnesses | Sessions | '
      + 'Omitted | sha256 |"',
    '          HEADER_2="|---|---|---|---|---|---|---|---|---|"',
    '',
    '          if [ ! -f BACKUPS.md ]; then',
    '            {',
    '              echo "# Agentistics backups"',
    '              echo',
    '              echo "One row per backup pushed to this repository, newest first. The archive itself is"',
    '              echo "never committed here — only this table and the workflow that writes it."',
    '              echo',
    '              echo "Restore any row with ' + BACKTICK
      + 'agentop restore <this-repository-url> --release <tag>' + BACKTICK + '."',
    '              echo',
    '              echo "$HEADER_1"',
    '              echo "$HEADER_2"',
    '              echo "$ROW"',
    '            } > BACKUPS.md',
    '          else',
    "            awk -v row=\"$ROW\" -v hdr2=\"$HEADER_2\" '",
    '              { print }',
    '              $0 == hdr2 && !done { print row; done=1 }',
    "            ' BACKUPS.md > BACKUPS.md.tmp && mv BACKUPS.md.tmp BACKUPS.md",
    '          fi',
    '',
    '          echo "changed=true" >> "$GITHUB_OUTPUT"',
    '',
    '      - name: Commit BACKUPS.md',
    "        if: steps.update.outputs.changed == 'true'",
    '        continue-on-error: true',
    '        run: |',
    '          set +e',
    "          git config user.name 'agentistics-backup[bot]'",
    "          git config user.email 'actions@users.noreply.github.com'",
    '          git add BACKUPS.md',
    '          if git diff --cached --quiet; then',
    '            echo "BACKUPS.md unchanged — nothing to commit"',
    '            exit 0',
    '          fi',
    '          git commit -m "chore(backup): record ' + gha('github.event.release.tag_name')
      + ' in BACKUPS.md"',
    '          git push || echo "::warning::could not push BACKUPS.md — see the job log for why"',
    '',
  ]
  return lines.join('\n')
}

/** A single backtick, kept as a named constant rather than a bare `'` + backtick literal — a
 *  backtick sitting alone in a line of Bash inside this file's own line array is easy to misread
 *  as the start of a JS template string when someone edits this later. */
const BACKTICK = String.fromCharCode(96)

/** `github.event.release.tag_name` -> `${{ github.event.release.tag_name }}` — GitHub Actions'
 *  own expression syntax, kept out of a literal `${{` in this file so nothing here is mistaken for
 *  (or accidentally parsed as) a JS template interpolation. */
function gha(expr: string): string {
  return '$' + '{{ ' + expr + ' }}'
}

interface ContentsFile {
  sha: string
}

export type InstallWorkflowResult =
  | { ok: true; status: 'installed' }
  | { ok: true; status: 'already-exists' }
  | { ok: false; message: string }

/**
 * Commit the workflow if, and only if, nothing is there yet.
 *
 * `GET` on the Contents API answers 200 with the file when one already exists — reported as
 * `already-exists` and left completely untouched, never overwritten, because the user may have
 * edited it — or 404 when nothing is there, the only case that goes on to create it. Any other
 * outcome (a network failure, an auth problem, a repository that has vanished) is reported by name
 * rather than attempted.
 */
export async function installGithubBackupWorkflow(
  owner: string, repo: string, token: string, fetchImpl?: FetchLike,
): Promise<InstallWorkflowResult> {
  const path = `/repos/${owner}/${repo}/contents/${BACKUP_DOC_WORKFLOW_PATH}`

  const existing = await gh<ContentsFile>(path, token, {}, fetchImpl)
  if (existing.ok) return { ok: true, status: 'already-exists' }
  if (existing.status !== 404) {
    return { ok: false, message: `could not check for an existing workflow: ${existing.message}` }
  }

  const content = Buffer.from(buildBackupDocWorkflow(), 'utf-8').toString('base64')
  const created = await gh(
    path, token,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'chore(backup): install the agentistics backup-doc workflow',
        content,
      }),
    },
    fetchImpl,
  )
  if (!created.ok) return { ok: false, message: `could not commit the workflow: ${created.message}` }

  return { ok: true, status: 'installed' }
}
