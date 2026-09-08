# AGENTS.md — process rules for any AI coding assistant working in this repo

This file follows the [agents.md](https://agents.md) convention and is read by AI coding harnesses
(Claude Code, Codex CLI, Cursor, Amp, Jules, Gemini CLI, and any other tool that supports it). It
defines the **process** every harness must follow when doing implementation work in this repo —
Issues, the Project board, Discussions, and documentation. It does not duplicate architecture or
implementation detail: those live in `docs/` (canonical) and in each harness's own config
(`CLAUDE.md` for Claude Code).

## Before starting implementation work

1. Check the [Project board](https://github.com/users/blpsoares/projects/2) and open Issues for an
   item that already covers the task. If none exists, open one — use the `bug_report` or
   `feature_request` issue template as fits the change.
2. New Issues land on the board automatically
   (`.github/workflows/project-add.yml`). Set:
   - **Status** — `Backlog` on creation, `In progress` once work actually starts, `In review` once
     a PR is open, `Done` when it merges. Don't leave a card silently stale in the wrong column.
   - **Priority** — `P0` / `P1` / `P2`. Ask the user if it's unclear; never guess `P0`.
3. **Architecture-affecting or breaking changes get a Discussion first**, in the
   [Ideas category](https://github.com/blpsoares/agentistics/discussions/categories/ideas), before
   an Issue is opened — link the Issue back to the Discussion once it exists. Skip this step for
   bug fixes, docs-only changes, and scoped features that don't change a public contract (an API
   route, the `SessionMeta` shape, a CLI flag, the `HarnessAdapter` contract, a stored document
   shape, etc.). When in doubt, open the Discussion — reverting a merged breaking change is far
   more expensive than a skipped conversation.

## Opening a PR

- **Link the Issue it addresses** — `Closes #N` / `Fixes #N` / `Resolves #N` in the PR body, when
  one exists. This is a convention, not an enforced gate: there is deliberately no CI check and no
  branch protection requiring it — an Issue must never block someone from shipping a fix. Link it
  because it keeps the Project board accurate, not because something will reject the PR if you
  don't.
- Follow `CONTRIBUTING.md` for setup, running tests, and commit conventions (Conventional Commits,
  English).
- Fill in the PR template for real — a "Summary" with no "Motivation" or "Test plan" is not a
  filled template.

## Merging: squash a feature, MERGE a release

- **A feature PR into `dev` is SQUASHED.** One concern, one commit, and `dev`'s history stays
  readable.
- **A release PR (`dev` → `main`) is merged with a MERGE COMMIT — never squashed.** This is the one
  place the choice matters, and it is not a matter of taste:

  A squash rewrites every commit of the release into one NEW commit on `main`. Git can no longer see
  that `main`'s copy and `dev`'s original are the same work, so from the next release onward the same
  files look independently added on both branches and every one of them conflicts. It has happened
  once already: release #283 was squashed, and the next release PR (#302) opened with **twelve files
  in conflict**, most of them `add/add` across `packages/vscode/*`, needing a manual
  merge-and-resolve before it could go anywhere.

  Worse than the conflicts is what the automatic resolution wanted to do with them: a file `dev` had
  deliberately DELETED (`view-model.ts`, replaced by the server-side arrangement) came back, because
  the merge base predated its existence and git read `main` as adding it rather than `dev` as
  removing it. That resurrection produces no conflict and no warning — it lands silently.

  So: **read the diff of a release merge against `dev` before committing it.** It should contain the
  version bumps `release.yml` wrote on `main` and NOTHING else. Anything else in that diff is a file
  coming back from the dead.

## Documentation

- **Documentation is `docs/*.md`** — real files, versioned with the code, readable by any tool or
  person, not only a harness reading its own memory file. `CLAUDE.md` is Claude Code's own
  operational memory: dense, repo-specific invariants written for a model. It is not the canonical
  source for anything, and other harnesses do not read it. If a decision or an invariant is worth
  remembering, it belongs in `docs/` — `CLAUDE.md` may reference it, never replace it.
- The [Wiki](https://github.com/blpsoares/agentistics/wiki) is an index INTO `docs/`, not a copy of
  it. Update the doc under `docs/`; the wiki page links there rather than repeating the prose.
- Update `docs/` (and `CLAUDE.md`, if the change affects how a harness should operate in this repo)
  in the SAME PR as the code change — never as a follow-up someone has to remember to do.

## Scope discipline

- One Issue, one PR, one concern. An unrelated fix found along the way gets its own Issue, not a
  ride inside the current PR.
- If a task turns out larger than its Issue describes, say so in the Issue before the PR grows to
  match — don't silently widen scope.

## Discussions

- **Ideas** — proposals and architecture discussions before they become Issues (see above).
- **Q&A** — usage questions; don't open an Issue for "how do I configure X".
- **Show and tell** — community usage, dashboards, integrations built on top of agentistics.
- **Announcements** — maintainer-only, releases and breaking-change notices.
