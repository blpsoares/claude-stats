/**
 * Backup — configure, run, and watch a backup, in the same cockpit grammar as Services.
 *
 * A band of two panes (harnesses, config) over a full-width detail pane, exactly like
 * `cockpitLayout` draws for the Services tab — because the relationship is the same one: the
 * harnesses list and the config pane are the selection, and the detail pane is a fuller view of
 * the same facts, or the place a running backup streams into.
 *
 * The tab owns no decisions. Every number on screen — which harnesses ride the next backup, their
 * sessions and sizes, the schedule and whether it can actually fire, the retained total, the
 * secrets count — is already decided by the host, which calls the same engine `agentop backup`
 * does (`cli-backup.ts`'s `performBackup`, `backup-store.ts`, `schedule.ts`). This file only lays
 * it out and reports intents: `b` runs a backup, `space` toggles the focused harness, `s` cycles
 * the schedule, `esc` returns the detail pane to the facts.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { truncate } from '../../components/Primitives'
import { COLORS } from '../../theme'
import { ConfigLine } from '../Chrome'
import { Pane, paneBody, paneRows } from '../Pane'
import {
  backupConfigRows,
  backupDetailLines,
  backupHints,
  harnessCells,
  harnessDetailLines,
  harnessRows,
  nextBackupSchedule,
  type HarnessCells,
} from '../backup.ts'
import {
  cockpitLayout,
  configCells,
  detailPlan,
  fitDetailLines,
  SERVICE_MARKER,
  type CockpitContent,
  type DetailLine,
} from '../chrome.ts'
import { windowLabel } from '../surface.ts'
import { OutputView } from '../Output'
import { resolveListKey, resolveTailKey, windowOffset, type NavKey, type TailState } from '../nav'
import type { ControlStrings } from '../i18n'
import type { ControlBackupStatus, ControlHost } from '../types'
import type { RunAction, TabChrome, TaskView } from '../ControlCenter'

/** `● ` / `○ ` — whether the harness rides the next backup. */
const MARK_WIDTH = 2

export interface BackupProps {
  host: ControlHost
  strings: ControlStrings
  width: number
  height: number
  isActive: boolean
  run: RunAction
  /** The same task view Services draws into its detail region — a backup's output IS the point. */
  task: TaskView | null
  onDismissTask: () => void
  onChrome: (chrome: TabChrome) => void
  /**
   * Bumped by the shell on every `r` — the one key that means "re-read what is on screen",
   * broadcast because this screen holds its OWN snapshot, exactly like the Dashboard does. See
   * `ControlHost.backupStatus`: it is a separate read from `refresh()` on purpose.
   */
  nonce: number
}

type Focus = 'harnesses' | 'config'

export function Backup({
  host, strings: s, width, height, isActive, run, task, onDismissTask, onChrome, nonce,
}: BackupProps) {
  const [status, setStatus] = useState<ControlBackupStatus | null>(null)
  const [focus, setFocus] = useState<Focus>('harnesses')
  const [selection, setSelection] = useState(0)
  const [configIndex, setConfigIndex] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [outputView, setOutputView] = useState<TailState>({ index: 0, follow: true })

  const readStatus = host.backupStatus
  const refreshStatus = useCallback(async () => {
    if (!readStatus) return
    try { setStatus(await readStatus.call(host)) } catch { /* stale beats blank */ }
  }, [host, readStatus])

  useEffect(() => { void refreshStatus() }, [refreshStatus, nonce])

  // The clock, so a relative age ("2h14m ago") moves rather than freezing at whatever it was when
  // the host last answered — the same reason `chrome.ts`'s `formatUptime` is recomputed every tick
  // rather than handed over pre-formatted. A minute is plenty for a backup's age.
  useEffect(() => {
    if (!isActive) return
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [isActive])

  const taskLines = task?.lines ?? []
  const taskOpen = taskLines.length > 0
  useEffect(() => { setOutputView({ index: 0, follow: true }) }, [task?.id])

  const rows = useMemo(() => harnessRows(status?.harnesses ?? [], now, s), [status, now, s])
  const configRows = useMemo(
    () => (status ? backupConfigRows(status.config, now, s) : []),
    [status, now, s],
  )
  const selected = rows[Math.min(selection, Math.max(0, rows.length - 1))]
  const configSelected = configRows[Math.min(configIndex, Math.max(0, configRows.length - 1))]

  /**
   * The detail pane's content — the selected HARNESS's own facts while that pane has the
   * keyboard, the config facts otherwise. The same relationship `detailContent` gives a selected
   * service and its own detail pane: the harnesses list is the selection, this is a fuller view
   * of it, and it is also where the full "gone" sentence lives — the list column shows only its
   * short form (`harnessLastShort`), or one long sentence would force the whole band's width.
   */
  const detailLines = useMemo(
    () => (focus === 'harnesses' ? harnessDetailLines(selected, s) : status ? backupDetailLines(status.config, now, s) : []),
    [focus, selected, status, now, s],
  )

  // -------------------------------------------------------------------------
  // actions — each one a single host call, none of them decided here
  // -------------------------------------------------------------------------

  const toggleSelected = useCallback(() => {
    if (!selected || !host.setBackupHarness) return
    void host.setBackupHarness(selected.id, !selected.enabled).then(refreshStatus)
  }, [selected, host, refreshStatus])

  const cycleSchedule = useCallback(() => {
    if (!host.setBackupSchedule || !status) return
    const next = nextBackupSchedule(status.config.schedule)
    void run(() => host.setBackupSchedule!(next), s.actBackupSchedule).then(refreshStatus)
  }, [host, status, run, s, refreshStatus])

  const runNow = useCallback(() => {
    if (!host.runBackup) return
    void run(() => host.runBackup!(), s.actBackupRun).then(refreshStatus)
  }, [host, run, s, refreshStatus])

  // -------------------------------------------------------------------------
  // geometry — measured from the rows about to be drawn, never guessed
  // -------------------------------------------------------------------------

  const configLabelWidth = useMemo(
    () => configRows.reduce((n, r) => Math.max(n, r.label.length), 0),
    [configRows],
  )

  const content: CockpitContent = useMemo(() => {
    const widest = (pick: (r: (typeof rows)[number]) => string) =>
      rows.reduce((n, r) => Math.max(n, pick(r).length), 0)
    // Reuses `CockpitContent`'s band-plus-detail shape wholesale — the field names read
    // services-specific because that is the screen it was written for, but the geometry (two
    // panes of a band, one full-width pane below) is generic, and a second copy of this arithmetic
    // is exactly the duplication `cockpitLayout` exists to prevent.
    const harnessesWidth = SERVICE_MARKER + MARK_WIDTH
      + widest(r => r.label) + 1 + widest(r => r.sessions) + 1 + widest(r => r.size) + 1 + widest(r => r.last)
    const configWidth = configRows.reduce(
      (n, r) => Math.max(n, SERVICE_MARKER + configLabelWidth + 1 + r.value.length),
      0,
    )
    return {
      services: harnessesWidth,
      config: configWidth,
      serviceRows: Math.max(1, rows.length),
      configRows: configRows.length,
      detailRows: Math.max(1, detailLines.length),
    }
  }, [rows, configRows, configLabelWidth, detailLines.length])

  const layout = useMemo(
    () => cockpitLayout(width, height, content, { question: taskOpen }),
    [width, height, content, taskOpen],
  )
  const { heights } = layout

  const harnessesBody = paneRows(heights.services)
  const harnessOffset = windowOffset(selection, rows.length, harnessesBody)
  const configBody = paneRows(heights.config)
  const configOffset = windowOffset(configIndex, configRows.length, configBody)

  const cells = useMemo(
    () => harnessCells(rows, paneBody(layout.leftWidth)),
    [rows, layout.leftWidth],
  )
  const configCellWidths = useMemo(
    () => configCells(configRows.map(r => r.label), paneBody(layout.rightWidth)),
    [configRows, layout.rightWidth],
  )

  const detailRows = paneRows(heights.detail)
  const outputLen = taskLines.length
  const outputAnchor = outputView.follow
    ? Math.max(0, outputLen - 1)
    : Math.min(outputView.index, Math.max(0, outputLen - 1))
  const outputOffset = windowOffset(outputAnchor, outputLen, detailRows)
  const detailWidthPx = layout.kind === 'columns' ? layout.leftWidth + layout.rightWidth : width

  // -------------------------------------------------------------------------
  // keys
  // -------------------------------------------------------------------------

  const capturing = taskOpen

  useInput((input, key) => {
    const nav: NavKey = {
      input,
      upArrow: key.upArrow,
      downArrow: key.downArrow,
      return: key.return,
      tab: key.tab,
      shift: key.shift,
    }

    if (key.tab) { setFocus(f => (f === 'harnesses' ? 'config' : 'harnesses')); return }

    if (focus === 'harnesses') {
      const next = resolveListKey(nav, selection, rows.length)
      if (next !== selection) { setSelection(next); return }
      if (input === ' ') return toggleSelected()
    } else {
      const next = resolveListKey(nav, configIndex, configRows.length)
      if (next !== configIndex) { setConfigIndex(next); return }
      if (key.return && configSelected?.action) return cycleSchedule()
    }

    if (input === 'b') return runNow()
    if (input === 's') return cycleSchedule()
  }, { isActive: isActive && !capturing })

  /** The output pane's own keys, exactly like the Services tab's second `useInput`. */
  useInput((input, key) => {
    if (key.escape) return onDismissTask()
    const next = resolveTailKey(
      { input, upArrow: key.upArrow, downArrow: key.downArrow, pageUp: key.pageUp, pageDown: key.pageDown, home: key.home, end: key.end },
      { index: outputAnchor, follow: outputView.follow },
      outputLen,
      detailRows,
    )
    if (next) setOutputView(next)
  }, { isActive: isActive && taskOpen })

  useEffect(() => {
    if (!isActive) return
    onChrome({ capture: capturing, hints: backupHints(focus, s, { task: taskOpen }) })
  }, [isActive, capturing, focus, s, taskOpen, onChrome])

  // -------------------------------------------------------------------------
  // drawing
  // -------------------------------------------------------------------------

  if (!readStatus) {
    return (
      <Box width={width} height={height} flexShrink={0}>
        <Text dimColor>{truncate(s.backupHostMissing, width)}</Text>
      </Box>
    )
  }

  const harnessesPane = (
    <Pane title={s.paneHarnesses} focused={focus === 'harnesses'} width={layout.leftWidth} height={heights.services}>
      {rows.slice(harnessOffset, harnessOffset + harnessesBody).map((row, i) => (
        <HarnessLine
          key={row.id}
          enabled={row.enabled}
          label={row.label}
          sessions={row.sessions}
          size={row.size}
          last={row.last}
          selected={harnessOffset + i === selection}
          focused={focus === 'harnesses'}
          cells={cells}
        />
      ))}
    </Pane>
  )

  const configPane = heights.config > 0 ? (
    <Pane title={s.paneConfig} focused={focus === 'config'} width={layout.rightWidth} height={heights.config}>
      {configRows.slice(configOffset, configOffset + configBody).map((row, i) => (
        <ConfigLine
          key={row.key}
          label={row.label}
          value={truncate(row.value, configCellWidths.value)}
          verb={row.action}
          cells={configCellWidths}
          selected={configOffset + i === configIndex}
          focused={focus === 'config'}
        />
      ))}
    </Pane>
  ) : null

  const detailTitle = focus === 'harnesses' ? (selected?.label ?? s.paneHarnesses) : s.tabsShort.backup
  const detailPane = heights.detail > 0 ? (
    <Pane title={detailTitle} width={detailWidthPx} height={heights.detail}>
      {taskOpen ? (
        <OutputView lines={taskLines} offset={outputOffset} rows={detailRows} width={paneBody(detailWidthPx)} />
      ) : (
        <DetailRows lines={detailLines} rows={detailRows} width={paneBody(detailWidthPx)} />
      )}
    </Pane>
  ) : null

  if (layout.kind === 'stacked') {
    return (
      <Box flexDirection="column" width={width} height={height} flexShrink={0}>
        {harnessesPane}
        {detailPane}
        {configPane}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" width={width} height={height} flexShrink={0}>
      <Box flexDirection="row" width={width} flexShrink={0}>
        {harnessesPane}
        {configPane}
      </Box>
      {detailPane}
    </Box>
  )
}

/** One row of the harnesses pane: cursor, whether it rides the next backup, name, sessions, size,
 *  last-backup. The mark is its own cell rather than folded into the name — the same reason
 *  `ServiceLine`'s state glyph is never merged into its label. */
function HarnessLine({ enabled, label, sessions, size, last, selected, focused, cells }: {
  enabled: boolean
  label: string
  sessions: string
  size: string
  last: string
  selected: boolean
  focused: boolean
  cells: HarnessCells
}) {
  return (
    <Text>
      <Text color={selected && focused ? COLORS.accent : undefined} dimColor={selected && !focused}>
        {selected ? '❯ ' : '  '}
      </Text>
      <Text color={enabled ? COLORS.success : COLORS.muted}>{enabled ? '● ' : '○ '}</Text>
      <Text color={enabled ? COLORS.text : undefined} dimColor={!enabled} bold={selected && focused}>
        {truncate(label, cells.label).padEnd(cells.label)}
      </Text>
      {cells.sessions > 0 ? <Text dimColor>{' ' + truncate(sessions, cells.sessions).padStart(cells.sessions)}</Text> : null}
      {cells.size > 0 ? <Text dimColor>{' ' + truncate(size, cells.size).padStart(cells.size)}</Text> : null}
      {cells.last > 0 ? <Text dimColor>{' ' + truncate(last, cells.last)}</Text> : null}
    </Text>
  )
}

/**
 * The detail pane's facts, cut from the bottom under height pressure — the same `fitDetailLines`
 * the Services tab uses, so a short terminal loses a row of THIS pane exactly the way it loses one
 * of that one: a trailing section or blank never survives alone.
 */
function DetailRows({ lines, rows, width }: { lines: DetailLine[]; rows: number; width: number }) {
  const plan = detailPlan(rows, lines.length, false)
  const shown = fitDetailLines(lines, plan.facts)
  const labelWidth = shown.reduce((n, l) => (l.kind === 'row' ? Math.max(n, l.label.length) : n), 0)

  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      {shown.map((l, i) => {
        if (l.kind === 'blank') return <Text key={i}> </Text>
        if (l.kind === 'section') return <Text key={i} dimColor bold>{l.label}</Text>
        if (l.kind === 'text') return <Text key={i}>{truncate(l.value, width)}</Text>
        return (
          <Text key={i}>
            <Text dimColor>{l.label.padEnd(labelWidth)}</Text>
            <Text color={COLORS.text}>{'  ' + truncate(l.value, Math.max(1, width - labelWidth - 2))}</Text>
          </Text>
        )
      })}
    </Box>
  )
}
