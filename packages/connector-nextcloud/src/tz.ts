/**
 * Wall-clock times in time zones (calendar §1, Times): the IANA zones of the runtime's database (`Intl`), and a zone
 * an event defines in a `VTIMEZONE` of its own under a name of no database (an invitation from another calendar). The
 * connector writes the definition of each zone it names, made from the database (providers §4, FEAT-CALDAV-005).
 */
import { isTimeZone } from '@ayni.org/ayni-feature-profiles'

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

export function localAsUtc(l: Local): number {
  return Date.UTC(l.y, l.m - 1, l.d, l.h, l.mi, l.s)
}

export function fromUtcFields(ms: number): Local {
  const t = new Date(ms)
  return {
    y: t.getUTCFullYear(),
    m: t.getUTCMonth() + 1,
    d: t.getUTCDate(),
    h: t.getUTCHours(),
    mi: t.getUTCMinutes(),
    s: t.getUTCSeconds(),
  }
}

/** A zone: its offset at an instant, and the instant of a wall clock in it. */
export interface Zone {
  /** the IANA name, for a zone of the database */
  name?: string
  /** minutes east of UTC at an instant */
  offsetAt(ms: number): number
}

export const UTC_ZONE: Zone = { name: 'UTC', offsetAt: () => 0 }

/** A zone of the runtime's IANA database. */
export function ianaZone(name: string): Zone {
  return {
    name,
    offsetAt(ms) {
      const parts = Object.fromEntries(
        formatter(name)
          .formatToParts(new Date(ms))
          .map((p) => [p.type, p.value])
      )
      const l: Local = {
        y: Number(parts.year),
        m: Number(parts.month),
        d: Number(parts.day),
        h: Number(parts.hour),
        mi: Number(parts.minute),
        s: Number(parts.second),
      }
      return Math.round((localAsUtc(l) - Math.floor(ms / 1000) * 1000) / 60000)
    },
  }
}

/** The wall clock of an instant in a zone. */
export function toLocal(ms: number, zone: Zone): Local {
  return fromUtcFields(ms + zone.offsetAt(ms) * 60000)
}

/** The instant of a wall clock in a zone (in a gap of a change of offset, the later offset). */
export function toInstant(l: Local, zone: Zone): number {
  const asUtc = localAsUtc(l)
  let guess = asUtc - zone.offsetAt(asUtc) * 60000
  guess = asUtc - zone.offsetAt(guess) * 60000
  return guess
}

const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0')

/** An instant as RFC 3339 with the offset of a zone (`2026-11-23T10:00:00+01:00`), or with `Z` in UTC. */
export function formatInstant(ms: number, zone?: Zone): string {
  const whole = Math.floor(ms / 1000) * 1000
  if (!zone || zone === UTC_ZONE) return `${new Date(whole).toISOString().slice(0, 19)}Z`
  const off = zone.offsetAt(whole)
  const l = toLocal(whole, zone)
  const sign = off < 0 ? '-' : '+'
  return `${pad(l.y, 4)}-${pad(l.m)}-${pad(l.d)}T${pad(l.h)}:${pad(l.mi)}:${pad(l.s)}${sign}${pad(Math.trunc(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
}

export function formatDate(y: number, m: number, d: number): string {
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`
}

/** `20261123T100000` of a wall clock. */
export function icalLocal(l: Local): string {
  return `${pad(l.y, 4)}${pad(l.m)}${pad(l.d)}T${pad(l.h)}${pad(l.mi)}${pad(l.s)}`
}

/** `20261123T090000Z` of an instant. */
export function icalUtc(ms: number): string {
  return `${icalLocal(fromUtcFields(Math.floor(ms / 1000) * 1000))}Z`
}

/** The IANA name a `TZID` stands for, when it is one: itself, or the end of a vendor's path (`/mozilla.org/…/Europe/Paris`). */
export function ianaNameOf(tzid: string): string | undefined {
  const t = tzid.trim()
  if (isTimeZone(t) && t.includes('/')) return t
  if (t === 'UTC' || t === 'GMT' || t === 'Etc/UTC') return 'UTC'
  const parts = t.split('/').filter(Boolean)
  for (let n = Math.min(3, parts.length); n >= 2; n--) {
    const candidate = parts.slice(-n).join('/')
    if (isTimeZone(candidate)) return candidate
  }
  return undefined
}

// ---- writing a VTIMEZONE from the database ---------------------------------------------------------------------

interface Transition {
  /** the instant of the change */
  at: number
  from: number
  to: number
}

function transitions(zone: Zone, fromMs: number, toMs: number): Transition[] {
  const out: Transition[] = []
  const step = 86_400_000
  let prev = zone.offsetAt(fromMs)
  for (let t = fromMs + step; t <= toMs; t += step) {
    const off = zone.offsetAt(t)
    if (off === prev) continue
    let lo = t - step
    let hi = t
    while (hi - lo > 60_000) {
      const mid = lo + Math.floor((hi - lo) / 2 / 60_000) * 60_000
      if (zone.offsetAt(mid) === prev) lo = mid
      else hi = mid
    }
    out.push({ at: hi, from: prev, to: off })
    prev = off
  }
  return out
}

const WEEKDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

function offsetText(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+'
  return `${sign}${pad(Math.trunc(Math.abs(minutes) / 60))}${pad(Math.abs(minutes) % 60)}`
}

/** The rule of a yearly change at a weekday of a month (`BYMONTH=3;BYDAY=-1SU`), when every change of the list keeps it. */
function yearlyRule(list: Transition[]): string | undefined {
  const keys = list.map((t) => {
    const l = fromUtcFields(t.at + t.from * 60000)
    const days = new Date(Date.UTC(l.y, l.m, 0)).getUTCDate()
    const wd = WEEKDAY[new Date(Date.UTC(l.y, l.m - 1, l.d)).getUTCDay()] as string
    const rank = l.d + 7 > days ? -1 : Math.ceil(l.d / 7)
    return { key: `${l.m}/${wd}/${rank}/${l.h}:${l.mi}`, m: l.m, wd, rank }
  })
  const first = keys[0]
  if (!first || keys.some((k) => k.key !== first.key)) return undefined
  return `FREQ=YEARLY;BYMONTH=${first.m};BYDAY=${first.rank}${first.wd}`
}

/**
 * The lines of a `VTIMEZONE` for an IANA zone (RFC 5545 §3.6.5), around an instant: the changes of offset from a year
 * before to ten years after, as yearly rules where they keep one, else each on its own.
 */
export function vtimezoneLines(name: string, aroundMs: number): string[] {
  const zone = ianaZone(name)
  const year = new Date(aroundMs).getUTCFullYear()
  const from = Date.UTC(year - 1, 0, 1)
  const to = Date.UTC(year + 10, 0, 1)
  const list = transitions(zone, from, to)
  const lines = ['BEGIN:VTIMEZONE', `TZID:${name}`]
  if (!list.length) {
    const off = zone.offsetAt(aroundMs)
    lines.push(
      'BEGIN:STANDARD',
      'DTSTART:19700101T000000',
      `TZOFFSETFROM:${offsetText(off)}`,
      `TZOFFSETTO:${offsetText(off)}`,
      'END:STANDARD',
      'END:VTIMEZONE'
    )
    return lines
  }
  const groups = new Map<string, Transition[]>()
  for (const t of list) {
    const k = `${t.from}>${t.to}`
    groups.set(k, [...(groups.get(k) ?? []), t])
  }
  for (const group of groups.values()) {
    const first = group[0] as Transition
    const kind = first.to > first.from ? 'DAYLIGHT' : 'STANDARD'
    const rule = group.length > 1 ? yearlyRule(group) : undefined
    lines.push(
      `BEGIN:${kind}`,
      `DTSTART:${icalLocal(fromUtcFields(first.at + first.from * 60000))}`,
      `TZOFFSETFROM:${offsetText(first.from)}`,
      `TZOFFSETTO:${offsetText(first.to)}`
    )
    if (rule) lines.push(`RRULE:${rule}`)
    else if (group.length > 1)
      lines.push(
        `RDATE:${group
          .slice(1)
          .map((t) => icalLocal(fromUtcFields(t.at + t.from * 60000)))
          .join(',')}`
      )
    lines.push(`END:${kind}`)
  }
  lines.push('END:VTIMEZONE')
  return lines
}
