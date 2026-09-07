# What each surface is called

Agentistics has four front doors onto the same fleet. A person saying "the sessions screen" has to
land on exactly one of them, so these names are not interchangeable — in conversation, in commits,
in issues and in code comments.

| Name | What it is |
|---|---|
| **the Sessions workspace** | The **web** one: `/sessions`. The aside on the left holds the fleet; the centre holds either the overview or the open session's chat and terminal. On a central it is the same workspace, showing the relayed fleet of whichever machine its picker has chosen. |
| **the cockpit** | The **terminal** one: `agentop`'s full-screen control center, whose `sessions` tab draws the fleet. |
| **the VS Code extension** | `packages/vscode` — a client of `agentop server`, and nothing more. |
| **`agentop session …`** | The CLI verbs (`start`, `ls`, `attach`, `kill`, `rename`, `note`, …). |

**Never call the web one a cockpit.** That ambiguity is the reason this page exists.

→ [docs/sessions-web.md](sessions-web.md) for the web one, [docs/session-manager.md](session-manager.md)
for the CLI and the cockpit, [docs/vscode-extension.md](vscode-extension.md) for the editor.

## Fleet, session, conversation

- A **session** is one conversation with one assistant.
- The **fleet** is the set of them a machine can show: what is running now, plus the conversations
  that can be reopened.
- A **conversation** outlives the session that hosted it — reopening mints a new session for the
  same conversation, which is why a row is keyed by its conversation wherever one is known.

## Portuguese

"a interface de sessões", "a tela de sessões" and "o workspace de sessões" all mean the **Sessions
workspace**. "o cockpit" is the terminal one in both languages.
