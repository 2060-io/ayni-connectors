/**
 * Instants written in a time zone with the runtime's time zone database (`Intl`): an event set in `Europe/Paris` reads
 * `2027-01-04T10:00:00+01:00` whatever zone Google formats its answer in (calendar §1, Times; FEAT-CAL-003, 032), and
 * the instants of an item in UTC with `Z` (common §8, FEAT-CORE-017).
 */

interface Local {
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

/** Whether the runtime knows a zone of the IANA time zone database. */
export function knownZone(zone: string): boolean {
  try {
    formatter(zone)
    return true
  } catch {
    return false
  }
}

function toLocal(ms: number, zone: string): Local {
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

/** The offset of a zone at an instant, in minutes east of UTC. */
export function offsetMinutes(zone: string, ms: number): number {
  const l = toLocal(ms, zone)
  return Math.round((Date.UTC(l.y, l.m - 1, l.d, l.h, l.mi, l.s) - Math.floor(ms / 1000) * 1000) / 60000)
}

const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0')

/** An instant as RFC 3339 `date-time` with the offset of a zone, or in UTC with `Z` when no zone is given. */
export function formatInstant(ms: number, zone?: string): string {
  if (!zone) return utc(ms)
  const l = toLocal(ms, zone)
  const off = offsetMinutes(zone, ms)
  const sign = off < 0 ? '-' : '+'
  return `${pad(l.y, 4)}-${pad(l.m)}-${pad(l.d)}T${pad(l.h)}:${pad(l.mi)}:${pad(l.s)}${sign}${pad(Math.trunc(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
}

/** An instant in UTC, to the second, with `Z` (common §8). */
export function utc(ms: number): string {
  return `${new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19)}Z`
}

/** An instant Google answers about an item, as the profiles write it; `undefined` for one that does not parse. */
export function instantOf(value: string | undefined): string | undefined {
  if (!value) return undefined
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? undefined : utc(ms)
}

/** The instant of midnight of a date in a zone (the start of an all-day event, for ordering). */
export function midnightIn(date: string, zone: string | undefined): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const asUtc = Date.UTC(y, m - 1, d)
  if (!zone || !knownZone(zone)) return asUtc
  let guess = asUtc - offsetMinutes(zone, asUtc) * 60000
  guess = asUtc - offsetMinutes(zone, guess) * 60000
  return guess
}

/** A date moved by a number of days. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

/** The days between two dates. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}
