import { fmtZoom } from '../../lib/magnifier'

/** EN/PT strings for the magnifier feature, resolved at render like the rest of the app. */
export interface A11yText {
  tab: string
  enable: string
  enableHelp: string
  headerTitle: string
  headerHint: string
  /** Tap-to-open hint on touch, where a tap opens the menu instead of creating a lens. */
  headerTitleMobile: string
  /** The hide/show-all-lenses toggle, beside the header button. Differs by state so the effect is
   *  never something you can only discover by pressing it. */
  hideLenses: string
  showLenses: string
  newLens: string
  lensesHere: string
  noLensesHere: string
  unpinAll: string
  pinAll: string
  removeAllHere: string
  followLens: string
  followOn: string
  followOff: string
  openSettings: string
  zoom: string
  zoomIn: string
  zoomOut: string
  /** The lens's own visible settings-menu button — opens the same menu the right-click does. */
  config: string
  /**
   * A single lens's own accessible name — an ordinal, never the internal `lens-N` id. `global`
   * extends it to say the lens follows every page, for a screen-reader user who cannot see the
   * small marker on its chrome.
   */
  lensLabel(n: number, global?: boolean): string
  /** The LensMenu row that moves a lens into `globalLenses` — worded as what it does. */
  keepOnEveryPage: string
  /** Same row, once the lens already IS global — moves it back to the current page only. */
  keepOnThisPageOnly: string
  /** The settings table's group label for the global bucket, in the same cell a pathname sits in
   *  for a per-page row — it must read as "applies everywhere", never as a path. */
  everyPage: string
  /** The global group's own "remove all" — removes only `globalLenses`, never a page's. */
  removeAllGlobal: string
  shape: string
  circle: string
  rect: string
  width: string
  height: string
  diameter: string
  borderWidth: string
  cornerRadius: string
  pin: string
  unpin: string
  remove: string
  duplicate: string
  select: string
  newLensDefaults: string
  savedLenses: string
  page: string
  count: string
  goToPage: string
  performance: string
  canvasCaveat: string
  schedulerNote: string
  currentInterval(ms: number): string
  borderIsOrange: string
  keyboardTitle: string
  keyboardHelp: string[]
  removed: string
  lensReleased: string
  announce(name: string, zoom: number, w: number, h: number, x: number, y: number, pinned: boolean): string
}

export function a11yText(lang: 'pt' | 'en'): A11yText {
  const pt = lang === 'pt'
  return {
    tab: pt ? 'Acessibilidade' : 'Accessibility',
    enable: pt ? 'Ativar lupas' : 'Enable magnifiers',
    enableHelp: pt
      ? 'Com isto desligado nada é criado nem observado: o custo é zero.'
      : 'With this off nothing is created and nothing is observed: the cost is zero.',
    headerTitle: pt ? 'Lupas' : 'Magnifiers',
    headerHint: pt
      ? 'Clique para criar uma lupa · botão direito para o menu'
      : 'Click to create a lens · right-click for the menu',
    headerTitleMobile: pt ? 'Toque para abrir o menu de lupas' : 'Tap to open the magnifiers menu',
    hideLenses: pt ? 'Ocultar lupas desta página' : 'Hide lenses on this page',
    showLenses: pt ? 'Mostrar lupas desta página' : 'Show lenses on this page',
    newLens: pt ? 'Nova lupa' : 'New lens',
    lensesHere: pt ? 'Lupas desta página' : 'Lenses on this page',
    noLensesHere: pt ? 'Nenhuma lupa nesta página.' : 'No lenses on this page.',
    unpinAll: pt ? 'Destravar todas' : 'Unpin all',
    pinAll: pt ? 'Fixar todas' : 'Pin all',
    removeAllHere: pt ? 'Remover todas desta página' : 'Remove all on this page',
    followLens: pt ? 'Lupa que segue o cursor' : 'Cursor-following lens',
    followOn: pt ? 'Ligar (Ctrl+Shift+Z)' : 'Turn on (Ctrl+Shift+Z)',
    followOff: pt ? 'Desligar (Ctrl+Shift+Z)' : 'Turn off (Ctrl+Shift+Z)',
    openSettings: pt ? 'Configurações de acessibilidade' : 'Accessibility settings',
    zoom: pt ? 'Ampliação' : 'Zoom',
    zoomIn: pt ? 'Aproximar' : 'Zoom in',
    zoomOut: pt ? 'Afastar' : 'Zoom out',
    config: pt ? 'Configurações da lupa' : 'Lens settings',
    lensLabel: (n, global) => {
      const base = pt ? `Lupa ${n}` : `Lens ${n}`
      if (!global) return base
      return pt ? `${base}, presente em todas as páginas` : `${base}, present on every page`
    },
    keepOnEveryPage: pt ? 'Manter esta lupa em todas as páginas' : 'Keep this lens on every page',
    keepOnThisPageOnly: pt ? 'Manter esta lupa só nesta página' : 'Keep this lens on this page only',
    everyPage: pt ? 'Todas as páginas' : 'Every page',
    removeAllGlobal: pt ? 'Remover todas as lupas globais' : 'Remove all global lenses',
    shape: pt ? 'Formato' : 'Shape',
    circle: pt ? 'Círculo' : 'Circle',
    rect: pt ? 'Retângulo' : 'Rectangle',
    width: pt ? 'Largura' : 'Width',
    height: pt ? 'Altura' : 'Height',
    diameter: pt ? 'Diâmetro' : 'Diameter',
    borderWidth: pt ? 'Espessura da borda' : 'Border thickness',
    cornerRadius: pt ? 'Raio do canto' : 'Corner radius',
    pin: pt ? 'Fixar' : 'Pin',
    unpin: pt ? 'Destravar' : 'Unpin',
    remove: pt ? 'Remover' : 'Remove',
    duplicate: pt ? 'Duplicar' : 'Duplicate',
    select: pt ? 'Selecionar' : 'Select',
    newLensDefaults: pt ? 'Padrões para lupas novas' : 'Defaults for new lenses',
    savedLenses: pt ? 'Lupas salvas' : 'Saved lenses',
    page: pt ? 'Página' : 'Page',
    count: pt ? 'Quantas' : 'How many',
    goToPage: pt ? 'Ir para a página' : 'Go to that page',
    performance: pt ? 'Desempenho e limites' : 'Performance and limits',
    canvasCaveat: pt
      ? 'Conteúdo desenhado em <canvas> ou WebGL — o terminal de sessões — pode não ser copiável. Onde não for, a lupa mostra a área vazia em vez de mostrar uma imagem velha.'
      : 'Content drawn on a <canvas> or in WebGL — the session terminal — may not be copyable. Where it is not, the lens shows that area empty rather than showing a stale image.',
    schedulerNote: pt
      ? 'O espelho ressincroniza no máximo duas lupas por quadro e recua sozinho se um ciclo custar caro demais — por isso não há limite de lupas.'
      : 'The mirror re-syncs at most two lenses per frame and backs off on its own when a cycle costs too much — which is why there is no lens limit.',
    currentInterval: ms =>
      pt
        ? `Intervalo atual do espelho: ${ms} ms.`
        : `Current mirror interval: ${ms} ms.`,
    borderIsOrange: pt
      ? 'A borda é sempre o laranja do site. A espessura e o formato são seus; a cor é do produto.'
      : 'The border is always the site orange. Thickness and shape are yours; the colour is the product’s.',
    keyboardTitle: pt ? 'Teclado' : 'Keyboard',
    keyboardHelp: pt
      ? [
          'Ctrl+Shift+M — selecionar a primeira lupa da página',
          'Setas — mover 10 px · Alt+setas — mover 1 px',
          'Shift+setas — redimensionar',
          '+ / − — ampliação',
          'P — fixar ou destravar · Delete — remover',
          'Tab — próxima lupa (inclui as fixadas) · Esc — soltar',
          'Ctrl+Shift+Z — lupa que segue o cursor',
        ]
      : [
          'Ctrl+Shift+M — select the first lens on this page',
          'Arrows — move 10 px · Alt+arrows — move 1 px',
          'Shift+arrows — resize',
          '+ / − — zoom',
          'P — pin or unpin · Delete — remove',
          'Tab — next lens (pinned ones included) · Esc — release',
          'Ctrl+Shift+Z — cursor-following lens',
        ],
    removed: pt ? 'Lupa removida.' : 'Lens removed.',
    lensReleased: pt ? 'Lupa solta.' : 'Lens released.',
    // `fmtZoom` rounds to 2 decimals — a screen reader is exactly where a raw binary-float zoom
    // (0.05-stepped values can leave e.g. `0.6499999999999999`) would be read out loud verbatim.
    announce: (name, zoom, w, h, x, y, pinned) =>
      pt
        ? `${name}, ampliação ${fmtZoom(zoom)} vezes, ${Math.round(w)} por ${Math.round(h)}, em ${Math.round(x)} por ${Math.round(y)}, ${pinned ? 'fixada' : 'solta'}.`
        : `${name}, zoom ${fmtZoom(zoom)} times, ${Math.round(w)} by ${Math.round(h)}, at ${Math.round(x)} by ${Math.round(y)}, ${pinned ? 'pinned' : 'unpinned'}.`,
  }
}
