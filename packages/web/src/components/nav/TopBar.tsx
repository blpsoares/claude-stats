/**
 * TopBar — the fixed strip above everything, holding the three controls that must never move.
 *
 * The mark, the search button and the sidebar toggle live here rather than inside the aside, and
 * that is the whole point: the aside changes width, changes body between workspaces, and disappears
 * on mobile, so anything mounted in it moves when it does. An earlier pass put the toggle in the
 * aside and it jumped from beside the mark to beneath it every time the sidebar collapsed — the
 * control that reopens the sidebar is the one control that must be findable in the same place every
 * time.
 *
 * There are deliberately no history arrows. They were tried, they duplicated the browser's own in
 * every context except an installed PWA, and they were removed.
 *
 * The SELECTED SESSION's title, view tabs and actions ride here too, in the space to the right of
 * the mark that this strip has always left empty. They used to be a second full-width row under the
 * filters, with its own rule across the top — a whole band of chrome for three controls, directly
 * below a band that was already there. `trailing` is deliberately an opaque node rather than
 * session-shaped props: this component knows about a left column and a right remainder, and nothing
 * about sessions.
 */

import { Search, PanelLeft } from 'lucide-react'

export interface TopBarProps {
  lang: 'pt' | 'en'
  height: number
  /** Matches the aside beneath, so the three controls sit over its column. */
  asideWidth: number
  collapsed: boolean
  onToggleSidebar: () => void
  /**
   * Open search. Absent where there is nothing to search, and the button is then ABSENT rather than
   * disabled — a control that does nothing is indistinguishable from one that is broken.
   */
  onSearch?: () => void
  /**
   * Whatever the current screen wants in the empty half of this strip. Absent on most screens, and
   * absent is the normal case — this is a place to put something, not a slot that must be filled.
   */
  trailing?: React.ReactNode
  /**
   * Give `trailing` exactly the box `<main>`'s content has, so a row drawn here can line up with the
   * body under it.
   *
   * The left column is now exactly the aside's width and the strip pads nothing itself, so the
   * remainder already IS that box — this only drops the 9px decorative inset a title wants and a
   * self-centring max-width row must not have.
   */
  trailingFlush?: boolean
}

const iconBtn: React.CSSProperties = {
  width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center',
  borderRadius: 8, border: 'none', background: 'transparent',
  color: 'var(--text-tertiary)', cursor: 'pointer', flexShrink: 0,
  transition: 'background 0.15s, color 0.15s',
}

export function TopBar({ lang, height, asideWidth, collapsed, onToggleSidebar, onSearch, trailing, trailingFlush = false }: TopBarProps) {
  const pt = lang === 'pt'

  const hover = (on: boolean) => (e: React.MouseEvent<HTMLButtonElement>) => {
    const t = e.currentTarget
    t.style.color = on ? 'var(--text-primary)' : 'var(--text-tertiary)'
    t.style.background = on ? 'var(--bg-elevated)' : 'transparent'
  }

  return (
    <div
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, height, zIndex: 300,
        display: 'flex', alignItems: 'center',
        // The strip itself pads NOTHING. Its two columns are the aside's column and the page's,
        // and each pads itself the way the thing beneath it does — which is what lets a row drawn
        // in the remainder line up with the body without knowing anything about this component.
        padding: 0, boxSizing: 'border-box',
        background: 'var(--bg-surface)', borderBottom: '1px solid var(--border)',
      }}
    >
      {/* The ASIDE's column, continued upward: EXACTLY its width, its own horizontal padding and
          its own right border, so the strip's left cell and the sidebar below it read as one
          column — and so the remainder is exactly `<main>`'s content box.
          It used to be inset by 20px, which left the collapse toggle floating twenty pixels short
          of the edge it controls with nothing around it. Now it ends ON that edge. */}
      <div style={{
        width: collapsed ? 'auto' : asideWidth, boxSizing: 'border-box', height: '100%',
        // NO RIGHT BORDER. It continued the aside's own rule upward, which made the strip read as
        // two components stacked side by side rather than one bar — reported exactly that way.
        // The strip is one surface; the aside's edge starts below it.
        padding: '0 12px',
        display: 'flex', alignItems: 'center', gap: 8, minWidth: 0,
        justifyContent: 'flex-start',
      }}>
        {/* The mark shows in BOTH states. A collapsed sidebar is still the product's left edge, and
            an earlier pass hid it there — leaving the app with no identity anywhere on screen. */}
        <img
          src='/minimalistLogo.png'
          alt="agentistics"
          /* The mark FILLS the band rather than sitting in the middle of it, less 8px so it keeps
             air above and below. It never DECIDES the height — the `height` prop does, and this is
             derived from it. Collapsed, this column is 64px wide and shared with the toggle, so the
             mark stays small there: one that fills the height and pushes the toggle out of its own
             rail has traded one misplacement for another. */
          /* FULL HEIGHT IN BOTH STATES. Collapsed it used to shrink to 24px, because this column
             was pinned to the rail's 64px and had to share it with the toggle — so folding the
             sidebar cost the product its mark. The column is no longer pinned when collapsed
             (`width: auto`), so the mark keeps its size and the toggle simply sits beside it, which
             is where the user asked for it: to the right of the logo, still in the fixed strip. */
          style={{
            height: Math.max(0, height - 8), width: 'auto',
            maxWidth: '100%', objectFit: 'contain',
            flexShrink: 0, minWidth: 0,
          }}
        />
        {/* Collapsed, the rail holds the mark and the toggle and nothing else: three controls in
            64px is three cramped controls. Search is one keystroke away (Ctrl+K) and one click away
            once the sidebar is open. */}
        {/* Kept in BOTH states now: the column is no longer pinned to the 64px rail, so there is
            room for it, and hiding a control on one of two layouts is a control people stop
            looking for. */}
        {onSearch && (
          <button
            onClick={onSearch}
            aria-label={pt ? 'Buscar' : 'Search'}
            title={`${pt ? 'Buscar' : 'Search'}  ·  Ctrl+K`}
            style={iconBtn} onMouseEnter={hover(true)} onMouseLeave={hover(false)}
          >
            <Search size={16} />
          </button>
        )}
        <button
          onClick={onToggleSidebar}
          aria-label={collapsed ? (pt ? 'Mostrar barra lateral' : 'Show sidebar') : (pt ? 'Ocultar barra lateral' : 'Hide sidebar')}
          title={`${collapsed ? (pt ? 'Mostrar barra lateral' : 'Show sidebar') : (pt ? 'Ocultar barra lateral' : 'Hide sidebar')}  ·  Ctrl+B`}
          style={{ ...iconBtn, width: 30, height: 30 }}
          onMouseEnter={hover(true)} onMouseLeave={hover(false)}
        >
          <PanelLeft size={16} />
        </button>
      </div>

      {/* The remainder. `minWidth: 0` so a long session title truncates instead of pushing the
          strip wider than the window — the one thing a fixed full-width bar must never do. */}
      {trailing && (
        // 9px, not 4: the title now starts on the same vertical line as the content inside the
        // session below it, so the eye follows one edge down the page instead of two that are
        // nearly the same and therefore read as a misalignment.
        //
        // FLUSH drops even that: the left column is exactly the aside's width and the strip pads
        // nothing, so this box IS `<main>`'s content box, and a row that centres itself in a
        // max-width box inside it centres in the SAME box the body does.
        <div style={{
          flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10,
          paddingLeft: trailingFlush ? 0 : 9,
        }}>
          {trailing}
        </div>
      )}
    </div>
  )
}
