/**
 * Wall-clock times in IANA time zones, with the runtime's time zone database (`Intl`): what an event is set in
 * (calendar §1, Times), and the occurrences of the part of RRULE that Calendar 1.0 takes (calendar §4.2).
 */
import type { Rule, Weekday } from '@ayni.org/ayni-feature-profiles'

/** A wall-clock date and time, with no zone. */
export interface Local {
  y: number
  m: number
  d: number
  h: number
  mi: number
  s: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatters.set(zone, f)
  }
  return f
}

/** The wall clock of an instant in a zone. */
export function toLocal(ms: number, zone: string): Local {
  const parts = Object.fromEntries(
    formatter(zone)
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value])
  )
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    h: Number(parts.hour),
    mi: Number(parts.minute),
    s: Number(parts.second),
  }
}

function localAsUtc(l: Local): number {
  return Date.UTC(l.y, l.m - 1, l.d, l.h, l.mi, l.s)
}

/** The offset of a zone at an instant, in minutes east of UTC. */
export function offsetMinutes(zone: string, ms: number): number {
  return Math.round((localAsUtc(toLocal(ms, zone)) - Math.floor(ms / 1000) * 1000) / 60000)
}

/** The instant of a wall clock in a zone (in a gap of a change of offset, the later offset). */
export function toInstant(l: Local, zone: string): number {
  const asUtc = localAsUtc(l)
  let guess = asUtc - offsetMinutes(zone, asUtc) * 60000
  guess = asUtc - offsetMinutes(zone, guess) * 60000
  return guess
}

const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0')

/** An instant as RFC 3339 `date-time` with the offset of a zone (`2026-11-23T10:00:00+01:00`), or with `Z` in UTC. */
export function formatInstant(ms: number, zone?: string): string {
  if (!zone) return `${new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19)}Z`
  const l = toLocal(ms, zone)
  const off = offsetMinutes(zone, ms)
  const sign = off < 0 ? '-' : '+'
  return `${pad(l.y, 4)}-${pad(l.m)}-${pad(l.d)}T${pad(l.h)}:${pad(l.mi)}:${pad(l.s)}${sign}${pad(Math.trunc(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
}

/** An instant in UTC as the profiles answer it about an item (common §8): `…Z`. */
export function utc(ms: number): string {
  return formatInstant(ms)
}

/** A date as RFC 3339 `full-date`. */
export function formatDate(y: number, m: number, d: number): string {
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`
}

export function parseDate(date: string): { y: number; m: number; d: number } {
  const [y, m, d] = date.split('-').map(Number)
  return { y: y as number, m: m as number, d: d as number }
}

/** Days since the epoch of a date. */
export function dayNumber(y: number, m: number, d: number): number {
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000)
}

export function fromDayNumber(n: number): { y: number; m: number; d: number } {
  const t = new Date(n * 86_400_000)
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }
}

const WEEKDAY_INDEX: Record<Weekday, number> = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 }

/** The weekday of a date, Monday 0. */
export function weekdayOf(y: number, m: number, d: number): number {
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** The day of a month that is the `rank`th `day` (2TU, -1FR), if the month has it. */
function nthWeekdayOfMonth(y: number, m: number, day: Weekday, rank: number): number | undefined {
  const want = WEEKDAY_INDEX[day]
  const days = daysInMonth(y, m)
  const matches: number[] = []
  for (let d = 1; d <= days; d++) if (weekdayOf(y, m, d) === want) matches.push(d)
  return rank > 0 ? matches[rank - 1] : matches[matches.length + rank]
}

function nthWeekdayOfYear(y: number, day: Weekday, rank: number): { m: number; d: number } | undefined {
  const want = WEEKDAY_INDEX[day]
  const matches: { m: number; d: number }[] = []
  for (let m = 1; m <= 12; m++)
    for (let d = 1; d <= daysInMonth(y, m); d++) if (weekdayOf(y, m, d) === want) matches.push({ m, d })
  return rank > 0 ? matches[rank - 1] : matches[matches.length + rank]
}

/**
 * The dates of the occurrences of a rule from its first date, in order, until `untilDay` (a day number) or the rule's
 * own end: the first date always first (RFC 5545 §3.8.5.3), then the dates the rule makes after it.
 */
export function occurrenceDates(
  first: { y: number; m: number; d: number },
  rule: Rule,
  lastDay: number,
  untilOk: (date: { y: number; m: number; d: number }) => boolean
): { y: number; m: number; d: number }[] {
  const out: { y: number; m: number; d: number }[] = []
  const firstDay = dayNumber(first.y, first.m, first.d)
  const interval = rule.interval ?? 1
  const push = (date: { y: number; m: number; d: number }) => {
    const n = dayNumber(date.y, date.m, date.d)
    if (n < firstDay || n > lastDay || !untilOk(date)) return false
    if (out.some((o) => dayNumber(o.y, o.m, o.d) === n)) return true
    out.push(date)
    return true
  }
  const done = () => rule.count !== undefined && out.length >= rule.count
  out.push(first)
  if (!untilOk(first)) return []
  const MAX = 10_000
  if (rule.freq === 'DAILY') {
    for (let k = 1; k < MAX && !done(); k++) {
      const n = firstDay + k * interval
      if (n > lastDay) break
      const date = fromDayNumber(n)
      if (!untilOk(date)) break
      push(date)
    }
  } else if (rule.freq === 'WEEKLY') {
    const days = rule.byDay?.map((b) => WEEKDAY_INDEX[b.day]).sort((a, b) => a - b) ?? [
      weekdayOf(first.y, first.m, first.d),
    ]
    const weekStart = firstDay - weekdayOf(first.y, first.m, first.d)
    for (let k = 0; k < MAX && !done(); k++) {
      const start = weekStart + k * 7 * interval
      if (start > lastDay) break
      let stop = false
      for (const wd of days) {
        if (done()) break
        const n = start + wd
        if (n <= firstDay) continue
        const date = fromDayNumber(n)
        if (n > lastDay || !untilOk(date)) {
          stop = true
          break
        }
        push(date)
      }
      if (stop) break
    }
  } else {
    const monthly = rule.freq === 'MONTHLY'
    for (let k = 0; k < MAX && !done(); k++) {
      const periods: { y: number; m: number }[] = []
      if (monthly) {
        const idx = first.y * 12 + (first.m - 1) + k * interval
        periods.push({ y: Math.floor(idx / 12), m: (idx % 12) + 1 })
      } else {
        periods.push({ y: first.y + k * interval, m: rule.byMonth ?? first.m })
      }
      const p = periods[0] as { y: number; m: number }
      if (dayNumber(p.y, p.m, 1) > lastDay) break
      let date: { y: number; m: number; d: number } | undefined
      const byDay = rule.byDay?.[0]
      if (byDay?.rank !== undefined) {
        if (monthly || rule.byMonth !== undefined) {
          const d = nthWeekdayOfMonth(p.y, p.m, byDay.day, byDay.rank)
          if (d !== undefined) date = { y: p.y, m: p.m, d }
        } else {
          const md = nthWeekdayOfYear(p.y, byDay.day, byDay.rank)
          if (md) date = { y: p.y, ...md }
        }
      } else {
        const d = rule.byMonthDay ?? first.d
        if (d <= daysInMonth(p.y, p.m)) date = { y: p.y, m: p.m, d }
      }
      if (!date) continue
      const n = dayNumber(date.y, date.m, date.d)
      if (n <= firstDay) continue
      if (n > lastDay || !untilOk(date)) break
      push(date)
    }
  }
  return rule.count !== undefined ? out.slice(0, rule.count) : out
}
