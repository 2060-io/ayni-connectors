/**
 * The occurrences of a repeating event, worked out by the connector itself from the whole object (providers §4,
 * FEAT-CALDAV-003): any `RRULE` of RFC 5545 §3.3.10 that another calendar may have written, not only the part Calendar
 * 1.0 writes, on the wall clock of the event's zone, `DTSTART` always the first occurrence.
 */
import type { Local } from './tz.js'

export type Freq = 'SECONDLY' | 'MINUTELY' | 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'

export interface RRule {
  freq: Freq
  interval: number
  count?: number
  /** `UNTIL` as written */
  until?: string
  bySecond?: number[]
  byMinute?: number[]
  byHour?: number[]
  /** weekday 0 for Monday to 6 for Sunday, with its rank */
  byDay?: { wd: number; n?: number }[]
  byMonthDay?: number[]
  byYearDay?: number[]
  byWeekNo?: number[]
  byMonth?: number[]
  bySetPos?: number[]
  wkst: number
}

const WD = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
const FREQS = new Set(['SECONDLY', 'MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'])

function ints(v: string, min: number, max: number, nonZero = false): number[] | undefined {
  const out: number[] = []
  for (const x of v.split(',')) {
    if (!/^[+-]?\d{1,3}$/.test(x)) return undefined
    const n = Number(x)
    if (n < min || n > max || (nonZero && n === 0)) return undefined
    out.push(n)
  }
  return out
}

/** Reads an `RRULE` value; `undefined` for one this reader cannot work out. */
export function parseRRule(value: string): RRule | undefined {
  const parts = new Map<string, string>()
  for (const p of value
    .trim()
    .replace(/^RRULE:/i, '')
    .split(';')) {
    const eq = p.indexOf('=')
    if (eq <= 0) return undefined
    parts.set(p.slice(0, eq).toUpperCase(), p.slice(eq + 1).toUpperCase())
  }
  const freq = parts.get('FREQ')
  if (!freq || !FREQS.has(freq)) return undefined
  const r: RRule = { freq: freq as Freq, interval: 1, wkst: 0 }
  for (const [k, v] of parts) {
    switch (k) {
      case 'FREQ':
        break
      case 'INTERVAL':
        if (!/^\d{1,4}$/.test(v) || Number(v) < 1) return undefined
        r.interval = Number(v)
        break
      case 'COUNT':
        if (!/^\d{1,6}$/.test(v) || Number(v) < 1) return undefined
        r.count = Number(v)
        break
      case 'UNTIL':
        r.until = v
        break
      case 'BYSECOND': {
        const x = ints(v, 0, 60)
        if (!x) return undefined
        r.bySecond = x
        break
      }
      case 'BYMINUTE': {
        const x = ints(v, 0, 59)
        if (!x) return undefined
        r.byMinute = x
        break
      }
      case 'BYHOUR': {
        const x = ints(v, 0, 23)
        if (!x) return undefined
        r.byHour = x
        break
      }
      case 'BYDAY': {
        const days: { wd: number; n?: number }[] = []
        for (const x of v.split(',')) {
          const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(x)
          if (!m) return undefined
          const n = m[1] ? Number(m[1]) : undefined
          if (n !== undefined && (n === 0 || Math.abs(n) > 53)) return undefined
          days.push({ wd: WD.indexOf(m[2] as string), ...(n !== undefined ? { n } : {}) })
        }
        r.byDay = days
        break
      }
      case 'BYMONTHDAY': {
        const x = ints(v, -31, 31, true)
        if (!x) return undefined
        r.byMonthDay = x
        break
      }
      case 'BYYEARDAY': {
        const x = ints(v, -366, 366, true)
        if (!x) return undefined
        r.byYearDay = x
        break
      }
      case 'BYWEEKNO': {
        const x = ints(v, -53, 53, true)
        if (!x) return undefined
        r.byWeekNo = x
        break
      }
      case 'BYMONTH': {
        const x = ints(v, 1, 12)
        if (!x) return undefined
        r.byMonth = x
        break
      }
      case 'BYSETPOS': {
        const x = ints(v, -366, 366, true)
        if (!x) return undefined
        r.bySetPos = x
        break
      }
      case 'WKST':
        if (!WD.includes(v)) return undefined
        r.wkst = WD.indexOf(v)
        break
      default:
        // an X- part or one of a later RFC: read as a rule this reader does not know
        return undefined
    }
  }
  if (r.count !== undefined && r.until !== undefined) return undefined
  return r
}

type Day = { y: number; m: number; d: number }

const dayNumber = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d) / 86_400_000)
function fromDayNumber(n: number): Day {
  const t = new Date(n * 86_400_000)
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }
}
/** Monday 0 to Sunday 6 */
const weekdayOf = (y: number, m: number, d: number) => (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()
const daysInYear = (y: number) => (daysInMonth(y, 2) === 29 ? 366 : 365)

export function compareLocal(a: Local, b: Local): number {
  return Date.UTC(a.y, a.m - 1, a.d, a.h, a.mi, a.s) - Date.UTC(b.y, b.m - 1, b.d, b.h, b.mi, b.s)
}

/** The days of a month matching `BYDAY` (a rank counted within the month). */
function byDayInMonth(y: number, m: number, byDay: { wd: number; n?: number }[]): number[] {
  const n = daysInMonth(y, m)
  const out = new Set<number>()
  for (const { wd, n: rank } of byDay) {
    const all: number[] = []
    for (let d = 1; d <= n; d++) if (weekdayOf(y, m, d) === wd) all.push(d)
    if (rank === undefined) for (const d of all) out.add(d)
    else {
      const d = rank > 0 ? all[rank - 1] : all[all.length + rank]
      if (d !== undefined) out.add(d)
    }
  }
  return [...out]
}

/** The days of a year matching `BYDAY` (a rank counted within the year), as day numbers. */
function byDayInYear(y: number, byDay: { wd: number; n?: number }[]): number[] {
  const first = dayNumber(y, 1, 1)
  const len = daysInYear(y)
  const out = new Set<number>()
  for (const { wd, n: rank } of byDay) {
    const all: number[] = []
    for (let i = 0; i < len; i++) {
      const dn = first + i
      const t = fromDayNumber(dn)
      if (weekdayOf(t.y, t.m, t.d) === wd) all.push(dn)
    }
    if (rank === undefined) for (const d of all) out.add(d)
    else {
      const d = rank > 0 ? all[rank - 1] : all[all.length + rank]
      if (d !== undefined) out.add(d)
    }
  }
  return [...out]
}

/** The first day of week 1 of a year (RFC 5545: the first week with four days of the year, from `WKST`). */
function weekOneStart(y: number, wkst: number): number {
  const jan1 = dayNumber(y, 1, 1)
  const wd = weekdayOf(y, 1, 1)
  const back = (wd - wkst + 7) % 7
  const start = jan1 - back
  return 7 - back >= 4 ? start : start + 7
}

function monthDays(y: number, m: number, list: number[]): number[] {
  const n = daysInMonth(y, m)
  return list.map((d) => (d > 0 ? d : n + d + 1)).filter((d) => d >= 1 && d <= n)
}

function limitDay(r: RRule, t: Day): boolean {
  if (r.byMonth && !r.byMonth.includes(t.m)) return false
  if (r.byMonthDay && !monthDays(t.y, t.m, r.byMonthDay).includes(t.d)) return false
  if (r.byDay && !r.byDay.some((x) => x.wd === weekdayOf(t.y, t.m, t.d))) return false
  return true
}

/** The days of one period of the rule, in order. */
function daysOfPeriod(r: RRule, start: Local, k: number): Day[] {
  const out: number[] = []
  if (r.freq === 'YEARLY') {
    const y = start.y + k * r.interval
    if (r.byYearDay) {
      const len = daysInYear(y)
      for (const n of r.byYearDay) {
        const i = n > 0 ? n - 1 : len + n
        if (i >= 0 && i < len) out.push(dayNumber(y, 1, 1) + i)
      }
      return out
        .sort((a, b) => a - b)
        .map(fromDayNumber)
        .filter((t) => limitDay({ ...r, byMonthDay: r.byMonthDay }, t))
    }
    if (r.byWeekNo) {
      const w1 = weekOneStart(y, r.wkst)
      const weeks = Math.round((weekOneStart(y + 1, r.wkst) - w1) / 7)
      for (const w of r.byWeekNo) {
        const idx = w > 0 ? w - 1 : weeks + w
        if (idx < 0 || idx >= weeks) continue
        for (let i = 0; i < 7; i++) out.push(w1 + idx * 7 + i)
      }
      const wds = r.byDay?.map((x) => x.wd) ?? [weekdayOf(start.y, start.m, start.d)]
      return [...new Set(out)]
        .sort((a, b) => a - b)
        .map(fromDayNumber)
        .filter((t) => wds.includes(weekdayOf(t.y, t.m, t.d)) && (!r.byMonth || r.byMonth.includes(t.m)))
    }
    if (r.byMonth) {
      for (const m of [...r.byMonth].sort((a, b) => a - b)) {
        let days: number[]
        if (r.byMonthDay) {
          days = monthDays(y, m, r.byMonthDay)
          if (r.byDay) days = days.filter((d) => r.byDay?.some((x) => x.wd === weekdayOf(y, m, d)))
        } else if (r.byDay) days = byDayInMonth(y, m, r.byDay)
        else days = start.d <= daysInMonth(y, m) ? [start.d] : []
        for (const d of days) out.push(dayNumber(y, m, d))
      }
    } else if (r.byMonthDay) {
      for (let m = 1; m <= 12; m++)
        for (const d of monthDays(y, m, r.byMonthDay))
          if (!r.byDay || r.byDay.some((x) => x.wd === weekdayOf(y, m, d))) out.push(dayNumber(y, m, d))
    } else if (r.byDay) out.push(...byDayInYear(y, r.byDay))
    else if (start.d <= daysInMonth(y, start.m)) out.push(dayNumber(y, start.m, start.d))
    return [...new Set(out)].sort((a, b) => a - b).map(fromDayNumber)
  }
  if (r.freq === 'MONTHLY') {
    const idx = start.y * 12 + (start.m - 1) + k * r.interval
    const y = Math.floor(idx / 12)
    const m = (idx % 12) + 1
    if (r.byMonth && !r.byMonth.includes(m)) return []
    let days: number[]
    if (r.byMonthDay) {
      days = monthDays(y, m, r.byMonthDay)
      if (r.byDay) days = days.filter((d) => r.byDay?.some((x) => x.wd === weekdayOf(y, m, d)))
    } else if (r.byDay) days = byDayInMonth(y, m, r.byDay)
    else days = start.d <= daysInMonth(y, m) ? [start.d] : []
    return [...new Set(days)].sort((a, b) => a - b).map((d) => ({ y, m, d }))
  }
  if (r.freq === 'WEEKLY') {
    const s = dayNumber(start.y, start.m, start.d)
    const weekStart = s - ((weekdayOf(start.y, start.m, start.d) - r.wkst + 7) % 7) + k * 7 * r.interval
    const wds = r.byDay?.map((x) => x.wd) ?? [weekdayOf(start.y, start.m, start.d)]
    for (let i = 0; i < 7; i++) {
      const dn = weekStart + i
      const t = fromDayNumber(dn)
      if (wds.includes(weekdayOf(t.y, t.m, t.d)) && (!r.byMonth || r.byMonth.includes(t.m))) out.push(dn)
    }
    return out.map(fromDayNumber)
  }
  // DAILY and finer: one day a period, the finer ones stepping inside it
  const t = fromDayNumber(dayNumber(start.y, start.m, start.d) + (r.freq === 'DAILY' ? k * r.interval : k))
  return limitDay(r, t) ? [t] : []
}

function timesOfDay(r: RRule, start: Local, dateOnly: boolean): { h: number; mi: number; s: number }[] {
  if (dateOnly) return [{ h: 0, mi: 0, s: 0 }]
  const hs = r.byHour ?? [start.h]
  const ms = r.byMinute ?? [start.mi]
  const ss = r.bySecond ?? [start.s]
  const out: { h: number; mi: number; s: number }[] = []
  for (const h of [...hs].sort((a, b) => a - b))
    for (const mi of [...ms].sort((a, b) => a - b))
      for (const s of [...ss].sort((a, b) => a - b)) out.push({ h, mi, s: Math.min(59, s) })
  return out
}

/** The candidates of one period of a rule finer than a day: the day's steps that pass every limit. */
function finer(r: RRule, start: Local, day: Day): Local[] {
  const base = Date.UTC(start.y, start.m - 1, start.d, start.h, start.mi, start.s)
  const unit = r.freq === 'HOURLY' ? 3_600_000 : r.freq === 'MINUTELY' ? 60_000 : 1000
  const step = unit * r.interval
  const dayStart = Date.UTC(day.y, day.m - 1, day.d)
  const out: Local[] = []
  const first = Math.max(0, Math.ceil((dayStart - base) / step))
  for (let i = first; ; i++) {
    const t = base + i * step
    if (t >= dayStart + 86_400_000) break
    const at = new Date(t)
    const l: Local = {
      y: at.getUTCFullYear(),
      m: at.getUTCMonth() + 1,
      d: at.getUTCDate(),
      h: at.getUTCHours(),
      mi: at.getUTCMinutes(),
      s: at.getUTCSeconds(),
    }
    if (r.byHour && !r.byHour.includes(l.h)) continue
    if (r.byMinute && !r.byMinute.includes(l.mi)) continue
    if (r.bySecond && !r.bySecond.includes(l.s)) continue
    out.push(l)
  }
  return out
}

/** The first day of the `k`th period of a rule. */
function periodStart(r: RRule, start: Local, k: number): Day {
  if (r.freq === 'YEARLY') return { y: start.y + k * r.interval, m: 1, d: 1 }
  if (r.freq === 'MONTHLY') {
    const idx = start.y * 12 + (start.m - 1) + k * r.interval
    return { y: Math.floor(idx / 12), m: (idx % 12) + 1, d: 1 }
  }
  const s = dayNumber(start.y, start.m, start.d)
  if (r.freq === 'WEEKLY')
    return fromDayNumber(s - ((weekdayOf(start.y, start.m, start.d) - r.wkst + 7) % 7) + k * 7 * r.interval)
  return fromDayNumber(s + (r.freq === 'DAILY' ? k * r.interval : k))
}

/**
 * The starts of a rule's occurrences on the wall clock, in order, `start` first: those `untilOk` takes, until one is
 * past `beyond`, at most `max`.
 */
export function expandRule(
  r: RRule,
  start: Local,
  dateOnly: boolean,
  untilOk: (l: Local) => boolean,
  beyond: (l: Local) => boolean,
  max = 5000
): Local[] {
  const out: Local[] = [start]
  if (r.count === 1) return out
  const coarse = r.freq !== 'HOURLY' && r.freq !== 'MINUTELY' && r.freq !== 'SECONDLY'
  for (let k = 0; k < 400_000 && out.length < max; k++) {
    if (k > 0 && beyond({ ...periodStart(r, start, k), h: 0, mi: 0, s: 0 })) break
    const days = daysOfPeriod(r, start, k)
    let candidates: Local[] = []
    if (coarse) {
      const times = timesOfDay(r, start, dateOnly)
      for (const d of days) for (const t of times) candidates.push({ ...d, ...t })
    } else for (const d of days) candidates.push(...finer(r, start, d))
    candidates.sort(compareLocal)
    if (r.bySetPos && candidates.length) {
      const n = candidates.length
      candidates = [...new Set(r.bySetPos.map((p) => (p > 0 ? p - 1 : n + p)).filter((i) => i >= 0 && i < n))]
        .sort((a, b) => a - b)
        .map((i) => candidates[i] as Local)
    }
    for (const c of candidates) {
      if (compareLocal(c, start) <= 0) continue
      if (!untilOk(c) || beyond(c)) return out
      out.push(c)
      if (r.count !== undefined && out.length >= r.count) return out
      if (out.length >= max) return out
    }
  }
  return out
}
