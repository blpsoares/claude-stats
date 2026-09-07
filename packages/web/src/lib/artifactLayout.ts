/**
 * artifactLayout.ts — PURE: where the artifacts panel goes, and what that costs the fleet list.
 *
 * Opening the panel COLLAPSES the session list to its rail, and the width comes from where it was
 * not being read: at the moment somebody opens a file to read it, the list is the least consulted
 * thing on screen. Measured at 1440px — list 248, rail 64, panel 440 — that is 936px of
 * conversation instead of 752.
 *
 * ONE CLICK DOING TWO THINGS is normally a defect, so the reversal sticks: `listExpandedByUser`
 * means the person opened the list back up with the panel open, and their choice WINS for as long
 * as it is set. The layout then degrades to a plain three-column split, which is the honest
 * arrangement it would have had anyway.
 *
 * Below `SPLIT_MIN_WIDTH` there is no room for three columns and the choice stops existing: the
 * panel becomes an overlay, and nothing is collapsed — collapsing a list the layout is not using
 * would be taking something for nothing.
 */

export type ArtifactLayout = 'closed' | 'split' | 'split-rail' | 'overlay' | 'fullscreen'

/** Below this there is no room for list, conversation and panel at once. */
export const SPLIT_MIN_WIDTH = 1100

/**
 * How long the panel takes to open and to close, and on what curve.
 *
 * THE SAME MOTION AS THE LEFT ASIDE, deliberately: two panels on one screen that slide at different
 * speeds read as two different applications. The numbers are the nav's own (`0.22s`, the same
 * ease-out curve), stated here so the pair can only ever be changed together.
 *
 * The duration is also the UNMOUNT delay — the panel has to still be on screen while it is
 * shrinking, so whatever reads this for the transition reads it for the timeout too. Two constants
 * would be two chances for the content to vanish before its box does.
 */
export const ASIDE_ANIM_MS = 220
export const ASIDE_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'

export interface ArtifactLayoutInput {
  open: boolean
  width: number
  isMobile: boolean
  /** The person re-opened the fleet list while the panel was up. Their choice outranks the default. */
  listExpandedByUser: boolean
}

export function resolveArtifactLayout(
  { open, width, isMobile, listExpandedByUser }: ArtifactLayoutInput,
): { layout: ArtifactLayout; collapseList: boolean } {
  if (!open) return { layout: 'closed', collapseList: false }
  // A phone has one column. Anything else would be two things sharing 390px, and the file is what
  // was asked for.
  if (isMobile) return { layout: 'fullscreen', collapseList: false }
  if (width < SPLIT_MIN_WIDTH) return { layout: 'overlay', collapseList: false }
  return listExpandedByUser
    ? { layout: 'split', collapseList: false }
    : { layout: 'split-rail', collapseList: true }
}

/*
 * `shouldAutoOpen` LIVED HERE AND IS GONE.
 *
 * The panel opened itself the moment a file started being written. That was asked for — "o modelo
 * ta executando algo, automaticamente a barra deveria aparecer" — and then asked to stop, in the
 * same words that explain why: "a barra de contents ta abrindo sozinha as vezes, nao quero que isso
 * aconteça… se for pra indicar que tem algo acontecendo quero que apenas apareça um
 * componentenzinho".
 *
 * Both asks want the same thing. Knowing that something is happening is worth a lot; being pushed
 * out of the conversation you are reading, by a panel that takes half the width, costs more than it
 * is worth — and it happens over and over, because a session writes files all day.
 *
 * So the announcement is the strip at the top of the conversation (`edgeHint` below), which says
 * what is being written or run and opens the panel on the LIVE feed when pressed. The rule is not
 * kept "just in case": an uncalled rule is one somebody calls again.
 */

/**
 * What the CLOSED panel should announce from the edge of the screen, if anything.
 *
 * Asked for: when the harness starts doing something, a marker on the right edge saying so, with
 * the panel shut — "se eu quero acompanhar", and clicking it opens the live view.
 *
 * IT IS THE LAST ACTION, NOT A COUNT. A badge saying "12" tells somebody that things happened; the
 * name of what is happening tells them whether they care. `null` when the panel is open (it is
 * already saying this, in full) or when there is nothing in flight — an always-present tab on the
 * edge becomes furniture, and furniture is not read.
 *
 * `live` is what makes it worth showing: an action from a turn that has FINISHED is history, and
 * history belongs in the panel somebody chose to open, not on the edge of a screen they are
 * reading something else in.
 */
export interface EdgeHint {
  /** The verb, already localized by the caller's own table. */
  kind: 'wrote' | 'read' | 'ran' | 'thought' | 'delegated'
  /** The path or command it names. */
  text: string
}

export function edgeHint(
  { open, events, isMobile }: {
    open: boolean
    events: readonly { kind: EdgeHint['kind']; text: string; live?: boolean }[]
    isMobile: boolean
  },
): EdgeHint | null {
  // On a phone the panel is full-screen; a tab on the edge would be a control promising to cover
  // the conversation somebody is reading.
  if (open || isMobile) return null
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    if (e.live) return { kind: e.kind, text: e.text }
  }
  return null
}


/**
 * The conversation's floor.
 *
 * A chat narrower than this is not a squeezed chat, it is a column of two-word lines with a
 * composer that cannot hold a sentence — at which point the panel has taken the screen and the
 * thing it was opened BESIDE is gone. Reported exactly that way: "ele ta simplesmente pegando TUDO
 * do espaco, o chat nao fica aberto mais."
 */
export const CHAT_MIN_WIDTH = 420

/** Below this the panel is not a panel either — a file view this narrow wraps every line. */
export const PANEL_MIN_WIDTH = 280

/**
 * How wide the panel may actually be, given the room there is.
 *
 * THE STORED WIDTH IS A WISH, NOT A MEASUREMENT. It is remembered from whatever window it was
 * dragged in — 900px on a wide monitor, restored on a laptop where 900 is the whole content area —
 * and `flexShrink: 0` on the panel with `flex: 1` on the conversation means the conversation is the
 * one that gives, all the way to zero. So the request is CLAMPED here rather than trusted, and the
 * clamp is re-applied on every resize: a window narrowed after the fact is the same situation as a
 * window that was always narrow.
 *
 * The conversation's floor wins over the panel's preference, and the panel's own floor wins over
 * both — when even `PANEL_MIN_WIDTH` cannot be given without going under the chat's floor there is
 * no split to be had, which is what `resolveArtifactLayout` already answers with `overlay`.
 */
export function panelWidth(available: number, requested: number): number {
  if (!Number.isFinite(available) || available <= 0) return requested
  const room = available - CHAT_MIN_WIDTH
  if (room < PANEL_MIN_WIDTH) return Math.min(requested, Math.max(PANEL_MIN_WIDTH, room))
  return Math.min(requested, room)
}
