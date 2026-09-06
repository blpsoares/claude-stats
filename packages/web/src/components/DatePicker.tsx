import React, { useState, useRef, useEffect } from 'react'
import { ChevronLeft, ChevronRight, CalendarDays } from 'lucide-react'
import {
  format, parseISO, startOfMonth, addDays, getDay, getDaysInMonth,
  isBefore, isAfter, isSameDay, addMonths, subMonths,
} from 'date-fns'
import { ptBR } from 'date-fns/locale'
import type { Lang } from '@agentistics/core'

interface DatePickerProps {
  value: string
  onChange: (date: string) => void
  label: string
  placeholder: string
  max?: string
  min?: string
  rangeStart?: string
  rangeEnd?: string
  stuck?: boolean
  lang: Lang
  align?: 'left' | 'right'
}

export function DatePicker({
  value, onChange, label, placeholder, max, min,
  rangeStart, rangeEnd, stuck, lang, align = 'left',
}: DatePickerProps) {
  const [open, setOpen] = useState(false)
  const [triggerHovered, setTriggerHovered] = useState(false)
  const [viewDate, setViewDate] = useState<Date>(() => {
    if (value) return parseISO(value)
    return new Date()
  })
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  useEffect(() => {
    if (value) setViewDate(parseISO(value))
  }, [value])

  const today = new Date()
  const maxDate = max ? parseISO(max) : today
  const minDate = min ? parseISO(min) : null

  const firstOfMonth = startOfMonth(viewDate)
  const daysInMonth = getDaysInMonth(viewDate)
  const startWeekday = getDay(firstOfMonth)

  const days: (Date | null)[] = []
  for (let i = 0; i < startWeekday; i++) days.push(null)
  for (let i = 0; i < daysInMonth; i++) days.push(addDays(firstOfMonth, i))

  const selectedDate = value ? parseISO(value) : null
  const rangeStartDate = rangeStart ? parseISO(rangeStart) : null
  const rangeEndDate = rangeEnd ? parseISO(rangeEnd) : null

  const isInRange = (date: Date) => {
    if (!rangeStartDate || !rangeEndDate) return false
    return !isBefore(date, rangeStartDate) && !isAfter(date, rangeEndDate)
  }

  /**
   * A BOUND ON A CALENDAR IS A DAY, NOT AN INSTANT — and this compared a day against one.
   *
   * `maxDate` defaults to `new Date()`, the current moment, while each cell was built at 12:00. So
   * before noon, TODAY's cell was `isAfter` the bound and today could not be picked: the calendar's
   * own "Today" shortcut did nothing, and the newest selectable day was yesterday. Reported as
   * "today continua nao funcionando".
   *
   * Both sides are now taken to the END of their day, so the comparison asks the only question a
   * calendar can answer: is this day after the last allowed day?
   */
  const endOfDayLocal = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999)

  const isDisabled = (date: Date) => {
    const d = endOfDayLocal(date)
    if (isAfter(d, endOfDayLocal(maxDate))) return true
    if (minDate) {
      const md = new Date(minDate.getFullYear(), minDate.getMonth(), minDate.getDate(), 0)
      if (isBefore(d, md)) return true
    }
    return false
  }

  const handleSelect = (date: Date) => {
    if (isDisabled(date)) return
    onChange(format(date, 'yyyy-MM-dd'))
    setOpen(false)
  }

  const canGoNext = !isAfter(startOfMonth(addMonths(viewDate, 1)), maxDate)

  const displayValue = selectedDate ? format(selectedDate, 'dd/MM/yyyy') : ''
  const hasValue = !!value

  const locale = lang === 'pt' ? ptBR : undefined
  const monthLabel = format(viewDate, 'MMMM yyyy', { locale })

  const weekdays = lang === 'pt'
    ? ['D', 'S', 'T', 'Q', 'Q', 'S', 'S']
    : ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

  return (
    <div ref={ref} style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
      <div
        onClick={() => setOpen(o => !o)}
        onMouseEnter={() => setTriggerHovered(true)}
        onMouseLeave={() => setTriggerHovered(false)}
        style={{
          display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer',
          padding: stuck ? '4px 7px' : '6px 9px',
          borderRadius: 6,
          background: open
            ? 'rgba(217,119,6,0.1)'
            : triggerHovered
            ? 'var(--ag-tint-2)'
            : 'transparent',
          transition: 'background 0.12s ease',
        }}
      >
        <span style={{
          fontSize: 9, fontWeight: 700, letterSpacing: '0.07em', flexShrink: 0,
          textTransform: 'uppercase',
          color: hasValue ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
          opacity: hasValue ? 1 : 0.7,
        }}>
          {label}
        </span>
        <span style={{
          fontSize: 12, fontFamily: 'inherit',
          fontWeight: hasValue ? 600 : 400,
          color: hasValue ? 'var(--text-primary)' : 'var(--text-tertiary)',
          minWidth: 68,
        }}>
          {displayValue || placeholder}
        </span>
      </div>

      {open && (
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 10px)',
          [align === 'right' ? 'right' : 'left']: 0,
          zIndex: 9999,
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 14,
          padding: '14px 16px 16px',
          boxShadow: '0 20px 60px rgba(0,0,0,0.45), 0 6px 20px rgba(0,0,0,0.25), inset 0 1px 0 var(--ag-tint-2)',
          width: 256,
          userSelect: 'none',
        }}>
          {/* Month nav */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12,
          }}>
            <button
              onClick={(e) => { e.stopPropagation(); setViewDate(d => subMonths(d, 1)) }}
              style={{
                background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                borderRadius: 7, cursor: 'pointer', color: 'var(--text-secondary)',
                padding: '4px 7px', display: 'flex', alignItems: 'center',
              }}
            >
              <ChevronLeft size={14} />
            </button>
            <span style={{
              fontSize: 13, fontWeight: 700, color: 'var(--text-primary)',
              textTransform: 'capitalize', letterSpacing: '0.01em',
            }}>
              {monthLabel}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); if (canGoNext) setViewDate(d => addMonths(d, 1)) }}
              style={{
                background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                borderRadius: 7, cursor: canGoNext ? 'pointer' : 'not-allowed',
                opacity: canGoNext ? 1 : 0.3,
                color: 'var(--text-secondary)', padding: '4px 7px', display: 'flex', alignItems: 'center',
              }}
            >
              <ChevronRight size={14} />
            </button>
          </div>

          {/* Weekday headers */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, marginBottom: 4 }}>
            {weekdays.map((d, i) => (
              <div key={i} style={{
                textAlign: 'center', fontSize: 10, fontWeight: 700,
                color: 'var(--text-tertiary)', padding: '2px 0',
                letterSpacing: '0.02em',
              }}>
                {d}
              </div>
            ))}
          </div>

          {/* Day cells */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
            {days.map((date, i) => {
              if (!date) return <div key={`e-${i}`} />
              const disabled = isDisabled(date)
              const selected = !!selectedDate && isSameDay(date, selectedDate)
              const inRange = isInRange(date)
              const isToday = isSameDay(date, new Date())

              return (
                <DayButton
                  key={date.getTime()}
                  date={date}
                  disabled={disabled}
                  selected={selected}
                  inRange={inRange}
                  isToday={isToday}
                  onSelect={handleSelect}
                />
              )
            })}
          </div>

          {/* Today shortcut */}
          {!isSameDay(today, selectedDate ?? new Date('1970-01-01')) && (
            <div style={{ marginTop: 10, textAlign: 'center' }}>
              <button
                onClick={() => handleSelect(today)}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  fontSize: 11, color: 'var(--anthropic-orange)', fontFamily: 'inherit',
                  fontWeight: 500, padding: '3px 8px', borderRadius: 6,
                  textDecoration: 'underline', textDecorationColor: 'rgba(217,119,6,0.3)',
                }}
              >
                {lang === 'pt' ? 'Hoje' : 'Today'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function DayButton({ date, disabled, selected, inRange, isToday, onSelect }: {
  date: Date
  disabled: boolean
  selected: boolean
  inRange: boolean
  isToday: boolean
  onSelect: (d: Date) => void
}) {
  const [hovered, setHovered] = useState(false)

  let bg = 'transparent'
  if (selected) bg = 'var(--anthropic-orange)'
  else if (inRange) bg = 'rgba(217,119,6,0.15)'
  else if (hovered && !disabled) bg = 'var(--bg-elevated)'

  let color = 'var(--text-primary)'
  if (selected) color = '#fff'
  else if (inRange || isToday) color = 'var(--anthropic-orange)'
  else if (disabled) color = 'var(--text-tertiary)'

  return (
    <button
      onClick={() => onSelect(date)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: bg,
        border: isToday && !selected ? '1px solid rgba(217,119,6,0.45)' : '1px solid transparent',
        borderRadius: 7,
        color,
        fontSize: 12, fontFamily: 'inherit',
        fontWeight: selected || isToday ? 700 : 400,
        padding: '6px 0',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.28 : 1,
        textAlign: 'center',
        transition: 'background 0.12s ease, color 0.12s ease',
        outline: 'none',
        width: '100%',
      }}
    >
      {format(date, 'd')}
    </button>
  )
}
