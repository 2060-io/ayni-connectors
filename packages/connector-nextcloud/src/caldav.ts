/**
 * Calendar 1.0 over CalDAV (RFC 4791), for any server, a Nextcloud included (providers §4): the calendars of the
 * account's calendar home (FEAT-CALDAV-002), events read whole and their occurrences worked out here (003), a change
 * that keeps everything it does not change and is written with `If-Match` (004), a creation with a new `UID`, `DTSTAMP`
 * and the definition of its zone with `If-None-Match: *` (005), invitations only where the server schedules (006), and
 * calendars that are not portable (007).
 */
import { randomUUID } from 'node:crypto'
import type {
  Calendar,
  CalendarCalendarsArgs,
  CalendarCancelEventArgs,
  CalendarCreateEventArgs,
  CalendarDeclaration,
  CalendarEvent,
  CalendarFreeBusyArgs,
  CalendarGetEventArgs,
  CalendarListEventsArgs,
  CalendarRespondArgs,
  CalendarUpdateEventArgs,
  InviteeInput,
} from '@ayni.org/ayni-feature-profiles'
import { type CallContext, errors, type Logger, type PagedContext, pageByKey } from '@ayni.org/ayni-provider-kit'
import type { DavAccountData } from './account.js'
import {
  type DavResource,
  hrefsOf,
  NS,
  type PropName,
  parseMultistatus,
  prop,
  propfind,
  propText,
  statusError,
  xmlns,
} from './dav.js'
import {
  addressOf,
  findOccurrence,
  isMine,
  isOwn,
  isSeries,
  occurrencesOf,
  parseRidText,
  partsOf,
  type ReadContext,
  ridText,
  type Times,
  timesOfEvent,
  toEvent,
  zoneResolver,
} from './events.js'
import type { DavResponse, HttpClient } from './http.js'
import {
  type Component,
  escapeText,
  getProp,
  getProps,
  type ICalTime,
  type Param,
  type Property,
  paramOf,
  parseICalendar,
  removeProps,
  serializeICalendar,
  setParam,
  setProp,
  textOf,
  timeOf,
} from './ical.js'
import { partsBelow, urlBelow } from './paths.js'
import {
  fromUtcFields,
  ianaNameOf,
  ianaZone,
  icalLocal,
  icalUtc,
  toLocal,
  UTC_ZONE,
  vtimezoneLines,
  type Zone,
} from './tz.js'
import { childOf, childrenOf, parseXml, textOf as xmlText } from './xml.js'

type Ctx = CallContext<DavAccountData, CalendarDeclaration>
type Paged = PagedContext<DavAccountData, CalendarDeclaration>

/** What the account's calendar server says of it, found from the request's address (FEAT-CALDAV-002). */
export interface CalendarAccount {
  /** the calendar home */
  home: URL
  /** the account's addresses, `mailto:` left out, in lower case */
  addresses: string[]
  /** the account's own name, for ORGANIZER */
  name?: string
  /** the path of the calendar where invitations arrive (RFC 6638 `schedule-default-calendar-URL`) */
  defaultCalendar?: string
  outbox?: URL
}

export interface CalendarSession {
  http: HttpClient
  /** found once per request, at the first call that needs it */
  account(signal?: AbortSignal): Promise<CalendarAccount>
  /** the server announces `calendar-auto-schedule` (RFC 6638): it delivers invitations and answers */
  scheduling: boolean
  /** the server announces `calendar-no-timezone` (RFC 7809): no `VTIMEZONE` is written */
  noTimezone: boolean
  logger: Logger
}

const CALENDAR_PROPS: PropName[] = [
  [NS.D, 'resourcetype'],
  [NS.D, 'displayname'],
  [NS.C, 'supported-calendar-component-set'],
  [NS.C, 'calendar-description'],
  [NS.C, 'calendar-timezone'],
  [NS.C, 'calendar-timezone-id'],
  [NS.D, 'current-user-privilege-set'],
]

const DAY = 86_400_000
const PRODID = '-//Ayni//connector-nextcloud 0.1//EN'

/** The account's calendars and addresses, from a principal (RFC 5397, RFC 4791 §6.2.1, RFC 6638 §2). */
export async function accountOfPrincipal(
  http: HttpClient,
  principal: URL,
  signal?: AbortSignal
): Promise<CalendarAccount> {
  const [p] = await propfind(
    http,
    principal,
    '0',
    [
      [NS.C, 'calendar-home-set'],
      [NS.C, 'calendar-user-address-set'],
      [NS.C, 'schedule-inbox-URL'],
      [NS.C, 'schedule-outbox-URL'],
      [NS.D, 'displayname'],
    ],
    signal
  )
  const homeHref = p ? hrefsOf(p, NS.C, 'calendar-home-set')[0] : undefined
  if (!p || !homeHref) throw errors.unavailable('The server names no calendars of the account.')
  const home = new URL(homeHref, principal)
  if (!home.pathname.endsWith('/')) home.pathname = `${home.pathname}/`
  if (!http.allows(home)) throw errors.unavailable('The server names calendars elsewhere.')
  const addresses = hrefsOf(p, NS.C, 'calendar-user-address-set')
    .map((h) => (/^mailto:/i.test(h) ? h.slice(7).trim().toLowerCase() : undefined))
    .filter((a): a is string => !!a)
  const name = propText(p, NS.D, 'displayname')
  const account: CalendarAccount = { home, addresses, ...(name ? { name } : {}) }
  const inboxHref = hrefsOf(p, NS.C, 'schedule-inbox-URL')[0]
  const outboxHref = hrefsOf(p, NS.C, 'schedule-outbox-URL')[0]
  if (outboxHref) {
    const outbox = new URL(outboxHref, principal)
    if (http.allows(outbox)) account.outbox = outbox
  }
  if (inboxHref) {
    const inbox = new URL(inboxHref, principal)
    if (http.allows(inbox)) {
      try {
        const [i] = await propfind(http, inbox, '0', [[NS.C, 'schedule-default-calendar-URL']], signal)
        const d = i ? hrefsOf(i, NS.C, 'schedule-default-calendar-URL')[0] : undefined
        if (d) {
          const u = new URL(d, inbox)
          const parts = partsBelow(u.toString(), home)
          if (parts?.length === 1) account.defaultCalendar = urlBelow(home, parts, true).pathname
        }
      } catch {
        // a server whose inbox says nothing of a default calendar: the first calendar is the main one
      }
    }
  }
  return account
}

/**
 * The account of a server that is not a Nextcloud (providers §4): the address itself when it holds calendars; else
 * `/.well-known/caldav` (RFC 6764), followed on the same host only, and the `current-user-principal` (RFC 5397) there
 * or at the address, then its `calendar-home-set`.
 */
export async function discoverCaldav(http: HttpClient, address: URL, signal?: AbortSignal): Promise<CalendarAccount> {
  let here: DavResource[] = []
  try {
    here = await propfind(
      http,
      address,
      '1',
      [
        [NS.D, 'resourcetype'],
        [NS.D, 'current-user-principal'],
      ],
      signal
    )
  } catch (e) {
    // an address that is no collection of the server (its root, say): the well-known address is asked next
    if ((e as { code?: string }).code === 'account-refused') throw e
  }
  const self = here.find((r) => partsBelow(r.href, address)?.length === 0)
  const principalAt = (r: DavResource | undefined, base: URL) => {
    const h = r ? hrefsOf(r, NS.D, 'current-user-principal')[0] : undefined
    return h ? new URL(h, base) : undefined
  }
  const holdsCalendars = here.some(
    (r) => partsBelow(r.href, address)?.length === 1 && !!childOf(prop(r, NS.D, 'resourcetype'), NS.C, 'calendar')
  )
  let principal = principalAt(self, address)
  if (!principal) {
    let wk = new URL('/.well-known/caldav', address)
    for (let hop = 0; hop < 3 && !principal; hop++) {
      const res = await http.send(
        {
          method: 'PROPFIND',
          url: wk,
          headers: { depth: '0', 'content-type': 'application/xml; charset=utf-8' },
          body: `<?xml version="1.0" encoding="utf-8"?><d:propfind ${xmlns()}><d:prop><d:current-user-principal/></d:prop></d:propfind>`,
        },
        signal
      )
      if (res.status === 207) principal = principalAt(parseMultistatus(res.body)[0], wk)
      else if ([301, 302, 307, 308].includes(res.status) && res.headers.location) {
        const next = new URL(res.headers.location, wk)
        // a redirection is followed on the host of the address alone, never elsewhere (FEAT-DAV-002)
        if (next.origin !== address.origin || !http.allows(next)) break
        wk = next
      } else break
    }
  }
  if (holdsCalendars) {
    const account = principal && http.allows(principal) ? await accountOfPrincipal(http, principal, signal) : undefined
    return account ? { ...account, home: address } : { home: address, addresses: [] }
  }
  if (!principal || !http.allows(principal)) throw errors.unavailable('The server names no calendars of the account.')
  return accountOfPrincipal(http, principal, signal)
}

function privileges(r: DavResource): string[] {
  return childrenOf(prop(r, NS.D, 'current-user-privilege-set'), NS.D, 'privilege').flatMap((p) =>
    childrenOf(p).map((x) => x.name)
  )
}

function takesEvents(r: DavResource): boolean {
  if (!childOf(prop(r, NS.D, 'resourcetype'), NS.C, 'calendar')) return false
  const set = prop(r, NS.C, 'supported-calendar-component-set')
  if (!set) return true
  return childrenOf(set, NS.C, 'comp').some((c) => (c.attrs.name ?? '').toUpperCase() === 'VEVENT')
}

/** The zone a calendar keeps its floating times in: `calendar-timezone-id` (RFC 7809), or its `calendar-timezone`. */
function zoneOfCalendar(r: DavResource): { zone: Zone; name?: string } {
  const id = propText(r, NS.C, 'calendar-timezone-id')
  const fromId = id ? ianaNameOf(id) : undefined
  if (fromId) return { zone: ianaZone(fromId), name: fromId }
  const tz = propText(r, NS.C, 'calendar-timezone')
  if (tz) {
    try {
      const vcal = parseICalendar(tz)
      const vtz = vcal.components.find((c) => c.name === 'VTIMEZONE')
      const tzid = vtz ? textOf(vtz, 'TZID') : undefined
      if (tzid) {
        const name = ianaNameOf(tzid)
        return { zone: zoneResolver(vcal, UTC_ZONE)(tzid), ...(name ? { name } : {}) }
      }
    } catch {
      // a definition that cannot be read: UTC
    }
  }
  return { zone: UTC_ZONE }
}

interface CalendarAt {
  ref: string
  url: URL
  res: DavResource
  zone: Zone
  writable: boolean
}

const ascii = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase())

/** An event's reference read back: its resource, and an occurrence's original start. */
interface EventRef {
  name: string
  url: URL
  /** the reference of the event or series, without an occurrence */
  href: string
  rid?: { allDay: boolean; ms: number }
}

/** A resource's object, read with its entity tag. */
interface Stored {
  vcal: Component
  etag: string
}

export class CalDav {
  public constructor(private readonly s: CalendarSession) {}

  private get http() {
    return this.s.http
  }

  // ---- calendars ------------------------------------------------------------------------------------------------

  private calendarRef(home: URL, name: string): string {
    return urlBelow(home, [name], true).pathname
  }

  /** The calendar of a call: a calendar of the account's home that takes events, else `not-found`. */
  private async calendarAt(ref: string, signal?: AbortSignal): Promise<CalendarAt> {
    const a = await this.s.account(signal)
    if (!ref.startsWith('/')) throw errors.notFound()
    const parts = partsBelow(ref, a.home)
    if (parts?.length !== 1) throw errors.notFound()
    const url = urlBelow(a.home, parts, true)
    const [r] = await propfind(this.http, url, '0', CALENDAR_PROPS, signal)
    if (!r || !takesEvents(r)) throw errors.notFound()
    const p = privileges(r)
    return {
      ref: url.pathname,
      url,
      res: r,
      zone: zoneOfCalendar(r).zone,
      writable: !p.length || p.some((x) => ['all', 'write', 'write-content', 'bind'].includes(x)),
    }
  }

  public async calendars(args: Omit<CalendarCalendarsArgs, 'limit' | 'cursor'>, ctx: Paged) {
    const a = await this.s.account(ctx.signal)
    const all = await propfind(this.http, a.home, '1', CALENDAR_PROPS, ctx.signal)
    const found: Calendar[] = []
    for (const r of all) {
      const parts = partsBelow(r.href, a.home)
      if (parts?.length !== 1 || !takesEvents(r)) continue
      const name = parts[0] as string
      const p = privileges(r)
      const zone = zoneOfCalendar(r)
      const description = propText(r, NS.C, 'calendar-description')
      found.push({
        ref: this.calendarRef(a.home, name),
        title: propText(r, NS.D, 'displayname') ?? name,
        ...(description ? { description } : {}),
        ...(zone.name ? { timeZone: zone.name } : {}),
        writable: !p.length || p.some((x) => ['all', 'write', 'write-content', 'bind'].includes(x)),
        portable: false,
      })
    }
    found.sort((x, y) => (x.ref < y.ref ? -1 : x.ref > y.ref ? 1 : 0))
    const main = (a.defaultCalendar && found.find((c) => c.ref === a.defaultCalendar)) ?? found.find((c) => c.writable)
    if (main) main.primary = true
    const kept = args.query ? found.filter((c) => ascii(c.title).includes(ascii(args.query as string))) : found
    const page = pageByKey(kept, (c) => c.ref, ctx.page)
    return { calendars: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }
  }

  // ---- reading --------------------------------------------------------------------------------------------------

  private eventRef(cal: CalendarAt, ref: string): EventRef {
    const hash = ref.indexOf('#')
    const path = hash < 0 ? ref : ref.slice(0, hash)
    if (!path.startsWith(cal.ref)) throw errors.notFound()
    const parts = partsBelow(path, cal.url)
    if (parts?.length !== 1) throw errors.notFound()
    const name = parts[0] as string
    const url = urlBelow(cal.url, [name])
    const out: EventRef = { name, url, href: url.pathname }
    if (hash >= 0) {
      const rid = parseRidText(ref.slice(hash + 1))
      if (!rid) throw errors.notFound()
      out.rid = rid
    }
    return out
  }

  private async load(url: URL, signal?: AbortSignal): Promise<Stored> {
    const res = await this.http.send({ method: 'GET', url, headers: { accept: 'text/calendar' } }, signal)
    if (res.status !== 200) throw statusError(res)
    let etag: string | undefined = res.headers.etag
    if (!etag) {
      const [r] = await propfind(this.http, url, '0', [[NS.D, 'getetag']], signal)
      etag = r ? propText(r, NS.D, 'getetag') : undefined
    }
    let vcal: Component
    try {
      vcal = parseICalendar(res.body.toString('utf8'))
    } catch {
      throw errors.unavailable('The server holds an event that cannot be read.')
    }
    return { vcal, etag: etag ?? '"none"' }
  }

  private readContext(cal: CalendarAt, href: string, etag: string, account: CalendarAccount): ReadContext {
    return { calendar: cal.ref, href, etag, addresses: account.addresses, floating: cal.zone }
  }

  /** The event a reference names in an object: the event, the series once with its rule, or one occurrence. */
  private eventOf(cal: CalendarAt, er: EventRef, stored: Stored, account: CalendarAccount): CalendarEvent {
    const ctx = this.readContext(cal, er.href, stored.etag, account)
    const zoneOf = zoneResolver(stored.vcal, cal.zone)
    const { master, overrides } = partsOf(stored.vcal)
    if (er.rid) {
      const o = findOccurrence(stored.vcal, cal.zone, er.rid.ms)
      if (!o) throw errors.notFound()
      return toEvent(ctx, o.component, o.times, `${er.href}#${ridText(o.times.allDay, o.rid)}`, true, zoneOf, {
        series: er.href,
      })
    }
    const base = master ?? overrides[0]
    const t = base ? timesOfEvent(base, zoneOf) : undefined
    if (!base || !t) throw errors.notFound()
    if (!master) {
      return toEvent(ctx, base, t, `${er.href}#${ridText(t.allDay, t.start)}`, true, zoneOf, { series: er.href })
    }
    const series = isSeries(master)
    const rule = getProp(master, 'RRULE')?.value.toUpperCase()
    return toEvent(ctx, master, t, er.href, series, zoneOf, rule && series ? { rule } : {})
  }

  public async getEvent(args: CalendarGetEventArgs, ctx: Ctx) {
    const cal = await this.calendarAt(args.calendar, ctx.signal)
    const er = this.eventRef(cal, args.ref)
    const account = await this.s.account(ctx.signal)
    return { event: this.eventOf(cal, er, await this.load(er.url, ctx.signal), account) }
  }

  private async query(cal: CalendarAt, from: number, to: number, signal?: AbortSignal): Promise<DavResource[]> {
    const body =
      `<?xml version="1.0" encoding="utf-8"?><c:calendar-query ${xmlns()}><d:prop><d:getetag/><c:calendar-data/></d:prop>` +
      `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${icalUtc(from)}" end="${icalUtc(to)}"/>` +
      '</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>'
    const res = await this.http.send(
      {
        method: 'REPORT',
        url: cal.url,
        headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8' },
        body,
      },
      signal
    )
    if (res.status !== 207 || res.truncated) throw res.truncated ? errors.unavailable() : statusError(res)
    return parseMultistatus(res.body)
  }

  public async listEvents(args: Omit<CalendarListEventsArgs, 'limit' | 'cursor'>, ctx: Paged) {
    const cal = await this.calendarAt(args.calendar, ctx.signal)
    const account = await this.s.account(ctx.signal)
    const from = Date.parse(args.from)
    const to = Date.parse(args.to)
    // a day on each side: a server reads all-day and floating times in a zone of its own; the connector keeps exactly
    const found = await this.query(cal, from - DAY, to + DAY, ctx.signal)
    const events: CalendarEvent[] = []
    for (const r of found) {
      const parts = partsBelow(r.href, cal.url)
      if (parts?.length !== 1) continue
      const data = propText(r, NS.C, 'calendar-data')
      if (!data) continue
      let vcal: Component
      try {
        vcal = parseICalendar(data)
      } catch {
        ctx.logger.warn({ tool: 'calendar_list_events' }, 'an event of the calendar cannot be read')
        continue
      }
      const href = urlBelow(cal.url, parts).pathname
      const rctx = this.readContext(cal, href, propText(r, NS.D, 'getetag') ?? '"none"', account)
      const zoneOf = zoneResolver(vcal, cal.zone)
      const { master } = partsOf(vcal)
      const series = isSeries(master) || !master
      for (const o of occurrencesOf(vcal, cal.zone, from, to)) {
        const ref = series ? `${href}#${ridText(o.times.allDay, o.rid)}` : href
        events.push(toEvent(rctx, o.component, o.times, ref, series, zoneOf, series ? { series: href } : {}))
      }
    }
    const q = args.query ? ascii(args.query) : undefined
    const kept = q
      ? events.filter((e) => [e.title, e.description ?? '', e.place ?? ''].some((x) => ascii(x).includes(q)))
      : events
    const startOf = (e: CalendarEvent) => (e.allDay ? Date.parse(`${e.start}T00:00:00Z`) : Date.parse(e.start))
    const key = (e: CalendarEvent) => `${String(startOf(e) + 1e15).padStart(17, '0')}\u0000${e.ref}`
    const page = pageByKey(kept, key, ctx.page)
    return { events: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }
  }

  // ---- writing --------------------------------------------------------------------------------------------------

  /** DTSTART or DTEND of a creation or a change: a day, a wall clock in the zone named, or UTC (calendar §1). */
  private timeProp(name: string, value: string, allDay: boolean, zone: string | undefined): Property {
    if (allDay) return { name, params: [{ name: 'VALUE', values: ['DATE'] }], value: value.replace(/-/g, '') }
    const ms = Date.parse(value)
    if (zone && zone !== 'UTC')
      return { name, params: [{ name: 'TZID', values: [zone] }], value: icalLocal(toLocal(ms, ianaZone(zone))) }
    return { name, params: [], value: icalUtc(ms) }
  }

  /** A time of the series' form (`RECURRENCE-ID`, `EXDATE`): the master's DTSTART's kind and zone at an instant. */
  private seriesTime(name: string, master: Component, ms: number, zoneOf: (t: string | undefined) => Zone): Property {
    const st = getProp(master, 'DTSTART')
    const t = st ? (timeOf(master, 'DTSTART') as ICalTime) : undefined
    if (t?.kind === 'date') {
      const l = fromUtcFields(ms)
      return { name, params: [{ name: 'VALUE', values: ['DATE'] }], value: icalLocal(l).slice(0, 8) }
    }
    if (t?.kind === 'local') {
      const tzid = paramOf(st, 'TZID')
      return {
        name,
        params: tzid ? [{ name: 'TZID', values: [tzid] }] : [],
        value: icalLocal(toLocal(ms, zoneOf(tzid))),
      }
    }
    return { name, params: [], value: icalUtc(ms) }
  }

  private organizerOf(account: CalendarAccount): Property {
    const address = account.addresses[0]
    if (!address) throw errors.notSupported('The server names no address of the account to invite from.', 'attendees')
    return {
      name: 'ORGANIZER',
      params: account.name ? [{ name: 'CN', values: [account.name] }] : [],
      value: `mailto:${address}`,
    }
  }

  private attendeeProps(list: InviteeInput[], notify: boolean): Property[] {
    return list.map((a) => {
      const params: Param[] = [
        { name: 'CUTYPE', values: ['INDIVIDUAL'] },
        { name: 'ROLE', values: [a.optional ? 'OPT-PARTICIPANT' : 'REQ-PARTICIPANT'] },
        { name: 'PARTSTAT', values: ['NEEDS-ACTION'] },
        { name: 'RSVP', values: ['TRUE'] },
      ]
      if (a.name) params.push({ name: 'CN', values: [a.name] })
      // notify false: the server sends nothing to this person (RFC 6638 §7.1, providers §4)
      if (!notify) params.push({ name: 'SCHEDULE-AGENT', values: ['NONE'] })
      return { name: 'ATTENDEE', params, value: `mailto:${a.address}` }
    })
  }

  /** The definitions of the zones an object names, from the database, unless the server takes none (RFC 7809). */
  private withZones(vcal: Component, around: number): void {
    if (this.s.noTimezone) return
    const named = new Set<string>()
    for (const ev of vcal.components.filter((c) => c.name === 'VEVENT'))
      for (const p of ev.props) {
        const tz = paramOf(p, 'TZID')
        if (tz) named.add(tz)
      }
    for (const tz of named) {
      if (vcal.components.some((c) => c.name === 'VTIMEZONE' && textOf(c, 'TZID') === tz)) continue
      const iana = ianaNameOf(tz)
      if (!iana || iana === 'UTC') continue
      const vtz = parseICalendar(vtimezoneLines(iana, around).join('\r\n'))
      vcal.components.unshift(vtz)
    }
  }

  private async write(url: URL, vcal: Component, headers: Record<string, string>, signal?: AbortSignal) {
    return this.http.send(
      {
        method: 'PUT',
        url,
        headers: { 'content-type': 'text/calendar; charset=utf-8', ...headers },
        body: serializeICalendar(vcal),
      },
      signal
    )
  }

  private writeError(res: DavResponse, current: () => Promise<string>): Promise<Error> | Error {
    if (res.status === 412) return current().then((v) => errors.versionMismatch(v))
    if (res.status === 403) return errors.permissionDenied('The server does not let the account change this calendar.')
    return statusError(res)
  }

  public async createEvent(args: CalendarCreateEventArgs, ctx: Ctx) {
    const cal = await this.calendarAt(args.calendar, ctx.signal)
    if (!cal.writable) throw errors.permissionDenied('This calendar may only be read.')
    const account = await this.s.account(ctx.signal)
    const allDay = args.allDay ?? false
    const uid = randomUUID()
    const now = icalUtc(Date.now())
    const ev: Component = { name: 'VEVENT', props: [], components: [] }
    setProp(ev, 'UID', uid)
    setProp(ev, 'DTSTAMP', now)
    setProp(ev, 'CREATED', now)
    setProp(ev, 'LAST-MODIFIED', now)
    setProp(ev, 'SEQUENCE', '0')
    setProp(ev, 'SUMMARY', escapeText(args.title))
    ev.props.push(this.timeProp('DTSTART', args.start, allDay, args.timeZone))
    ev.props.push(this.timeProp('DTEND', args.end, allDay, args.timeZone))
    if (args.description) setProp(ev, 'DESCRIPTION', escapeText(args.description))
    if (args.place) setProp(ev, 'LOCATION', escapeText(args.place))
    setProp(ev, 'TRANSP', args.busy === false ? 'TRANSPARENT' : 'OPAQUE')
    if (args.rule) setProp(ev, 'RRULE', args.rule.replace(/^RRULE:/i, '').toUpperCase())
    if (args.attendees?.length) {
      ev.props.push(this.organizerOf(account))
      ev.props.push(...this.attendeeProps(args.attendees, args.notify !== false))
    }
    const vcal: Component = {
      name: 'VCALENDAR',
      props: [
        { name: 'VERSION', params: [], value: '2.0' },
        { name: 'PRODID', params: [], value: PRODID },
        { name: 'CALSCALE', params: [], value: 'GREGORIAN' },
      ],
      components: [ev],
    }
    this.withZones(vcal, allDay ? Date.parse(`${args.start}T00:00:00Z`) : Date.parse(args.start))
    const name = `${uid}.ics`
    const url = urlBelow(cal.url, [name])
    const res = await this.write(url, vcal, { 'if-none-match': '*' }, ctx.signal)
    if (![200, 201, 204].includes(res.status)) {
      if (res.status === 412) throw errors.alreadyExists()
      throw await this.writeError(res, async () => '')
    }
    const er: EventRef = { name, url, href: url.pathname }
    return { event: this.eventOf(cal, er, await this.load(url, ctx.signal), account) }
  }

  /** The component a change or an answer acts on, made for one occurrence when it has none of its own. */
  private occurrenceComponent(vcal: Component, master: Component, rid: number, zone: Zone, times: Times): Component {
    const zoneOf = zoneResolver(vcal, zone)
    const ridProp = this.seriesTime('RECURRENCE-ID', master, rid, zoneOf)
    for (const o of vcal.components.filter((c) => c.name === 'VEVENT' && c !== master)) {
      const p = getProp(o, 'RECURRENCE-ID')
      if (p && p.value === ridProp.value) return o
    }
    const copy: Component = {
      name: 'VEVENT',
      props: master.props
        .filter((p) => !['RRULE', 'RDATE', 'EXDATE', 'DTSTART', 'DTEND', 'DURATION'].includes(p.name))
        .map((p) => ({ ...p, params: p.params.map((x) => ({ ...x, values: [...x.values] })) })),
      components: master.components.map((c) => structuredClone(c)),
    }
    copy.props.push(ridProp)
    copy.props.push(this.seriesTime('DTSTART', master, times.start, zoneOf))
    copy.props.push(this.seriesTime('DTEND', master, times.end, zoneOf))
    vcal.components.push(copy)
    return copy
  }

  private async loadFor(cal: CalendarAt, ref: string, signal?: AbortSignal) {
    const er = this.eventRef(cal, ref)
    const stored = await this.load(er.url, signal)
    const { master } = partsOf(stored.vcal)
    return { er, stored, master }
  }

  /** `If-Match`: the version given, when it is one (a version that is no entity tag is no version of the event). */
  private ifMatch(given: string | undefined, stored: Stored): string {
    if (given === undefined) return stored.etag
    if (given !== stored.etag || !/^(W\/)?"[\x21\x23-\x7e]*"$/.test(given)) throw errors.versionMismatch(stored.etag)
    return given
  }

  public async updateEvent(args: CalendarUpdateEventArgs, ctx: Ctx) {
    const cal = await this.calendarAt(args.calendar, ctx.signal)
    const account = await this.s.account(ctx.signal)
    const { er, stored, master } = await this.loadFor(cal, args.ref, ctx.signal)
    const vcal = stored.vcal
    const zoneOf = zoneResolver(vcal, cal.zone)
    const ifMatch = this.ifMatch(args.ifVersion, stored)
    const target = er.rid ? findOccurrence(vcal, cal.zone, er.rid.ms) : undefined
    if (er.rid && !target) throw errors.notFound()
    const base = target?.component ?? master
    if (!base) throw errors.notFound()
    if (!isMine(base, account.addresses))
      throw errors.permissionDenied('Only an event the account organizes can be changed.')
    const scope = args.scope ?? 'this'
    const onSeries = !er.rid || scope === 'series'
    if (args.rule !== undefined && !onSeries)
      throw errors.invalidArgument('rule', 'A change of the rule is of the series: give scope "series".')
    // the components the change reaches: the series' master (and its overrides for what is not a time), or one
    let comps: Component[]
    let delta = 0
    if (er.rid && scope === 'this' && master && target) {
      comps = [this.occurrenceComponent(vcal, master, target.rid, cal.zone, target.times)]
    } else if (er.rid && target && master) {
      comps = [master]
      if (args.start !== undefined) delta = Date.parse(args.start) - target.times.start
    } else comps = [base]
    const primary = comps[0] as Component
    const times = timesOfEvent(primary, zoneOf)
    let significant = false
    const apply = (c: Component, withTimes: boolean) => {
      if (args.title !== undefined) setProp(c, 'SUMMARY', escapeText(args.title))
      if (args.description !== undefined) {
        if (args.description === '') removeProps(c, 'DESCRIPTION')
        else setProp(c, 'DESCRIPTION', escapeText(args.description))
      }
      if (args.place !== undefined) {
        significant = true
        if (args.place === '') removeProps(c, 'LOCATION')
        else setProp(c, 'LOCATION', escapeText(args.place))
      }
      if (args.busy !== undefined) setProp(c, 'TRANSP', args.busy ? 'OPAQUE' : 'TRANSPARENT')
      if (args.attendees !== undefined) {
        removeProps(c, 'ATTENDEE')
        if (args.attendees.length) {
          if (!getProp(c, 'ORGANIZER')) c.props.push(this.organizerOf(account))
          c.props.push(...this.attendeeProps(args.attendees, args.notify !== false))
        } else removeProps(c, 'ORGANIZER')
      } else if (args.notify !== undefined)
        for (const a of getProps(c, 'ATTENDEE')) setParam(a, 'SCHEDULE-AGENT', args.notify ? undefined : 'NONE')
      if (withTimes) this.changeTimes(c, args, times, delta, () => (significant = true))
      const s = getProp(c, 'SEQUENCE')
      if (significant || (withTimes && (args.start !== undefined || args.timeZone !== undefined)))
        setProp(c, 'SEQUENCE', String((s && /^\d+$/.test(s.value) ? Number(s.value) : 0) + 1))
      const now = icalUtc(Date.now())
      setProp(c, 'LAST-MODIFIED', now)
      setProp(c, 'DTSTAMP', now)
    }
    if (args.rule !== undefined && master) {
      setProp(master, 'RRULE', args.rule.replace(/^RRULE:/i, '').toUpperCase())
      significant = true
    }
    apply(primary, true)
    // a change of the series reaches the occurrences changed one by one, but for their times (FEAT-CAL-033)
    if (onSeries && master && primary === master)
      for (const o of vcal.components.filter((c) => c.name === 'VEVENT' && c !== master)) apply(o, false)
    this.withZones(vcal, times?.start ?? Date.now())
    const res = await this.write(er.url, vcal, { 'if-match': ifMatch }, ctx.signal)
    if (![200, 201, 204].includes(res.status))
      throw await this.writeError(res, async () => (await this.load(er.url, ctx.signal)).etag)
    const again = await this.load(er.url, ctx.signal)
    const outRef: EventRef = er.rid && scope === 'this' ? er : { name: er.name, url: er.url, href: er.href }
    return { event: this.eventOf(cal, outRef, again, account) }
  }

  /** The times of a change (calendar §3.5): start and end together, the zone, all day or not. */
  private changeTimes(
    c: Component,
    args: CalendarUpdateEventArgs,
    times: Times | undefined,
    delta: number,
    changed: () => void
  ): void {
    const wasAllDay = times?.allDay ?? false
    const allDay = args.allDay ?? wasAllDay
    if (args.start === undefined && args.allDay !== undefined && args.allDay !== wasAllDay)
      throw errors.invalidArgument('start', 'A change to or from all day gives the new start and end.')
    if (args.start !== undefined && args.end !== undefined) {
      changed()
      const zone = args.timeZone ?? (times?.tzName && !allDay ? times.tzName : undefined)
      removeProps(c, 'DURATION')
      if (delta && times && !allDay) {
        // a change of the series made with an occurrence: the series moves by as much as the occurrence
        const st = times.start + delta
        const en = st + (Date.parse(args.end) - Date.parse(args.start))
        c.props = c.props.filter((p) => p.name !== 'DTSTART' && p.name !== 'DTEND')
        c.props.push(
          this.timeProp('DTSTART', new Date(st).toISOString(), false, zone),
          this.timeProp('DTEND', new Date(en).toISOString(), false, zone)
        )
        return
      }
      c.props = c.props.filter((p) => p.name !== 'DTSTART' && p.name !== 'DTEND')
      c.props.push(this.timeProp('DTSTART', args.start, allDay, zone), this.timeProp('DTEND', args.end, allDay, zone))
      return
    }
    if (args.timeZone !== undefined && times && !times.allDay) {
      changed()
      removeProps(c, 'DURATION')
      c.props = c.props.filter((p) => p.name !== 'DTSTART' && p.name !== 'DTEND')
      c.props.push(
        this.timeProp('DTSTART', new Date(times.start).toISOString(), false, args.timeZone),
        this.timeProp('DTEND', new Date(times.end).toISOString(), false, args.timeZone)
      )
    }
  }

  public async cancelEvent(args: CalendarCancelEventArgs, ctx: Ctx) {
    if (args.comment !== undefined)
      throw errors.notSupported(
        "A cancellation over CalDAV carries no line of the organizer's: the server's message holds none.",
        'comment'
      )
    const cal = await this.calendarAt(args.calendar, ctx.signal)
    const account = await this.s.account(ctx.signal)
    const { er, stored, master } = await this.loadFor(cal, args.ref, ctx.signal)
    const vcal = stored.vcal
    let ifMatch = this.ifMatch(args.ifVersion, stored)
    const target = er.rid ? findOccurrence(vcal, cal.zone, er.rid.ms) : undefined
    if (er.rid && !target) throw errors.notFound()
    const base = target?.component ?? master
    if (!base) throw errors.notFound()
    if (!isMine(base, account.addresses))
      throw errors.permissionDenied('Only an event the account organizes can be cancelled.')
    const one = er.rid && (args.scope ?? 'this') === 'this' && master && target
    if (args.notify === false) {
      // nobody is told: the server is asked to schedule for nobody before the change (RFC 6638 §7.1)
      let marked = false
      for (const ev of vcal.components.filter((c) => c.name === 'VEVENT'))
        for (const a of getProps(ev, 'ATTENDEE')) {
          setParam(a, 'SCHEDULE-AGENT', 'NONE')
          marked = true
        }
      if (marked) {
        const res = await this.write(er.url, vcal, { 'if-match': ifMatch }, ctx.signal)
        if (![200, 201, 204].includes(res.status))
          throw await this.writeError(res, async () => (await this.load(er.url, ctx.signal)).etag)
        ifMatch = (await this.load(er.url, ctx.signal)).etag
      }
    }
    if (one && master && target) {
      const zoneOf = zoneResolver(vcal, cal.zone)
      const ex = this.seriesTime('EXDATE', master, target.rid, zoneOf)
      vcal.components = vcal.components.filter((c) => {
        if (c.name !== 'VEVENT' || c === master) return true
        const rid = getProp(c, 'RECURRENCE-ID')
        return !rid || rid.value !== this.seriesTime('RECURRENCE-ID', master, target.rid, zoneOf).value
      })
      master.props.push(ex)
      const s = getProp(master, 'SEQUENCE')
      setProp(master, 'SEQUENCE', String((s && /^\d+$/.test(s.value) ? Number(s.value) : 0) + 1))
      setProp(master, 'DTSTAMP', icalUtc(Date.now()))
      const res = await this.write(er.url, vcal, { 'if-match': ifMatch }, ctx.signal)
      if (![200, 201, 204].includes(res.status))
        throw await this.writeError(res, async () => (await this.load(er.url, ctx.signal)).etag)
      return { cancelled: true as const, ref: args.ref }
    }
    const res = await this.http.send({ method: 'DELETE', url: er.url, headers: { 'if-match': ifMatch } }, ctx.signal)
    if (![200, 204].includes(res.status)) {
      if (res.status === 404) throw errors.notFound()
      throw await this.writeError(res, async () => (await this.load(er.url, ctx.signal)).etag)
    }
    return { cancelled: true as const, ref: args.ref }
  }

  // ---- busy times -----------------------------------------------------------------------------------------------

  public async freeBusy(args: CalendarFreeBusyArgs, ctx: Ctx) {
    const cal = await this.calendarAt(args.calendar, ctx.signal)
    const from = Date.parse(args.from)
    const to = Date.parse(args.to)
    const body = `<?xml version="1.0" encoding="utf-8"?><c:free-busy-query ${xmlns()}><c:time-range start="${icalUtc(from)}" end="${icalUtc(to)}"/></c:free-busy-query>`
    const res = await this.http.send(
      {
        method: 'REPORT',
        url: cal.url,
        headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8' },
        body,
      },
      ctx.signal
    )
    if (res.status !== 200) throw statusError(res)
    const busy = busyOf(res.body.toString('utf8'), from, to)
    const out: { calendar: { busy: { start: string; end: string }[] }; people?: Person[] } = { calendar: { busy } }
    if (args.people) out.people = await this.peopleBusy(args.people, from, to, ctx)
    return out
  }

  /** Other people's busy times through the server's scheduling (RFC 6638 §5): `known: false` where it cannot tell. */
  private async peopleBusy(people: string[], from: number, to: number, ctx: Ctx): Promise<Person[]> {
    const unknown = (address: string): Person => ({ address, known: false, busy: [] })
    const account = await this.s.account(ctx.signal)
    if (!this.s.scheduling || !account.outbox || !account.addresses[0]) return people.map(unknown)
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      `PRODID:${PRODID}`,
      'METHOD:REQUEST',
      'BEGIN:VFREEBUSY',
      `UID:${randomUUID()}`,
      `DTSTAMP:${icalUtc(Date.now())}`,
      `DTSTART:${icalUtc(from)}`,
      `DTEND:${icalUtc(to)}`,
      `ORGANIZER:mailto:${account.addresses[0]}`,
      ...people.map((p) => `ATTENDEE:mailto:${p}`),
      'END:VFREEBUSY',
      'END:VCALENDAR',
    ]
    const res = await this.http.send(
      {
        method: 'POST',
        url: account.outbox,
        headers: { 'content-type': 'text/calendar; charset=utf-8; method=REQUEST' },
        body: `${lines.join('\r\n')}\r\n`,
      },
      ctx.signal
    )
    if (res.status !== 200) return people.map(unknown)
    const answers = new Map<string, Person>()
    try {
      const root = parseXml(res.body.toString('utf8'))
      for (const r of childrenOf(root, NS.C, 'response')) {
        const recipient = xmlText(childOf(childOf(r, NS.C, 'recipient'), NS.D, 'href')).trim()
        const address = addressOf(recipient)?.toLowerCase()
        const status = xmlText(childOf(r, NS.C, 'request-status')).trim()
        const data = xmlText(childOf(r, NS.C, 'calendar-data'))
        if (!address) continue
        answers.set(address, {
          address,
          known: status.startsWith('2.') && !!data,
          busy: status.startsWith('2.') && data ? busyOf(data, from, to) : [],
        })
      }
    } catch {
      return people.map(unknown)
    }
    return people.map((p) => {
      const a = answers.get(p.toLowerCase())
      return a ? { ...a, address: p } : unknown(p)
    })
  }

  // ---- answers --------------------------------------------------------------------------------------------------

  public async respond(args: CalendarRespondArgs, ctx: Ctx) {
    if (args.comment !== undefined)
      throw errors.notSupported(
        "An answer over CalDAV carries no line of the attendee's: the server's holds none.",
        'comment'
      )
    const cal = await this.calendarAt(args.calendar, ctx.signal)
    const account = await this.s.account(ctx.signal)
    const { er, stored, master } = await this.loadFor(cal, args.ref, ctx.signal)
    const vcal = stored.vcal
    const target = er.rid ? findOccurrence(vcal, cal.zone, er.rid.ms) : undefined
    if (er.rid && !target) throw errors.notFound()
    const base = target?.component ?? master
    if (!base) throw errors.notFound()
    const own = (c: Component) => getProps(c, 'ATTENDEE').filter((a) => isOwn(a, account.addresses))
    if (isMine(base, account.addresses) || own(base).length === 0)
      throw errors.notSupported('The account is not invited to this event: it organizes it, or is not on its list.')
    const partstat = args.response.toUpperCase()
    const set = (c: Component) => {
      for (const a of own(c)) {
        setParam(a, 'PARTSTAT', partstat)
        setParam(a, 'RSVP', undefined)
      }
      setProp(c, 'DTSTAMP', icalUtc(Date.now()))
    }
    if (er.rid && (args.scope ?? 'this') === 'this' && master && target)
      set(this.occurrenceComponent(vcal, master, target.rid, cal.zone, target.times))
    else for (const c of vcal.components.filter((x) => x.name === 'VEVENT')) if (own(c).length) set(c)
    const headers: Record<string, string> = { 'if-match': stored.etag }
    // notify false: the server sends the organizer no answer (RFC 6638 §8.1)
    if (args.notify === false) headers['schedule-reply'] = 'F'
    const res = await this.write(er.url, vcal, headers, ctx.signal)
    if (![200, 201, 204].includes(res.status))
      throw await this.writeError(res, async () => (await this.load(er.url, ctx.signal)).etag)
    const again = await this.load(er.url, ctx.signal)
    return { event: this.eventOf(cal, er, again, account) }
  }
}

interface Person {
  address: string
  known: boolean
  busy: { start: string; end: string }[]
}

/** The busy times of a VFREEBUSY, within the time asked, merged and in order (FEAT-CAL-020). */
export function busyOf(ics: string, from: number, to: number): { start: string; end: string }[] {
  let vcal: Component
  try {
    vcal = parseICalendar(ics)
  } catch {
    return []
  }
  const spans: [number, number][] = []
  const fbs = vcal.components.filter((c) => c.name === 'VFREEBUSY')
  for (const fb of fbs)
    for (const p of getProps(fb, 'FREEBUSY')) {
      const type = (paramOf(p, 'FBTYPE') ?? 'BUSY').toUpperCase()
      if (type === 'FREE') continue
      for (const period of p.value.split(',')) {
        const [a, b] = period.split('/')
        const s = a
          ? Date.parse(a.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, '$1-$2-$3T$4:$5:$6Z'))
          : Number.NaN
        let e = Number.NaN
        if (b?.startsWith('P') || b?.startsWith('+P')) {
          const m = /^\+?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(b)
          if (m)
            e =
              s +
              ((Number(m[1] ?? 0) * 7 + Number(m[2] ?? 0)) * 86400 +
                Number(m[3] ?? 0) * 3600 +
                Number(m[4] ?? 0) * 60 +
                Number(m[5] ?? 0)) *
                1000
        } else if (b) e = Date.parse(b.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, '$1-$2-$3T$4:$5:$6Z'))
        if (Number.isNaN(s) || Number.isNaN(e)) continue
        const cs = Math.max(s, from)
        const ce = Math.min(e, to)
        if (ce > cs) spans.push([cs, ce])
      }
    }
  spans.sort((x, y) => x[0] - y[0])
  const merged: [number, number][] = []
  for (const sp of spans) {
    const last = merged[merged.length - 1]
    if (last && sp[0] <= last[1]) last[1] = Math.max(last[1], sp[1])
    else merged.push([...sp])
  }
  const z = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}Z`
  return merged.map(([s, e]) => ({ start: z(s), end: z(e) }))
}
