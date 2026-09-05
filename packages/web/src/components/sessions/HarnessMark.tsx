/**
 * HarnessMark — the assistant's mark beside its messages.
 *
 * These are the vendors' own marks, sourced in `public/harness/SOURCES.md` — a file with no
 * recorded source may not be committed. A harness absent from `MARK_FILE`/`MONO_MARK` falls back
 * to a MONOGRAM in the harness's own brand colour — a letter, plainly a placeholder — which STAYS
 * as the fallback for the next harness added before its mark is found. Deleting it would render a
 * broken image.
 *
 * To ship a real mark, drop the file in `public/harness/`, record its source in `SOURCES.md`, and
 * add it here. Nothing else changes.
 */

import { HARNESS_COLORS, HARNESS_LABELS } from '../../lib/harness'

/**
 * Vendor assets present in this repository, with their provenance in
 * `public/harness/SOURCES.md`. A harness absent here falls back to its monogram — which STAYS,
 * for the next harness added before its mark is found. Deleting it would render a broken image.
 *
 * ONLY genuinely multi-colour marks belong here — an `<img>`'s document has no access to this
 * page's CSS, so a mark drawn on top of it can never follow the theme. A vendor mark that is
 * itself monochrome goes in `MONO_MARK` instead.
 */
const MARK_FILE: Record<string, string> = {
  claude: '/harness/claude.svg',
  gemini: '/harness/gemini.svg',
  antigravity: '/harness/antigravity.png',
  kimi: '/harness/kimi.png',
}

/**
 * Monochrome vendor marks, INLINED rather than referenced by `<img>` — that is the only way an
 * SVG can pick up `currentColor`, since an `<img>`'s document is isolated from this page's CSS.
 * The path data below is copied byte-for-byte from the committed `public/harness/<id>.svg` (same
 * file, same row in `SOURCES.md`); this constant exists only to wire that exact markup into a
 * theme-following fill, never to redraw it.
 *
 * `fill="currentColor"` on the root, inherited by every child `<path>` that carries no fill of its
 * own — true of both files here, verified by reading them. NEVER `filter: invert(1)`: that maps
 * black to a near-white and white to a near-black that are neither vendor's actual mark, and it
 * would corrupt any colour mark added here later.
 */
const MONO_MARK: Record<string, { viewBox: string; paths: string[] }> = {
  // public/harness/codex.svg — OpenAI's own symbol (Codex has no mark of its own; see SOURCES.md).
  codex: {
    viewBox: '1.68 1.75 16.65 16.5',
    paths: [
      'M11.248 18.25q-.825 0-1.568-.314a4.3 4.3 0 0 1-1.32-.874 4 4 0 0 1-1.304.214 4 4 0 0 1-2.046-.544 4.27 4.27 0 0 1-1.518-1.485 4 4 0 0 1-.56-2.095q0-.48.131-1.04A4.4 4.4 0 0 1 2.04 10.71a4.07 4.07 0 0 1 .017-3.4 4.2 4.2 0 0 1 1.056-1.418 3.8 3.8 0 0 1 1.6-.842 3.9 3.9 0 0 1 .76-1.683q.593-.759 1.451-1.188a4.04 4.04 0 0 1 1.832-.429q.825 0 1.567.313.742.314 1.32.875a4 4 0 0 1 1.304-.215q1.106 0 2.046.545a4.14 4.14 0 0 1 1.501 1.485q.578.941.578 2.095 0 .48-.132 1.04.66.61 1.023 1.419.363.792.363 1.666 0 .892-.38 1.717a4.3 4.3 0 0 1-1.072 1.435 3.8 3.8 0 0 1-1.584.825 3.8 3.8 0 0 1-.775 1.683 4.06 4.06 0 0 1-1.436 1.188 4.04 4.04 0 0 1-1.832.429m-4.076-2.062q.825 0 1.435-.347l3.103-1.782a.36.36 0 0 0 .164-.313v-1.42L7.881 14.62a.67.67 0 0 1-.726 0l-3.118-1.798a.5.5 0 0 1-.017.115v.198q0 .841.396 1.551.413.693 1.139 1.089a3.2 3.2 0 0 0 1.617.412m.165-2.69a.4.4 0 0 0 .181.05q.083 0 .165-.05l1.238-.71-3.977-2.31a.7.7 0 0 1-.363-.643v-3.58q-.825.362-1.32 1.122a2.9 2.9 0 0 0-.495 1.65q0 .809.413 1.55.412.743 1.072 1.123zm3.91 3.663q.875 0 1.585-.396a2.96 2.96 0 0 0 1.534-2.64v-3.564a.32.32 0 0 0-.165-.297l-1.254-.726v4.604a.7.7 0 0 1-.363.643l-3.119 1.799a3 3 0 0 0 1.783.577m.627-6.039V8.878L10.01 7.822 8.129 8.878v2.244l1.881 1.056zM7.057 5.859a.7.7 0 0 1 .363-.644l3.119-1.798a3 3 0 0 0-1.782-.578q-.874 0-1.584.396A2.96 2.96 0 0 0 6.05 4.324a3.07 3.07 0 0 0-.396 1.551v3.547q0 .199.165.314l1.237.726zm8.383 7.887q.825-.364 1.303-1.123.495-.758.495-1.65a3.15 3.15 0 0 0-.412-1.55q-.413-.743-1.073-1.123l-3.086-1.782q-.099-.065-.181-.049a.3.3 0 0 0-.165.05l-1.238.692 3.993 2.327a.6.6 0 0 1 .264.264.64.64 0 0 1 .1.363zm-3.317-8.382a.63.63 0 0 1 .726 0l3.135 1.831v-.297q0-.792-.396-1.501a2.86 2.86 0 0 0-1.105-1.155q-.71-.43-1.65-.43-.825 0-1.436.347L8.294 5.941a.36.36 0 0 0-.165.314v1.418z',
    ],
  },
  // public/harness/copilot.svg — GitHub's own Octicons `copilot-24`, which its own React/Vue
  // packages render with `fill="currentColor"` for exactly this reason.
  copilot: {
    viewBox: '0 0 24 24',
    paths: [
      'M23.922 16.992c-.861 1.495-5.859 5.023-11.922 5.023-6.063 0-11.061-3.528-11.922-5.023A.641.641 0 0 1 0 16.736v-2.869a.841.841 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656.167-.429.414-1.055.644-1.517a10.195 10.195 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368.397-.406.89-.717 1.474-.952 1.399-1.136 3.392-2.093 6.122-2.093 2.731 0 4.767.957 6.166 2.093.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086.23.462.477 1.088.644 1.517 1.258.364 2.233 1.721 2.605 2.656a.832.832 0 0 1 .053.22v2.869a.641.641 0 0 1-.078.256ZM12.172 11h-.344a4.323 4.323 0 0 1-.355.508C10.703 12.455 9.555 13 7.965 13c-1.725 0-2.989-.359-3.782-1.259a2.005 2.005 0 0 1-.085-.104L4 11.741v6.585c1.435.779 4.514 2.179 8 2.179 3.486 0 6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.545-3.508-1.492a4.323 4.323 0 0 1-.355-.508h-.016.016Zm.641-2.935c.136 1.057.403 1.913.878 2.497.442.544 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.15.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.319-.862-2.824-1.025-1.487-.161-2.192.138-2.533.529-.269.307-.437.808-.438 1.578v.021c0 .265.021.562.063.893Zm-1.626 0c.042-.331.063-.628.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578-.341-.391-1.046-.69-2.533-.529-1.505.163-2.347.537-2.824 1.025-.462.472-.705 1.179-.705 2.319 0 1.211.175 1.926.558 2.361.365.414 1.084.751 2.657.751 1.21 0 1.902-.394 2.344-.938.475-.584.742-1.44.878-2.497Z',
      'M14.5 14.25a1 1 0 0 1 1 1v2a1 1 0 0 1-2 0v-2a1 1 0 0 1 1-1Zm-5 0a1 1 0 0 1 1 1v2a1 1 0 0 1-2 0v-2a1 1 0 0 1 1-1Z',
    ],
  },
}

/** The letter a monogram carries. First letter of the product name, which is what people say. */
function monogram(harness: string): string {
  const label = (HARNESS_LABELS as Record<string, string>)[harness] ?? harness
  return (label.trim()[0] ?? '?').toUpperCase()
}

export interface HarnessMarkProps {
  harness: string
  size?: number
}

export function HarnessMark({ harness, size = 26 }: HarnessMarkProps) {
  const color = (HARNESS_COLORS as Record<string, string>)[harness] ?? 'var(--text-secondary)'
  const name = (HARNESS_LABELS as Record<string, string>)[harness] ?? harness
  const file = MARK_FILE[harness]
  const mono = MONO_MARK[harness]

  if (mono) {
    // Same plate as the coloured marks, so the row stays visually consistent — only the glyph
    // itself differs, and its colour is `currentColor` off `--text-primary`, which is exactly
    // "white on dark, black on light" without inventing a value neither vendor publishes.
    return (
      <span
        title={name}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          width: size, height: size, borderRadius: 7,
          background: 'var(--bg-elevated)', color: 'var(--text-primary)',
        }}
      >
        <svg
          role="img" aria-label={name}
          viewBox={mono.viewBox}
          width={Math.round(size * 0.72)} height={Math.round(size * 0.72)}
          fill="currentColor"
        >
          {mono.paths.map(d => <path key={d.slice(0, 24)} d={d} />)}
        </svg>
      </span>
    )
  }

  if (file) {
    return (
      <img
        src={file}
        alt={name}
        title={name}
        style={{
          width: size, height: size, flexShrink: 0, borderRadius: 7,
          objectFit: 'contain', background: 'var(--bg-elevated)',
        }}
      />
    )
  }

  return (
    <span
      aria-label={name}
      title={name}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        width: size, height: size, borderRadius: 7,
        background: `color-mix(in srgb, ${color} 16%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 42%, transparent)`,
        color, fontSize: Math.round(size * 0.46), fontWeight: 800, lineHeight: 1,
      }}
    >
      {monogram(harness)}
    </span>
  )
}
