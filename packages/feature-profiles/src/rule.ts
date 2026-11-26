/**
 * The part of an iCalendar `RRULE` (RFC 5545 §3.3.10) that Calendar 1.0 takes (calendar §4.2): `FREQ` among `DAILY`,
 * `WEEKLY`, `MONTHLY` and `YEARLY`; `INTERVAL`; `BYDAY` (days of the week for a weekly rule; one day with its rank for
 * a monthly or yearly one); `BYMONTHDAY` (one day); `BYMONTH` (one month); one of `COUNT` and `UNTIL` at most. Any other
 * part answers `not-supported` with `field: "rule"`.
 */

export type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
export type Weekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU'

export const WEEKDAYS: readonly Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']

export interface Rule {
  freq: Frequency
  interval?: number
  /** a weekly rule's days, or a monthly or yearly rule's one day with its rank */
  byDay?: { day: Weekday; rank?: number }[]
  byMonthDay?: number
  byMonth?: number
  count?: number
  /** `UNTIL` as written: a date (`20261231`) or a date-time in UTC (`20261231T235959Z`) */
  until?: string
}

export type RuleOutcome = { rule: Rule } | { error: 'invalid-argument' | 'not-supported'; message: string }

const FREQUENCIES = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'])
/** valid `FREQ` values of RFC 5545 that the profile does not take */
const OTHER_FREQUENCIES = new Set(['SECONDLY', 'MINUTELY', 'HOURLY'])
const TAKEN = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'COUNT', 'UNTIL'])

function invalid(message: string): RuleOutcome {
  return { error: 'invalid-argument', message }
}
function unsupported(message: string): RuleOutcome {
  return { error: 'not-supported', message }
}

function positiveInteger(value: string): number | undefined {
  return /^[1-9]\d{0,5}$/.test(value) ? Number(value) : undefined
}

/** Reads a rule as the profile takes it, or says why it is refused. */
export function parseRule(text: string): RuleOutcome {
  const parts = new Map<string, string>()
  for (const part of text
    .trim()
    .replace(/^RRULE:/i, '')
    .split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) return invalid('The rule is not an RRULE value: each part is NAME=VALUE.')
    const name = part.slice(0, eq).toUpperCase()
    if (parts.has(name)) return invalid(`The rule gives ${name} twice.`)
    parts.set(name, part.slice(eq + 1))
  }
  for (const name of parts.keys())
    if (!TAKEN.has(name)) return unsupported(`The rule's part ${name} is not taken by Calendar 1.0.`)
  const freqText = parts.get('FREQ')?.toUpperCase()
  if (!freqText) return invalid('The rule has no FREQ.')
  if (OTHER_FREQUENCIES.has(freqText)) return unsupported(`FREQ=${freqText} is not taken by Calendar 1.0.`)
  if (!FREQUENCIES.has(freqText)) return invalid(`FREQ=${freqText} is not a frequency of RFC 5545.`)
  const freq = freqText as Frequency
  const rule: Rule = { freq }

  const interval = parts.get('INTERVAL')
  if (interval !== undefined) {
    const n = positiveInteger(interval)
    if (n === undefined) return invalid('INTERVAL is a positive integer.')
    rule.interval = n
  }

  const byDay = parts.get('BYDAY')
  if (byDay !== undefined) {
    const days: { day: Weekday; rank?: number }[] = []
    for (const entry of byDay.toUpperCase().split(',')) {
      const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(entry)
      if (!m) return invalid(`BYDAY holds ${entry}, which is no day of the week.`)
      const rank = m[1] === undefined ? undefined : Number(m[1])
      if (rank === 0 || (rank !== undefined && Math.abs(rank) > 53))
        return invalid('A rank of BYDAY is 1 to 53 or -53 to -1.')
      days.push({ day: m[2] as Weekday, ...(rank !== undefined ? { rank } : {}) })
    }
    if (freq === 'WEEKLY') {
      if (days.some((d) => d.rank !== undefined))
        return unsupported('A weekly rule takes days of the week without a rank.')
      if (new Set(days.map((d) => d.day)).size !== days.length) return invalid('BYDAY names a day twice.')
    } else if (freq === 'MONTHLY' || freq === 'YEARLY') {
      if (days.length !== 1 || days[0]?.rank === undefined)
        return unsupported('A monthly or yearly rule takes one day of BYDAY, with its rank (2TU, -1FR).')
      if (Math.abs(days[0].rank) > 5) return unsupported('A rank of BYDAY is 1 to 5 or -5 to -1 in Calendar 1.0.')
    } else {
      return unsupported('A daily rule takes no BYDAY in Calendar 1.0.')
    }
    rule.byDay = days
  }

  const byMonthDay = parts.get('BYMONTHDAY')
  if (byMonthDay !== undefined) {
    if (byMonthDay.includes(',')) return unsupported('BYMONTHDAY takes one day in Calendar 1.0.')
    const n = /^([1-9]|[12]\d|3[01])$/.test(byMonthDay) ? Number(byMonthDay) : undefined
    if (n === undefined) {
      if (/^-([1-9]|[12]\d|3[01])$/.test(byMonthDay))
        return unsupported('BYMONTHDAY counts from the start of the month in Calendar 1.0.')
      return invalid('BYMONTHDAY is a day of the month, 1 to 31.')
    }
    if (freq !== 'MONTHLY' && freq !== 'YEARLY') return unsupported('BYMONTHDAY goes with a monthly or a yearly rule.')
    if (rule.byDay) return unsupported('A rule takes BYDAY or BYMONTHDAY, not both, in Calendar 1.0.')
    rule.byMonthDay = n
  }

  const byMonth = parts.get('BYMONTH')
  if (byMonth !== undefined) {
    if (byMonth.includes(',')) return unsupported('BYMONTH takes one month in Calendar 1.0.')
    const n = /^([1-9]|1[0-2])$/.test(byMonth) ? Number(byMonth) : undefined
    if (n === undefined) return invalid('BYMONTH is a month, 1 to 12.')
    if (freq !== 'YEARLY') return unsupported('BYMONTH goes with a yearly rule in Calendar 1.0.')
    rule.byMonth = n
  }

  const count = parts.get('COUNT')
  const until = parts.get('UNTIL')
  if (count !== undefined && until !== undefined) return unsupported('A rule takes one of COUNT and UNTIL at most.')
  if (count !== undefined) {
    const n = positiveInteger(count)
    if (n === undefined) return invalid('COUNT is a positive integer.')
    rule.count = n
  }
  if (until !== undefined) {
    const u = until.toUpperCase()
    if (!/^\d{8}(T\d{6}Z)?$/.test(u))
      return invalid('UNTIL is a date (20261231) or a date-time in UTC (20261231T235959Z).')
    rule.until = u
  }
  return { rule }
}

/** A rule written as §4.2 writes it: its parts in one order, upper case. */
export function formatRule(rule: Rule): string {
  const parts = [`FREQ=${rule.freq}`]
  if (rule.interval !== undefined && rule.interval !== 1) parts.push(`INTERVAL=${rule.interval}`)
  if (rule.byDay) parts.push(`BYDAY=${rule.byDay.map((d) => `${d.rank ?? ''}${d.day}`).join(',')}`)
  if (rule.byMonthDay !== undefined) parts.push(`BYMONTHDAY=${rule.byMonthDay}`)
  if (rule.byMonth !== undefined) parts.push(`BYMONTH=${rule.byMonth}`)
  if (rule.count !== undefined) parts.push(`COUNT=${rule.count}`)
  if (rule.until !== undefined) parts.push(`UNTIL=${rule.until}`)
  return parts.join(';')
}
