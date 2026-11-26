/**
 * The occurrences of a repeating event, as Google Calendar expands an `RRULE` (`singleEvents=true`): the wall-clock
 * time of the first occurrence kept in its zone across changes of offset (RFC 5545 §3.3.10, the part Calendar 1.0
 * takes). The stub's own, written apart from the connector, which does not expand rules.
 */
import { parseRule, type Rule, type Weekday } from '@ayni.org/ayni-feature-profiles'

interface Local {
  y: number
  m: number
  d: number
  h: number
  mi: number
  s: number
}

function parts(ms: number, zone: string): Local {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value])
  )
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second }
}

const asUtc = (l: Local) => Date.UTC(l.y, l.m - 1, l.d, l.h, l.mi, l.s)

export function localOf(ms: number, zone: string): Local {
  return parts(ms, zone)
}

/** The instant of a wall-clock time in a zone. */
export function instantOf(l: Local, zone: string): number {
  const guess0 = asUtc(l)
  const off = (ms: number) => asUtc(parts(ms, zone)) - Math.floor(ms / 1000) * 1000
  let guess = guess0 - off(guess0)
  guess = guess0 - off(guess)
  return guess
}

/** An instant written with the offset of a zone, as Google writes `dateTime` in its answers. */
export function withOffset(ms: number, zone: string): string {
  const l = parts(ms, zone)
  const offMin = Math.round((asUtc(l) - Math.floor(ms / 1000) * 1000) / 60000)
  const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0')
  const sign = offMin < 0 ? '-' : '+'
  return `${pad(l.y, 4)}-${pad(l.m)}-${pad(l.d)}T${pad(l.h)}:${pad(l.mi)}:${pad(l.s)}${sign}${pad(Math.trunc(Math.abs(offMin) / 60))}:${pad(Math.abs(offMin) % 60)}`
}

const WEEKDAY: Record<Weekday, number> = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 }
const dayNumber = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d) / 86_400_000)
const fromDay = (n: number) => {
  const t = new Date(n * 86_400_000)
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }
}
const weekday = (y: number, m: number, d: number) => (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7
const monthDays = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()

function nthOfMonth(y: number, m: number, day: Weekday, rank: number): number | undefined {
  const all: number[] = []
  for (let d = 1; d <= monthDays(y, m); d++) if (weekday(y, m, d) === WEEKDAY[day]) all.push(d)
  return rank > 0 ? all[rank - 1] : all[all.length + rank]
}

/** The dates of the occurrences of a rule from a first date, up to a last day number. */
export function datesOf(
  first: { y: number; m: number; d: number },
  rule: Rule,
  lastDay: number
): { y: number; m: number; d: number }[] {
  const out = [first]
  const firstDay = dayNumber(first.y, first.m, first.d)
  const interval = rule.interval ?? 1
  const untilDay = rule.until
    ? dayNumber(+rule.until.slice(0, 4), +rule.until.slice(4, 6), +rule.until.slice(6, 8))
    : Infinity
  const done = () => rule.count !== undefined && out.length >= rule.count
  const push = (n: number) => {
    if (n <= firstDay || n > lastDay || n > untilDay) return false
    out.push(fromDay(n))
    return true
  }
  if (rule.freq === 'DAILY') {
    for (let k = 1; !done() && firstDay + k * interval <= Math.min(lastDay, untilDay); k++)
      push(firstDay + k * interval)
  } else if (rule.freq === 'WEEKLY') {
    const days = rule.byDay?.map((b) => WEEKDAY[b.day]).sort((a, b) => a - b) ?? [weekday(first.y, first.m, first.d)]
    const weekStart = firstDay - weekday(first.y, first.m, first.d)
    for (let k = 0; !done() && weekStart + k * 7 * interval <= Math.min(lastDay, untilDay); k++)
      for (const wd of days) {
        if (done()) break
        push(weekStart + k * 7 * interval + wd)
      }
  } else {
    for (let k = 1; !done() && k < 5000; k++) {
      const idx = first.y * 12 + first.m - 1 + (rule.freq === 'MONTHLY' ? k * interval : k * 12 * interval)
      const y = Math.floor(idx / 12)
      const m = rule.freq === 'YEARLY' && rule.byMonth ? rule.byMonth : (idx % 12) + 1
      if (dayNumber(y, m, 1) > Math.min(lastDay, untilDay)) break
      const b = rule.byDay?.[0]
      const d = b?.rank !== undefined ? nthOfMonth(y, m, b.day, b.rank) : (rule.byMonthDay ?? first.d)
      if (d !== undefined && d <= monthDays(y, m)) push(dayNumber(y, m, d))
    }
  }
  out.sort((a, b) => dayNumber(a.y, a.m, a.d) - dayNumber(b.y, b.m, b.d))
  return rule.count !== undefined ? out.slice(0, rule.count) : out
}

export function ruleOfRecurrence(recurrence: string[] | undefined): Rule | undefined {
  const line = recurrence?.find((l) => l.startsWith('RRULE:'))
  if (!line) return undefined
  const r = parseRule(line.slice(6))
  return 'rule' in r ? r.rule : undefined
}
