import React, { useState, useMemo, useRef, useEffect } from 'react'
import { useOutletContext } from 'react-router-dom'
import { FileDown, Download, Sun, Moon, Check, Filter } from 'lucide-react'
import { format } from 'date-fns'
import type { AppContext } from '../lib/app-context'
import type { Filters } from '@agentistics/core'
import { t, fmt } from '@agentistics/core'
import { useDerivedStats, blendedCostPerToken, computeFilteredHarnessSummaries } from '../hooks/useData'
import { useIsMobile } from '../hooks/useIsMobile'
import {
  runPDFCapture, PDFContent, COLORS, SECTIONS, DATE_OPTIONS,
} from '../components/PDFExportModal'
import type { PDFTheme, SectionId, ChartMetric } from '../components/PDFExportModal'

// Config group helpers

/** A titled, bordered group card used to divide the options bar into clear sections. */
function OptionsGroup({ title, headerRight, children, grow }: {
  title: string; headerRight?: React.ReactNode; children: React.ReactNode; grow?: boolean
}) {
  return (
    <div style={{
      flex: grow ? '1 1 320px' : '0 0 auto',
      minWidth: grow ? 260 : undefined,
      background: 'var(--bg-elevated)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)',
      padding: '14px 16px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 12 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          {title}
        </div>
        {headerRight}
      </div>
      {children}
    </div>
  )
}

// Export Page

export default function ExportPage() {
  const { data, lang, currency, brlRate, filters: appFilters } = useOutletContext<AppContext>()
  const pt = lang === 'pt'
  const isMobile = useIsMobile()

  // PDF options
  const [pdfTheme, setPdfTheme] = useState<PDFTheme>(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  )
  const [sectionOrder, setSectionOrder] = useState<SectionId[]>(
    ['summary', 'activity', 'heatmap', 'hours', 'models', 'projects', 'tools']
  )
  const [chartMetric, setChartMetric] = useState<ChartMetric>('messages')
  const [chartOverlay, setChartOverlay] = useState<ChartMetric | null>(null)
  const [chartOverlayAll, setChartOverlayAll] = useState(false)

  // Export state
  const [exporting, setExporting] = useState(false)
  const [exportSuccess, setExportSuccess] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)

  // Logo prefetch (same as modal — html2canvas needs base64 data URI)
  const [logoDataUri, setLogoDataUri] = useState('/logo.png')
  useEffect(() => {
    fetch('/logo.png')
      .then(r => r.blob())
      .then(blob => new Promise<string>(resolve => {
        const reader = new FileReader()
        reader.onloadend = () => resolve(reader.result as string)
        reader.readAsDataURL(blob)
      }))
      .then(setLogoDataUri)
      .catch(() => {})
  }, [])

  // Whether the "Comparação" section is even offered (needs >1 harness in the data)
  const compareAvailable = data.harnesses.length > 1

  // pdfFilters = the GLOBAL header filters as-is, including any harness selection
  // already applied there. This is the single source of truth for what goes into
  // the PDF — the page no longer keeps its own date/project/model/member/harness
  // selection; harness scoping is entirely owned by the header. EVERY data source
  // below (derived stats AND the compare section) is fed from this same value.
  const pdfFilters: Filters = appFilters

  // Derive stats for the unified report — drives all non-compare sections.
  const derived = useDerivedStats(data, pdfFilters)

  // Compare section data — scoped by the SAME global filters as the rest of the report
  // (date/projects/models/members/harnesses), via the function shared with the Compare
  // page, so the "Comparação" section never shows unfiltered data.
  const { activeHarnesses: compareHarnesses, summaries: compareSummaries } = useMemo(
    () => computeFilteredHarnessSummaries(data, pdfFilters),
    [data, pdfFilters],
  )

  // Blended rates for per-session cost fallback in PDFContent
  const blendedRates = useMemo(
    () => blendedCostPerToken(derived?.modelUsage ?? data.statsCache.modelUsage ?? {}),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [derived?.modelUsage, data.statsCache.modelUsage]
  )

  const pdfFilename = useMemo(() => {
    const dateStr = format(new Date(), 'yyyy-MM-dd')
    return `agentistics-stats-${dateStr}.pdf`
  }, [])

  // Human-readable summary of the header filters that scope this report — shown as
  // a hint so it's clear the page no longer owns its own date/project/model picker.
  const filterSummary = useMemo(() => {
    const parts: string[] = []
    if (appFilters.customStart || appFilters.customEnd) {
      const s = appFilters.customStart ? format(new Date(appFilters.customStart), 'dd/MM/yy') : '…'
      const e = appFilters.customEnd ? format(new Date(appFilters.customEnd), 'dd/MM/yy') : '…'
      parts.push(`${s} – ${e}`)
    } else {
      const opt = DATE_OPTIONS.find(o => o.value === appFilters.dateRange)
      parts.push(opt ? (pt ? opt.labelPt : opt.labelEn) : t('export.filters.allTime', lang))
    }
    if (appFilters.projects.length > 0) parts.push(`${appFilters.projects.length} ${t('export.filters.projects', lang)}`)
    if (appFilters.models.length > 0) parts.push(`${appFilters.models.length} ${t('export.filters.models', lang)}`)
    if ((appFilters.users?.length ?? 0) > 0) parts.push(`${appFilters.users!.length} ${t('export.filters.members', lang)}`)
    if ((appFilters.harnesses?.length ?? 0) > 0) parts.push(`${appFilters.harnesses!.length} ${t('export.filters.harnesses', lang)}`)
    return parts.join(' · ')
  }, [appFilters, lang, pt])

  // Section list offered to the user — "compare" is hidden entirely when there's
  // only one harness in the data (nothing to compare).
  const availableSections = useMemo(
    () => compareAvailable ? SECTIONS : SECTIONS.filter(s => s.id !== 'compare'),
    [compareAvailable],
  )
  const allSelected = sectionOrder.length === availableSections.length
  const toggleSection = (id: SectionId) =>
    setSectionOrder(prev => prev.includes(id) ? prev.filter(s => s !== id) : [...prev, id])
  const toggleAll = () =>
    setSectionOrder(allSelected ? [] : availableSections.map(s => s.id))

  const canExport = sectionOrder.length > 0

  const handleExport = async () => {
    if (!contentRef.current || exporting) return
    setExporting(true)
    try {
      await runPDFCapture(contentRef.current, pdfTheme, pdfFilename)
      setExportSuccess(true)
      setTimeout(() => setExportSuccess(false), 2500)
    } catch (err) {
      console.error('PDF export failed:', err)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Page header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{
          width: 36, height: 36, borderRadius: 10,
          background: 'var(--anthropic-orange-dim)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <FileDown size={17} color="var(--anthropic-orange)" />
        </div>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>
            {t('export.title', lang)}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
            {t('export.subtitle', lang)}
          </div>
        </div>
      </div>

      {/* Filters hint — the report is scoped by the GLOBAL header filters, not by
          anything on this page (only PDF-specific config lives here). */}
      <div style={{
        display: 'flex', alignItems: 'flex-start', gap: 10,
        padding: '10px 14px', borderRadius: 'var(--radius-lg)',
        background: 'var(--anthropic-orange-dim)', border: '1px solid var(--anthropic-orange)30',
      }}>
        <Filter size={15} color="var(--anthropic-orange)" style={{ flexShrink: 0, marginTop: 1 }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--anthropic-orange)' }}>
            {t('export.usesHeaderFilters', lang)}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            {t('export.usesHeaderFiltersDetail', lang)}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 3 }}>
            {t('export.activeFilters', lang)}: {filterSummary || t('export.filters.none', lang)}
          </div>
        </div>
      </div>

      {/*  Options bar: well-divided groups, wraps on small widths  */}
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 14,
        background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)', padding: '18px',
        boxSizing: 'border-box',
      }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'stretch' }}>

          {/* Group: PDF theme */}
          <OptionsGroup title={t('export.pdf.theme', lang)}>
            <div style={{ display: 'flex', gap: 8 }}>
              {(['light', 'dark'] as PDFTheme[]).map(thm => {
                const sel = pdfTheme === thm
                return (
                  <button key={thm} onClick={() => setPdfTheme(thm)} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                    padding: '9px 14px', borderRadius: 8, cursor: 'pointer',
                    fontFamily: 'inherit', fontSize: 12, fontWeight: 600,
                    background: thm === 'light' ? '#f9fafb' : '#181b24',
                    color: thm === 'light' ? '#374151' : '#e8eaf0',
                    border: sel ? `2px solid var(--anthropic-orange)` : `1px solid ${thm === 'light' ? '#d1d5db' : '#374151'}`,
                    transition: 'all 0.12s',
                  }}>
                    {thm === 'light' ? <Sun size={13} color="#6b7280" /> : <Moon size={13} color="#94a3b8" />}
                    {thm === 'light' ? t('nav.light', lang) : t('nav.dark', lang)}
                    {sel && <Check size={11} color="var(--anthropic-orange)" />}
                  </button>
                )
              })}
            </div>
          </OptionsGroup>

          {/* Group: sections (incl. the "Comparação" section, when available) */}
          <OptionsGroup
            title={t('export.pdf.sections', lang)}
            grow
            headerRight={
              <button onClick={toggleAll} style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                fontSize: 10, color: 'var(--text-tertiary)', fontFamily: 'inherit', padding: 0,
              }}>
                {allSelected ? t('export.deselectAll', lang) : t('export.selectAll', lang)}
              </button>
            }
          >
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {availableSections.map(({ id, labelPt, labelEn, Icon }) => {
                const on = sectionOrder.includes(id)
                return (
                  <button key={id} onClick={() => toggleSection(id)} style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '7px 10px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
                    background: on ? 'var(--anthropic-orange-dim)' : 'var(--bg-card)',
                    border: on ? '1.5px solid var(--anthropic-orange)70' : '1px solid var(--border)',
                    transition: 'all 0.13s',
                  }}>
                    <Icon size={14} color={on ? 'var(--anthropic-orange)' : 'var(--text-tertiary)'} strokeWidth={on ? 2.2 : 1.8} />
                    <span style={{ fontSize: 11, color: on ? 'var(--anthropic-orange)' : 'var(--text-secondary)', fontWeight: on ? 700 : 400 }}>
                      {pt ? labelPt : labelEn}
                    </span>
                  </button>
                )
              })}
            </div>
          </OptionsGroup>

          {/* Group: export action */}
          <div style={{
            flex: '0 0 auto', display: 'flex', flexDirection: 'column', justifyContent: 'center',
            alignItems: 'center', gap: 6, padding: '14px 20px',
            background: 'var(--bg-elevated)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-lg)', minWidth: 180,
          }}>
            <button
              onClick={handleExport}
              disabled={exporting || !canExport}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                padding: '11px 22px', borderRadius: 10, border: 'none', width: '100%',
                cursor: !canExport ? 'not-allowed' : 'pointer',
                background: exportSuccess ? '#10b981' : !canExport ? 'var(--bg-card)' : 'var(--anthropic-orange)',
                color: (exportSuccess || canExport) ? '#fff' : 'var(--text-tertiary)',
                fontSize: 13, fontWeight: 700, fontFamily: 'inherit', whiteSpace: 'nowrap',
                transition: 'all 0.2s', opacity: exporting ? 0.8 : 1,
              }}
            >
              {exporting ? (
                <>
                  <div style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid var(--ag-tint-strong)', borderTopColor: '#fff', animation: 'spin 0.7s linear infinite' }} />
                  {t('export.generating', lang)}
                </>
              ) : exportSuccess ? (
                <><Check size={14} /> {t('export.saved', lang)}</>
              ) : (
                <><Download size={14} /> {t('export.download', lang)}</>
              )}
            </button>
            {!canExport && (
              <div style={{ fontSize: 10, color: 'var(--text-tertiary)', textAlign: 'center' }}>
                {t('export.noSections', lang)}
              </div>
            )}
            {canExport && derived && (
              <div style={{ fontSize: 10, color: 'var(--text-tertiary)', textAlign: 'center' }}>
                {fmt(derived.totalMessages)} {t('export.msgs', lang)} · {fmt(derived.totalSessions)} {t('compare.sessionsLower', lang)}
              </div>
            )}
          </div>
        </div>

        {/* Group: activity chart config — its own full-width row, only relevant
            when the Activity section is selected. Given proper sizing/spacing so
            the primary-line and overlay pickers read as two clear sub-groups. */}
        {sectionOrder.includes('activity') && (
          <OptionsGroup title={t('export.activityChart', lang)}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: isMobile ? 16 : 32, alignItems: 'flex-start' }}>
              <div style={{ flex: isMobile ? '1 1 100%' : '0 0 auto' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8 }}>
                  {t('export.primaryLine', lang)}
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {(['messages', 'sessions', 'tools'] as ChartMetric[]).map(m => {
                    const chartLabels: Record<ChartMetric, string> = {
                      messages: t('export.chart.messages', lang),
                      sessions: t('export.chart.sessions', lang),
                      tools: t('export.chart.tools', lang),
                    }
                    const dotColors: Record<ChartMetric, string> = {
                      messages: 'var(--anthropic-orange)',
                      sessions: '#60a5fa',
                      tools: '#34d399',
                    }
                    const sel = chartMetric === m
                    return (
                      <button key={m} onClick={() => { setChartMetric(m); if (chartOverlay === m) setChartOverlay(null) }} style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                        padding: '8px 14px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
                        fontSize: 12, fontWeight: sel ? 700 : 500,
                        background: sel ? 'var(--anthropic-orange-dim)' : 'var(--bg-card)',
                        border: sel ? '1px solid var(--anthropic-orange)50' : '1px solid var(--border)',
                        color: sel ? 'var(--anthropic-orange)' : 'var(--text-secondary)',
                        transition: 'all 0.12s',
                      }}>
                        <div style={{ width: 7, height: 7, borderRadius: '50%', background: dotColors[m], flexShrink: 0 }} />
                        {chartLabels[m]}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div style={{ width: 1, alignSelf: 'stretch', background: 'var(--border)', display: isMobile ? 'none' : 'block' }} />

              <div style={{ flex: isMobile ? '1 1 100%' : '0 0 auto' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8 }}>
                  {t('export.overlay', lang)}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  <button onClick={() => { setChartOverlayAll(v => !v); setChartOverlay(null) }} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                    padding: '8px 14px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
                    fontSize: 12, fontWeight: chartOverlayAll ? 700 : 500,
                    background: chartOverlayAll ? '#8b5cf620' : 'var(--bg-card)',
                    border: chartOverlayAll ? '1px solid #8b5cf660' : '1px solid var(--border)',
                    color: chartOverlayAll ? '#a78bfa' : 'var(--text-secondary)',
                    transition: 'all 0.12s',
                  }}>
                    {t('export.overlayAll', lang)}
                  </button>
                  {!chartOverlayAll && ([null, 'messages', 'sessions', 'tools'] as (ChartMetric | null)[])
                    .filter(m => m !== chartMetric)
                    .map(m => {
                      const chartLabels: Record<string, string> = {
                        messages: t('export.chart.messages_abbr', lang),
                        sessions: t('export.chart.sessions_abbr', lang),
                        tools: t('export.chart.tools_abbr', lang),
                      }
                      const dotColors: Record<string, string> = {
                        messages: 'var(--anthropic-orange)',
                        sessions: '#60a5fa',
                        tools: '#34d399',
                      }
                      const sel = chartOverlay === m
                      return (
                        <button key={String(m)} onClick={() => setChartOverlay(m)} style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                          padding: '8px 14px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
                          fontSize: 12, fontWeight: sel ? 700 : 500,
                          background: sel ? 'var(--bg-card)' : 'transparent',
                          border: '1px solid var(--border)',
                          color: sel ? 'var(--text-primary)' : 'var(--text-secondary)',
                          opacity: m === null && !sel ? 0.6 : 1,
                          transition: 'all 0.12s',
                        }}>
                          {m ? (
                            <>
                              <div style={{ width: 7, height: 7, borderRadius: '50%', background: dotColors[m]!, flexShrink: 0 }} />
                              {chartLabels[m]}
                            </>
                          ) : t('export.none', lang)}
                        </button>
                      )
                    })}
                </div>
              </div>
            </div>
          </OptionsGroup>
        )}
      </div>

      {/*  Live preview — full width, below the options bar  */}
      <div style={{
        background: 'var(--bg-base)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        minHeight: isMobile ? 400 : 600,
      }}>
        {/* Preview bar */}
        <div style={{
          padding: '8px 20px', borderBottom: '1px solid var(--border)', flexShrink: 0,
          display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg-surface)',
        }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent-green)', flexShrink: 0 }} />
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
            {t('export.preview', lang)}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginLeft: 'auto' }}>
            {sectionOrder.length} {t('export.sections', lang)}
          </div>
        </div>

        {/* Preview content — horizontally scrollable on mobile for A4 width */}
        <div style={{ padding: isMobile ? 12 : 24, display: 'flex', justifyContent: 'center', overflowX: 'auto', overflowY: 'auto', flex: 1 }}>
          <div
            ref={contentRef}
            style={{
              boxShadow: '0 4px 32px rgba(0,0,0,0.3)',
              borderRadius: 4,
              overflow: 'hidden',
              flexShrink: 0,
              alignSelf: 'flex-start',
              background: COLORS[pdfTheme].bg,
            }}
          >
            <PDFContent
              pdfTheme={pdfTheme}
              sectionOrder={sectionOrder}
              derived={derived}
              pdfFilters={pdfFilters}
              lang={lang}
              currency={currency}
              brlRate={brlRate}
              blendedRates={blendedRates}
              chartMetric={chartMetric}
              chartOverlay={chartOverlay}
              chartOverlayAll={chartOverlayAll}
              logoDataUri={logoDataUri}
              compareSummaries={compareSummaries}
              compareHarnesses={compareHarnesses}
            />
          </div>
        </div>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
