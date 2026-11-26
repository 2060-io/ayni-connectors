/**
 * The events of a CalDAV resource as Calendar 1.0 answers them (calendar §1, providers §4): a resource's path is the
 * event's reference, followed for one occurrence by `#` and its original start in UTC (`…/a1b2.ics#20261123T090000Z`,
 * a day for an all-day series); the occurrences are worked out here (FEAT-CALDAV-003), the overriding components and
 * `EXDATE`s of the object taken in.
 */
import type { Attendee, AttendeeResponse, CalendarEvent, EventStatus } from '@ayni.org/ayni-feature-profiles'
import {
  type Component,
  getProp,
  getProps,
  type ICalTime,
  type Property,
  paramOf,
  parseDuration,
  textOf,
  timeOf,
  timesOf,
} from './ical.js'
import { compareLocal, expandRule, parseRRule } from './rrule.js'
import {
  formatDate,
  formatInstant,
  fromUtcFields,
  ianaNameOf,
  ianaZone,
  type Local,
  localAsUtc,
  toInstant,
  toLocal,
  UTC_ZONE,
  type Zone,
} from './tz.js'

/** What the events of one resource are read with. */
export interface ReadContext {
  /** the reference of the calendar of the call */
  calendar: string
  /** the resource's path, the reference of its event or series */
  href: string
  etag: string
  /** the account's addresses (`mailto:` left out, in lower case), to tell `mine` and `self` */
  addresses: string[]
  /** the calendar's own zone, for floating times (calendar §1, FEAT-CAL-015) */
  floating: Zone
}

/** The zone of a `TZID` of an object: the IANA zone it names, or the object's own `VTIMEZONE`. */
export function zoneResolver(vcal: Component, floating: Zone): (tzid: string | undefined) => Zone {
  const cache = new Map<string, Zone>()
  return (tzid) => {
    if (!tzid) return floating
    const known = cache.get(tzid)
    if (known) return known
    const iana = ianaNameOf(tzid)
    let zone: Zone = iana ? ianaZone(iana) : floating
    if (!iana) {
      const vtz = vcal.components.find((c) => c.name === 'VTIMEZONE' && textOf(c, 'TZID') === tzid)
      if (vtz) zone = customZone(vtz)
    }
    cache.set(tzid, zone)
    return zone
  }
}

function offsetMinutesOf(v: string | undefined): number | undefined {
  const m = v ? /^([+-])(\d\d)(\d\d)(\d\d)?$/.exec(v.trim()) : null
  if (!m) return undefined
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
}

/** A zone an object defines itself (RFC 5545 §3.6.5): the observance in force at an instant. */
export function customZone(vtz: Component): Zone {
  const observances = vtz.components
    .filter((c) => c.name === 'STANDARD' || c.name === 'DAYLIGHT')
    .map((c) => {
      const start = timeOf(c, 'DTSTART')
      const from = offsetMinutesOf(textOf(c, 'TZOFFSETFROM'))
      const to = offsetMinutesOf(textOf(c, 'TZOFFSETTO'))
      return { c, start, from: from ?? to ?? 0, to: to ?? 0 }
    })
    .filter((o) => o.start && o.start.kind === 'local')
  return {
    offsetAt(ms) {
      let best: { at: number; to: number } | undefined
      let earliest: { at: number; from: number } | undefined
      const year = new Date(ms).getUTCFullYear()
      for (const o of observances) {
        const s = (o.start as { kind: 'local'; l: Local }).l
        const onsets: Local[] = [s]
        const rule = getProp(o.c, 'RRULE')
        const r = rule ? parseRRule(rule.value) : undefined
        if (r)
          onsets.push(
            ...expandRule(
              r,
              s,
              false,
              () => true,
              (l) => l.y > year + 1,
              2000
            ).slice(1)
          )
        for (const rd of getProps(o.c, 'RDATE')) for (const t of timesOf(rd)) if (t.kind === 'local') onsets.push(t.l)
        for (const l of onsets) {
          const at = localAsUtc(l) - o.from * 60000
          if (!earliest || at < earliest.at) earliest = { at, from: o.from }
          if (at <= ms && (!best || at > best.at)) best = { at, to: o.to }
        }
      }
      return best?.to ?? earliest?.from ?? 0
    },
  }
}

/** A VEVENT's times: all-day by days, timed by instants, with the zone it is read in. */
export interface Times {
  allDay: boolean
  /** an instant; for an all-day event, midnight UTC of its day */
  start: number
  end: number
  /** the zone of a timed event's wall clock: its TZID's, UTC, or the calendar's for a floating time */
  zone: Zone
  /** the IANA name of the event's TZID, for `timeZone` */
  tzName?: string
}

const DAY = 86_400_000

function instantOf(t: ICalTime, zoneOf: (tzid: string | undefined) => Zone): number {
  if (t.kind === 'date') return Date.UTC(t.y, t.m - 1, t.d)
  if (t.kind === 'utc') return t.ms
  return toInstant(t.l, zoneOf(t.tzid))
}

/** The times of a VEVENT, from DTSTART and DTEND or DURATION (an all-day event of no end lasts a day). */
export function timesOfEvent(ev: Component, zoneOf: (tzid: string | undefined) => Zone): Times | undefined {
  const st = timeOf(ev, 'DTSTART')
  if (!st) return undefined
  const allDay = st.kind === 'date'
  const zone = st.kind === 'utc' ? UTC_ZONE : st.kind === 'local' ? zoneOf(st.tzid) : UTC_ZONE
  const start = instantOf(st, zoneOf)
  let end: number
  const en = timeOf(ev, 'DTEND')
  const dur = getProp(ev, 'DURATION')
  if (en) end = instantOf(en, zoneOf)
  else if (dur) {
    const d = parseDuration(dur.value)
    if (!d) end = allDay ? start + DAY : start
    else if (allDay) end = start + (d.days + Math.ceil(d.seconds / 86400)) * DAY
    else {
      const wall = toLocal(start, zone)
      const shifted = toInstant(fromUtcFields(localAsUtc(wall) + d.days * DAY), zone)
      end = shifted + d.seconds * 1000
    }
  } else end = allDay ? start + DAY : start
  if (end < start) end = start
  const tzid = st.kind === 'local' ? st.tzid : undefined
  const tzName = tzid ? ianaNameOf(tzid) : undefined
  return { allDay, start, end, zone, ...(tzName ? { tzName } : {}) }
}

/** The text of an occurrence's original start in a reference: a day, or an instant in UTC. */
export function ridText(allDay: boolean, ms: number): string {
  const l = fromUtcFields(ms)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  const day = `${p(l.y, 4)}${p(l.m)}${p(l.d)}`
  return allDay ? day : `${day}T${p(l.h)}${p(l.mi)}${p(l.s)}Z`
}

export function parseRidText(text: string): { allDay: boolean; ms: number } | undefined {
  const d = /^(\d{4})(\d\d)(\d\d)$/.exec(text)
  if (d) return { allDay: true, ms: Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3])) }
  const t = /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/.exec(text)
  if (!t) return undefined
  return {
    allDay: false,
    ms: Date.UTC(Number(t[1]), Number(t[2]) - 1, Number(t[3]), Number(t[4]), Number(t[5]), Number(t[6])),
  }
}

/** The instant a RECURRENCE-ID names, read with the master's zone where it gives none of its own. */
function ridOf(ev: Component, zoneOf: (tzid: string | undefined) => Zone, masterZone?: string): number | undefined {
  const p = getProp(ev, 'RECURRENCE-ID')
  if (!p) return undefined
  const t = timesOf(p)[0]
  if (!t) return undefined
  if (t.kind === 'local' && !t.tzid && masterZone) return toInstant(t.l, zoneOf(masterZone))
  return instantOf(t, zoneOf)
}

const PARTSTAT: Record<string, AttendeeResponse> = {
  'NEEDS-ACTION': 'needs-action',
  ACCEPTED: 'accepted',
  TENTATIVE: 'tentative',
  DECLINED: 'declined',
}

export function addressOf(value: string): string | undefined {
  const v = value.trim()
  if (/^mailto:/i.test(v)) {
    const a = v.slice(7).trim()
    return a || undefined
  }
  return /^[^\s@:/]+@[^\s@/]+$/.test(v) ? v : undefined
}

/** A person's line (ORGANIZER, ATTENDEE) is the account's when its address is one of the account's. */
export function isOwn(p: Property, addresses: string[]): boolean {
  const a = addressOf(p.value)?.toLowerCase()
  return !!a && addresses.includes(a)
}

function attendeesOf(ev: Component, addresses: string[]): Attendee[] {
  const out: Attendee[] = []
  for (const p of getProps(ev, 'ATTENDEE')) {
    const cutype = (paramOf(p, 'CUTYPE') ?? 'INDIVIDUAL').toUpperCase()
    if (cutype === 'ROOM' || cutype === 'RESOURCE') continue
    const address = addressOf(p.value)
    if (!address) continue
    const name = paramOf(p, 'CN')
    const a: Attendee = {
      address,
      ...(name ? { name } : {}),
      response: PARTSTAT[(paramOf(p, 'PARTSTAT') ?? 'NEEDS-ACTION').toUpperCase()] ?? 'needs-action',
    }
    if ((paramOf(p, 'ROLE') ?? '').toUpperCase() === 'OPT-PARTICIPANT') a.optional = true
    if (addresses.includes(address.toLowerCase())) a.self = true
    out.push(a)
  }
  return out
}

/** Whether the account organizes an event: no ORGANIZER, or one of its own addresses (providers §4, `mine`). */
export function isMine(ev: Component, addresses: string[]): boolean {
  const o = getProp(ev, 'ORGANIZER')
  return !o || isOwn(o, addresses)
}

const utcText = (ms: number) => formatInstant(ms)

function icalUtcToMs(t: ICalTime | undefined, zoneOf: (tzid: string | undefined) => Zone): number | undefined {
  return t ? instantOf(t, zoneOf) : undefined
}

/** An event as the profile answers it, from the component that holds its members and its times. */
export function toEvent(
  ctx: ReadContext,
  ev: Component,
  times: Times,
  ref: string,
  recurring: boolean,
  zoneOf: (tzid: string | undefined) => Zone,
  extra: { series?: string; rule?: string } = {}
): CalendarEvent {
  const status = (textOf(ev, 'STATUS') ?? 'CONFIRMED').toLowerCase()
  const e: CalendarEvent = {
    ref,
    calendar: ctx.calendar,
    title: textOf(ev, 'SUMMARY') ?? '',
    allDay: times.allDay,
    start: times.allDay ? dateText(times.start) : formatInstant(times.start, times.zone),
    end: times.allDay ? dateText(times.end) : formatInstant(times.end, times.zone),
    status: (['confirmed', 'tentative', 'cancelled'].includes(status) ? status : 'confirmed') as EventStatus,
    busy: (textOf(ev, 'TRANSP') ?? 'OPAQUE').toUpperCase() !== 'TRANSPARENT',
    mine: isMine(ev, ctx.addresses),
    recurring,
    version: ctx.etag,
  }
  const uid = textOf(ev, 'UID')
  if (uid) e.uid = uid
  const description = textOf(ev, 'DESCRIPTION')
  if (description) e.description = description
  const place = textOf(ev, 'LOCATION')
  if (place) e.place = place
  if (!times.allDay && times.tzName) e.timeZone = times.tzName
  const org = getProp(ev, 'ORGANIZER')
  if (org) {
    const address = addressOf(org.value)
    const name = paramOf(org, 'CN')
    if (address || name) e.organizer = { ...(address ? { address } : {}), ...(name ? { name } : {}) }
  }
  const attendees = attendeesOf(ev, ctx.addresses)
  if (attendees.length) e.attendees = attendees
  if (extra.series) e.series = extra.series
  if (extra.rule) e.rule = extra.rule
  const conf = getProp(ev, 'CONFERENCE')
  if (conf && /^https?:\/\//i.test(conf.value.trim())) {
    const label = paramOf(conf, 'LABEL')
    e.meeting = { url: conf.value.trim(), ...(label ? { label } : {}) }
  }
  const created = icalUtcToMs(timeOf(ev, 'CREATED'), zoneOf)
  if (created !== undefined) e.createdAt = utcText(created)
  const modified = icalUtcToMs(timeOf(ev, 'LAST-MODIFIED'), zoneOf)
  if (modified !== undefined) e.modifiedAt = utcText(modified)
  return e
}

function dateText(ms: number): string {
  const l = fromUtcFields(ms)
  return formatDate(l.y, l.m, l.d)
}

/** The VEVENTs of an object: the master (no RECURRENCE-ID) and the overriding components. */
export function partsOf(vcal: Component): { master?: Component; overrides: Component[] } {
  const events = vcal.components.filter((c) => c.name === 'VEVENT')
  const master = events.find((c) => !getProp(c, 'RECURRENCE-ID'))
  return { ...(master ? { master } : {}), overrides: events.filter((c) => c !== master) }
}

export function isSeries(master: Component | undefined): boolean {
  return !!master && (!!getProp(master, 'RRULE') || !!getProp(master, 'RDATE'))
}

/** An occurrence of a series: its original start, and the component that holds its members. */
export interface Occurrence {
  rid: number
  component: Component
  times: Times
  /** an overriding component, rather than the master's members at another time */
  overridden: boolean
}

/**
 * The occurrences of an object whose start is before `to` and whose end is after `from` (or that start at `from`, for
 * an event of no length), `EXDATE`s left out and overriding components put in.
 */
export function occurrencesOf(vcal: Component, floating: Zone, from: number, to: number): Occurrence[] {
  const zoneOf = zoneResolver(vcal, floating)
  const { master, overrides } = partsOf(vcal)
  const overlaps = (t: Times) => {
    const s = t.allDay ? toInstant({ ...fromUtcFields(t.start), h: 0, mi: 0, s: 0 }, floating) : t.start
    const e = t.allDay ? toInstant({ ...fromUtcFields(t.end), h: 0, mi: 0, s: 0 }, floating) : t.end
    return s < to && (e > from || (e === s && s >= from))
  }
  const out: Occurrence[] = []
  if (!master) {
    for (const o of overrides) {
      const t = timesOfEvent(o, zoneOf)
      const rid = ridOf(o, zoneOf)
      if (t && rid !== undefined && overlaps(t)) out.push({ rid, component: o, times: t, overridden: true })
    }
    return out
  }
  const mt = timesOfEvent(master, zoneOf)
  if (!mt) return out
  if (!isSeries(master)) {
    if (overlaps(mt)) out.push({ rid: mt.start, component: master, times: mt, overridden: false })
    return out
  }
  const masterTzid = paramOf(getProp(master, 'DTSTART'), 'TZID')
  const byRid = new Map<number, Component>()
  for (const o of overrides) {
    const rid = ridOf(o, zoneOf, masterTzid)
    if (rid !== undefined) byRid.set(rid, o)
  }
  const gone = excludedOf(master, mt, zoneOf)
  // each occurrence keeps the length of the first; its wall clock follows the zone across a change of offset
  for (const rid of seriesStarts(master, mt, zoneOf, to)) {
    if (gone.has(rid) || byRid.has(rid)) continue
    const t: Times = { ...mt, start: rid, end: rid + (mt.end - mt.start) }
    if (overlaps(t)) out.push({ rid, component: master, times: t, overridden: false })
  }
  for (const [rid, o] of byRid) {
    if (gone.has(rid)) continue
    const t = timesOfEvent(o, zoneOf)
    if (t && overlaps(t)) out.push({ rid, component: o, times: t, overridden: true })
  }
  return out
}

/** The original starts of a series' occurrences that begin before `to`: the rule's and the RDATEs. */
export function seriesStarts(master: Component, mt: Times, zoneOf: (tzid: string | undefined) => Zone, to: number) {
  const st = timeOf(master, 'DTSTART') as ICalTime
  const zone = mt.zone
  const startLocal: Local =
    st.kind === 'date'
      ? { y: st.y, m: st.m, d: st.d, h: 0, mi: 0, s: 0 }
      : st.kind === 'utc'
        ? fromUtcFields(st.ms)
        : st.l
  const toMs = (l: Local) => (mt.allDay ? localAsUtc({ ...l, h: 0, mi: 0, s: 0 }) : toInstant(l, zone))
  const out = new Set<number>([mt.start])
  const ruleProp = getProp(master, 'RRULE')
  const rule = ruleProp ? parseRRule(ruleProp.value) : undefined
  if (rule) {
    const until = rule.until
      ? (timesOf({ name: 'UNTIL', params: [], value: rule.until })[0] as ICalTime | undefined)
      : undefined
    const untilOk = (l: Local) => {
      if (!until) return true
      if (until.kind === 'date')
        return compareLocal({ ...l, h: 0, mi: 0, s: 0 }, { y: until.y, m: until.m, d: until.d, h: 0, mi: 0, s: 0 }) <= 0
      if (until.kind === 'utc') return toMs(l) <= until.ms
      return compareLocal(l, until.l) <= 0
    }
    // the allDay series reach by days; a margin of a day for zones east of UTC
    for (const l of expandRule(rule, startLocal, mt.allDay, untilOk, (l) => toMs(l) >= to + (mt.allDay ? DAY : 0)))
      out.add(toMs(l))
  }
  for (const p of getProps(master, 'RDATE'))
    for (const t of timesOf(p)) {
      const ms = t.kind === 'date' ? Date.UTC(t.y, t.m - 1, t.d) : instantOf(t, zoneOf)
      if (ms < to + DAY) out.add(ms)
    }
  return [...out].sort((a, b) => a - b)
}

/** The instants an EXDATE of a master leaves out, a day for an all-day series. */
function excludedOf(master: Component, mt: Times, zoneOf: (tzid: string | undefined) => Zone): Set<number> {
  const masterTzid = paramOf(getProp(master, 'DTSTART'), 'TZID')
  const out = new Set<number>()
  for (const p of getProps(master, 'EXDATE'))
    for (const t of timesOf(p)) {
      const ms = t.kind === 'local' && !t.tzid && masterTzid ? toInstant(t.l, zoneOf(masterTzid)) : instantOf(t, zoneOf)
      const day = new Date(ms)
      out.add(mt.allDay ? Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) : ms)
    }
  return out
}

/** One occurrence of an object by its original start: an overriding component, or the master's at that time. */
export function findOccurrence(vcal: Component, floating: Zone, rid: number): Occurrence | undefined {
  const zoneOf = zoneResolver(vcal, floating)
  const { master, overrides } = partsOf(vcal)
  const masterTzid = master ? paramOf(getProp(master, 'DTSTART'), 'TZID') : undefined
  for (const o of overrides)
    if (ridOf(o, zoneOf, masterTzid) === rid) {
      const t = timesOfEvent(o, zoneOf)
      if (t) return { rid, component: o, times: t, overridden: true }
    }
  if (!master || !isSeries(master)) return undefined
  const mt = timesOfEvent(master, zoneOf)
  if (!mt || excludedOf(master, mt, zoneOf).has(rid)) return undefined
  if (!seriesStarts(master, mt, zoneOf, rid + 1).includes(rid)) return undefined
  return { rid, component: master, times: { ...mt, start: rid, end: rid + (mt.end - mt.start) }, overridden: false }
}

/** The instants of a master's EXDATEs, for a reader outside this module. */
export function excluded(master: Component, floating: Zone, vcal: Component): Set<number> {
  const zoneOf = zoneResolver(vcal, floating)
  const mt = timesOfEvent(master, zoneOf)
  return mt ? excludedOf(master, mt, zoneOf) : new Set()
}

export { ridOf }
