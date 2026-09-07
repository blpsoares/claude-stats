import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Search, X, Check } from 'lucide-react'
import { formatProjectName } from '@agentistics/core'
import { useIsMobile } from '../hooks/useIsMobile'
import { OVERLAY_TOP } from '../lib/mobileOverlay'

interface Props {
  projects: { path: string; sessions: { sessionId: string; created: string }[] }[]
  sessionCountByProject: Record<string, number>
  selected: string[]
  onApply: (paths: string[]) => void
  onClose: () => void
  lang: 'pt' | 'en'
}


const T = {
  pt: {
    search: 'Buscar projeto...',
    selectAll: 'Selecionar tudo',
    clearAll: 'Limpar',
    apply: 'Aplicar',
    cancel: 'Cancelar',
    perPage: 'por página',
    showing: 'Exibindo',
    of: 'de',
    noResults: 'Nenhum projeto encontrado',
    title: 'Selecionar Projetos',
    sessions: 'sessões',
  },
  en: {
    search: 'Search project...',
    selectAll: 'Select all',
    clearAll: 'Clear all',
    apply: 'Apply',
    cancel: 'Cancel',
    perPage: 'per page',
    showing: 'Showing',
    of: 'of',
    noResults: 'No projects found',
    title: 'Select Projects',
    sessions: 'sessions',
  },
} as const

const PER_PAGE_OPTIONS = [15, 25, 50]

export function ProjectsModal({ projects, sessionCountByProject, selected, onApply, onClose, lang }: Props) {
  const t = T[lang]
  const isMobile = useIsMobile()
  const searchRef = useRef<HTMLInputElement>(null)

  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<Set<string>>(new Set(selected))
  const [page, setPage] = useState(1)
  const [perPage, setPerPage] = useState(15)

  // Focus search on mount
  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  // ESC closes modal
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const filtered = projects.filter(p =>
    p.path.toLowerCase().includes(query.toLowerCase())
  )

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage))
  const safePage = Math.min(page, totalPages)
  const pageStart = (safePage - 1) * perPage
  const pageEnd = Math.min(pageStart + perPage, filtered.length)
  const visible = filtered.slice(pageStart, pageEnd)

  const filteredPaths = filtered.map(p => p.path)

  function toggleItem(path: string) {
    setDraft(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  function selectAllFiltered() {
    setDraft(prev => {
      const next = new Set(prev)
      filteredPaths.forEach(p => next.add(p))
      return next
    })
  }

  function clearAllFiltered() {
    setDraft(prev => {
      const next = new Set(prev)
      filteredPaths.forEach(p => next.delete(p))
      return next
    })
  }

  function handleQueryChange(e: React.ChangeEvent<HTMLInputElement>) {
    setQuery(e.target.value)
    setPage(1)
  }

  function handlePerPageChange(e: React.ChangeEvent<HTMLSelectElement>) {
    setPerPage(Number(e.target.value))
    setPage(1)
  }

  const showFrom = filtered.length === 0 ? 0 : pageStart + 1
  const showTo = pageEnd

  // Styles
  const overlayStyle: React.CSSProperties = {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.6)',
    backdropFilter: 'blur(4px)',
    WebkitBackdropFilter: 'blur(4px)',
    zIndex: 500,
    display: 'flex',
    alignItems: isMobile ? 'stretch' : 'center',
    justifyContent: 'center',
    padding: isMobile ? OVERLAY_TOP : '16px',
  }

  const modalStyle: React.CSSProperties = {
    background: 'var(--bg-card)',
    border: isMobile ? 'none' : '1px solid var(--border)',
    borderRadius: isMobile ? 0 : 'var(--radius-lg, 12px)',
    width: '100%',
    maxWidth: isMobile ? '100%' : 560,
    height: isMobile ? '100%' : undefined,
    maxHeight: isMobile ? '100%' : '80vh',
    display: 'flex',
    flexDirection: 'column',
    boxShadow: isMobile ? 'none' : '0 24px 64px rgba(0,0,0,0.5)',
    overflow: 'hidden',
  }

  const inputStyle: React.CSSProperties = {
    flex: 1,
    background: 'transparent',
    border: 'none',
    outline: 'none',
    color: 'var(--text-primary)',
    fontSize: 13,
    fontFamily: 'inherit',
    padding: 0,
  }

  const smallBtnStyle = (active?: boolean): React.CSSProperties => ({
    padding: '5px 10px',
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: active ? 'var(--anthropic-orange-dim, rgba(205,93,56,0.12))' : 'var(--bg-elevated)',
    color: active ? 'var(--anthropic-orange, #cd5d38)' : 'var(--text-secondary)',
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'all 0.15s',
  })

  const pageBtnStyle = (disabled: boolean): React.CSSProperties => ({
    padding: '4px 10px',
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'var(--bg-elevated)',
    color: disabled ? 'var(--text-tertiary)' : 'var(--text-secondary)',
    fontSize: 12,
    cursor: disabled ? 'default' : 'pointer',
    fontFamily: 'inherit',
    opacity: disabled ? 0.5 : 1,
  })

  return createPortal(
    <div style={overlayStyle} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={modalStyle}>

        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '16px 20px',
          borderBottom: '1px solid var(--border)',
        }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
            {t.title}
          </span>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--text-tertiary)',
              display: 'flex',
              alignItems: 'center',
              padding: 4,
              borderRadius: 6,
            }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Search + toolbar */}
        <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* Search input */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '8px 12px',
          }}>
            <Search size={14} color="var(--text-tertiary)" />
            <input
              ref={searchRef}
              value={query}
              onChange={handleQueryChange}
              placeholder={t.search}
              style={inputStyle}
            />
            {query && (
              <button
                onClick={() => { setQuery(''); setPage(1) }}
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', display: 'flex', padding: 0 }}
              >
                <X size={13} />
              </button>
            )}
          </div>

          {/* Selected chips */}
          {draft.size > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {Array.from(draft).map(path => (
                <div
                  key={path}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    padding: '3px 8px 3px 10px',
                    borderRadius: 20,
                    background: 'var(--anthropic-orange-dim, rgba(205,93,56,0.12))',
                    border: '1px solid rgba(205,93,56,0.35)',
                    fontSize: 11,
                    fontWeight: 500,
                    color: 'var(--anthropic-orange, #cd5d38)',
                    maxWidth: 220,
                  }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {formatProjectName(path)}
                  </span>
                  <button
                    onClick={() => toggleItem(path)}
                    style={{
                      background: 'transparent', border: 'none', cursor: 'pointer',
                      padding: 0, display: 'flex', alignItems: 'center',
                      color: 'var(--anthropic-orange, #cd5d38)', flexShrink: 0,
                      opacity: 0.7,
                    }}
                    onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.opacity = '1' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.opacity = '0.7' }}
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Select all / Clear all */}
          <div style={{ display: 'flex', gap: 6 }}>
            <button style={smallBtnStyle()} onClick={selectAllFiltered}>
              {t.selectAll}
            </button>
            <button style={smallBtnStyle()} onClick={clearAllFiltered}>
              {t.clearAll}
            </button>
          </div>
        </div>

        {/* Project list */}
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {visible.length === 0 ? (
            <div style={{
              padding: '32px 20px',
              textAlign: 'center',
              color: 'var(--text-tertiary)',
              fontSize: 13,
            }}>
              {t.noResults}
            </div>
          ) : (
            visible.map(project => {
              const isSelected = draft.has(project.path)
              return (
                <div
                  key={project.path}
                  onClick={() => toggleItem(project.path)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '10px 20px',
                    cursor: 'pointer',
                    background: isSelected ? 'var(--anthropic-orange-dim, rgba(205,93,56,0.07))' : 'transparent',
                    borderLeft: isSelected ? '2px solid var(--anthropic-orange, #cd5d38)' : '2px solid transparent',
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={e => {
                    if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = 'var(--bg-elevated)'
                  }}
                  onMouseLeave={e => {
                    if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = 'transparent'
                  }}
                >
                  {/* Checkbox */}
                  <div style={{
                    width: 16,
                    height: 16,
                    borderRadius: 4,
                    border: isSelected ? '1.5px solid var(--anthropic-orange, #cd5d38)' : '1.5px solid var(--border)',
                    background: isSelected ? 'var(--anthropic-orange, #cd5d38)' : 'transparent',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    transition: 'all 0.15s',
                  }}>
                    {isSelected && <Check size={11} color="#fff" strokeWidth={3} />}
                  </div>

                  {/* Labels */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 13,
                      fontWeight: 500,
                      color: isSelected ? 'var(--text-primary)' : 'var(--text-primary)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}>
                      {formatProjectName(project.path)}
                    </div>
                    <div style={{
                      fontSize: 11,
                      color: 'var(--text-tertiary)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      marginTop: 1,
                    }}>
                      {project.path}
                    </div>
                  </div>

                  {/* Session count badge */}
                  <div style={{
                    flexShrink: 0,
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border)',
                    borderRadius: 20,
                    padding: '2px 8px',
                    fontSize: 11,
                    color: 'var(--text-secondary)',
                    whiteSpace: 'nowrap',
                  }}>
                    {sessionCountByProject[project.path] ?? project.sessions.length} {t.sessions}
                  </div>
                </div>
              )
            })
          )}
        </div>

        {/* Pagination + footer */}
        <div style={{
          padding: '12px 20px',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
        }}>
          {/* Showing X-Y of Z */}
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)', flex: 1 }}>
            {t.showing} {showFrom}–{showTo} {t.of} {filtered.length}
          </span>

          {/* Page buttons */}
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <button
              disabled={safePage <= 1}
              onClick={() => setPage(p => Math.max(1, p - 1))}
              style={pageBtnStyle(safePage <= 1)}
            >
              ‹
            </button>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)', minWidth: 60, textAlign: 'center' }}>
              {safePage} / {totalPages}
            </span>
            <button
              disabled={safePage >= totalPages}
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              style={pageBtnStyle(safePage >= totalPages)}
            >
              ›
            </button>
          </div>

          {/* Per-page selector */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <select
              value={perPage}
              onChange={handlePerPageChange}
              style={{
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                color: 'var(--text-secondary)',
                fontSize: 12,
                fontFamily: 'inherit',
                padding: '4px 8px',
                cursor: 'pointer',
                outline: 'none',
              }}
            >
              {PER_PAGE_OPTIONS.map(n => (
                <option key={n} value={n} style={{ background: 'var(--bg-elevated)' }}>{n}</option>
              ))}
            </select>
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{t.perPage}</span>
          </div>
        </div>

        {/* Action buttons */}
        <div style={{
          padding: '12px 20px',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 8,
        }}>
          <button
            onClick={onClose}
            style={{
              padding: '8px 18px',
              borderRadius: 8,
              border: '1px solid var(--border)',
              background: 'transparent',
              color: 'var(--text-secondary)',
              fontSize: 13,
              fontWeight: 500,
              cursor: 'pointer',
              fontFamily: 'inherit',
              transition: 'all 0.15s',
            }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-primary)'
              ;(e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--text-tertiary)'
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-secondary)'
              ;(e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'
            }}
          >
            {t.cancel}
          </button>
          <button
            onClick={() => onApply(Array.from(draft))}
            style={{
              padding: '8px 18px',
              borderRadius: 8,
              border: '1px solid var(--anthropic-orange, #cd5d38)',
              background: 'var(--anthropic-orange, #cd5d38)',
              color: '#fff',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
              transition: 'all 0.15s',
            }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLButtonElement).style.opacity = '0.85'
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLButtonElement).style.opacity = '1'
            }}
          >
            {t.apply}
          </button>
        </div>

      </div>
    </div>,
    document.body
  )
}
