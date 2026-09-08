# Versionar backups no GitHub — plano

**Goal:** um backup sobe para um repositório PRIVADO como asset de release, é confirmado byte a byte,
e só então some do disco local. Numa máquina recém-formatada, `agentop restore <url>` traz tudo de volta.

**Por que Releases e não commits:** um tarball commitado fica no histórico do git para sempre e não
se poda sem reescrever a história. Um asset de release não entra no histórico, aceita até 2 GB, e
pode ser apagado — retenção de verdade. O repositório guarda só o documento e o workflow, alguns KB.

## Restrições globais

- Trabalhar em `/home/mithrandir/agentistics/.claude/worktrees/backup-restore`, branch `feat/backup-restore`.
- Código e comentários em INGLÊS. Mensagens de commit em PORTUGUÊS, Conventional Commits.
- **Nenhuma dependência nova.** `fetch` é nativo no Bun; não instalar octokit.
- **`git add` só os arquivos que você mudou, por caminho explícito.** Nunca `git add -A`.
- **Nunca `git config`, `git reset`, `git checkout`, `git rebase`.** Esta branch já teve a identidade
  git compartilhada destruída duas vezes por agentes descuidados.
- Há um servidor de preview rodando desta worktree nas portas 48500/48501 — não derrube.
- O hook de pre-commit roda `bun tsc --noEmit` e a suite inteira. Ambos precisam passar.

---

# Onda G1 — o cliente, a configuração e a checagem de privacidade

## G1.1 `github-store.ts` — onde o token mora

`~/.agentistics/github-backup.json`, modo **0600**:

```ts
export interface GithubBackupConfig {
  /** `https://github.com/<owner>/<repo>` como o usuário colou. */
  url: string
  owner: string
  repo: string
  /** PAT. NUNCA logado, NUNCA devolvido por uma rota, NUNCA num backup. */
  token: string
  /** Quantos releases manter lá. 0 = manter todos. */
  keepRemote: number
  /** Apagar o arquivo local depois de confirmar o upload. */
  deleteLocalAfterUpload: boolean
}
```

**E entra na tabela de exclusão como `secret`**, com `restoreWith: 'agentop backup github setup <url>'`.
Um arquivo de configuração de backup que carrega uma chave e mora onde os backups moram é
exatamente o que a tabela existe para barrar.

`readGithubConfig()` / `writeGithubConfig()`. O token nunca sai por `GET /api/backup/status` —
a rota devolve `{ configured: true, url, owner, repo }` e mais nada.

## G1.2 `github-api.ts` — PURO onde dá, IO onde não dá

**Puro e testado:** `parseRepoUrl(input)` aceita `https://github.com/o/r`, `github.com/o/r`,
`git@github.com:o/r.git`, `o/r` → `{ owner, repo } | null`. Recusa qualquer outro host **nomeando-o**:
este código manda um token junto, e mandá-lo para um host que o usuário digitou errado é o pior
resultado possível.

**IO:** um `gh(path, init)` que monta `Authorization: Bearer <token>`, `Accept:
application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, e devolve
`{ ok: true, data } | { ok: false, status, message }`. **Nunca lança e nunca inclui o token na
mensagem de erro.**

## G1.3 O cadastro, e a recusa que importa

`agentop backup github setup <url>` (e o formulário na TUI/web) faz, nesta ordem:

1. `parseRepoUrl` — host desconhecido é recusado antes de qualquer requisição
2. pede o token (nunca ecoado)
3. `GET /repos/{owner}/{repo}` — se 404, diz que o repositório não existe **ou** o token não o
   alcança, porque a API não distingue os dois para um repo privado
4. **`private === true` ou RECUSA.** Um repositório público com suas métricas, seus primeiros
   prompts e o mapa dos seus diretórios é um vazamento. O usuário dizer que é privado não conta:
   a API responde e é ela quem vale
5. verifica que o token escreve: `GET /repos/{o}/{r}` traz `permissions.push` — sem isso o upload
   falharia só na hora, depois de gerar o arquivo
6. grava 0600

Cada recusa é **uma frase dizendo o que fazer**, nunca um código de status cru.

## G1.4 Testes

`parseRepoUrl` sobre as quatro formas mais lixo e hosts estranhos. O fluxo de setup contra um
`fetch` injetado (a função aceita um `fetch` opcional): repo público → recusa; 404 → a frase sobre
os dois casos; sem `push` → recusa; feliz → grava com modo 0600. **Um teste afirma que o token não
aparece em nenhuma mensagem de erro que a função produz.**

---

# Onda G2 — subir, confirmar, e só então apagar

## G2.1 A escada de confirmação

O usuário pediu "0 espaço pra falhas". A ordem é:

1. cria o release (`POST /repos/{o}/{r}/releases`), tag `backup-<ISO>`, **`prerelease: false`,
   `draft: false`**, e o CORPO carrega o resumo do manifesto — camadas, harnesses, contagem de
   sessões, bytes e **o sha256**. O corpo é o que viaja: numa máquina nova o `backups.jsonl` local
   não existe, então o sha esperado precisa estar do lado de lá
2. sobe o asset (`POST <upload_url>?name=<arquivo>`, `Content-Type: application/octet-stream`)
3. relê o release: o asset existe? `state === 'uploaded'`? `size` bate exatamente?
4. **baixa de volta** (`GET /repos/{o}/{r}/releases/assets/{id}` com `Accept:
   application/octet-stream`) e confere o **sha256**. É a única prova real — (3) confia no metadado
   do GitHub, (4) prova que os bytes que chegaram são os que saíram
5. só agora, e se `deleteLocalAfterUpload`, apaga o local

**Qualquer passo falhando: o arquivo local FICA e a falha é nomeada.** Nunca apagar por otimismo.
O custo de (4) é real — baixar de volta o que subiu — e o tempo aparece na saída.

## G2.2 O aviso de tamanho

`uploadVerdict(bytes)`, **puro**:

- `< 1.7 GB` → `ok`
- `1.7–2 GB` → `near-limit`, sobe e avisa que o próximo pode não caber
- `≥ 2 GB` → `too-large`, **não sobe**

No caso `too-large`, a mensagem diz onde o arquivo está, que ele é único e autossuficiente, que
serve pendrive/Drive/outra máquina, e como restaurar dali — mais as alternativas que caberiam
(`agentop backup` sozinho, ou `--harness` um por vez).

## G2.3 Retenção remota

Depois de um upload confirmado: lista releases com a tag `backup-`, ordena por data, apaga os
que passam de `keepRemote` (asset e release). `keepRemote: 0` mantém todos. **Só apaga releases
cuja tag casa o padrão** — um release que o usuário criou à mão nunca é tocado.

## G2.4 A agenda faz o mesmo caminho

O `daemon.ts` chama o mesmo fluxo completo. Se a confirmação falhar, mantém o local e loga —
nunca apaga.

---

# Onda G3 — restaurar a partir da URL

**É o caso que fecha tudo: numa máquina recém-formatada você tem a URL e nada mais.**

```
agentop restore https://github.com/user/agentistics-backups
agentop restore https://github.com/user/agentistics-backups --release backup-2026-09-05T04-07-03Z
```

1. `parseRepoUrl`; se não houver token gravado, **pede** (a máquina é nova; não há nada gravado)
2. lista releases; sem `--release`, o mais recente com tag `backup-`
3. mostra o que vai baixar — data, tamanho, camadas, harnesses — **e pergunta**, porque baixar
   2 GB é uma decisão
4. baixa para `~/.agentistics/backups/`
5. **confere o sha256 contra o que está no corpo do release**, antes de restaurar
6. daí em diante é o restore de sempre: fase 1 métricas, fase 2 `--repos`

`agentop restore github --list` mostra o que existe lá sem baixar nada.

---

# Onda G4 — o documento

No setup, escreve no repositório (via API, um commit) `.github/workflows/agentistics-backup-doc.yml`:
dispara em `release: published`, lê o corpo do release, e atualiza `BACKUPS.md` com uma linha por
backup — data, tamanho, camadas, harnesses, sessões, repositórios, sha256, e o que ficou de fora.

**O documento é commitado; o tarball nunca.** São KB, e é o histórico navegável que o usuário pediu.

Se o repositório já tiver o workflow, não sobrescreve — diz que já existe.
