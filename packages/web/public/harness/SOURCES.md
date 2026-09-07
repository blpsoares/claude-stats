# Harness marks — where each file came from

A file with no row here may not be committed. The rule is the same one `MODEL_PRICING` and
`contextWindows.ts` follow: a value that cannot state its source is a guess, and a guess about
somebody's trademark is worse than obviously not being one.

| file | harness | source URL | retrieved | notes |
|---|---|---|---|---|
| `claude.svg` | Claude Code | https://upload.wikimedia.org/wikipedia/commons/b/b0/Claude_AI_symbol.svg | 2026-09-03 | Wikimedia Commons "Claude AI symbol.svg", CC0, sourced from `anthropic.com`. Replaces the older `claudeLogo.png`. |
| `codex.svg` | Codex CLI | https://upload.wikimedia.org/wikipedia/commons/6/66/OpenAI_logo_2025_%28symbol%29.svg | 2026-09-03 | Wikimedia Commons "OpenAI logo 2025 (symbol).svg". Codex is an OpenAI product with no distinct mark of its own — its CLI, docs and repo all use OpenAI's own logo. Monochrome, so `HarnessMark.tsx` also inlines this exact path data (`MONO_MARK.codex`) with `fill="currentColor"` — white on dark, black on light — rather than freezing it at whichever colour it was fetched in. |
| `gemini.svg` | Gemini CLI | https://upload.wikimedia.org/wikipedia/commons/1/1d/Google_Gemini_icon_2025.svg | 2026-09-03 | Wikimedia Commons "Google Gemini icon 2025.svg", extracted from `gemini.google.com` ("About Gemini"), credited to Google LLC. |
| `copilot.svg` | GitHub Copilot CLI | https://raw.githubusercontent.com/primer/octicons/main/icons/copilot-24.svg | 2026-09-03 | GitHub's own Octicons/Primer design system repository (`primer/octicons`), `copilot-24.svg`. Monochrome, so `HarnessMark.tsx` also inlines this exact path data (`MONO_MARK.copilot`) with `fill="currentColor"` — the same rendering GitHub's own `@primer/octicons-react` package applies, and the reason Octicons ship with no fill baked in. |
| `antigravity.png` | Antigravity (agy) | https://antigravity.google/apple-touch-icon.png | 2026-09-03 | The square icon-only mark from `antigravity.google`'s own site (its apple-touch-icon). The vendor's published `antigravity-logo` asset is a wordmark lockup ("Google Antigravity" text + arch), too wide for the icon slot — using it would mean cropping, which is a redraw. This one is the vendor's own icon-only asset, 180×180, transparent. |
| `kimi.png` | Kimi Code | https://kimi.ai/pwa-192.png | 2026-09-03 | The PWA app icon served directly from `kimi.ai` (Moonshot AI's own product domain, which also hosts the `MoonshotAI/kimi-code` CLI this harness wraps), 192×192, transparent. |

Marks are the property of their respective owners and are used here to identify the tool whose
sessions are being shown.
