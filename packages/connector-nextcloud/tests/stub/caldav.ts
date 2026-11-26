/**
 * The stub's CalDAV (RFC 4791) and its scheduling (RFC 6638), as Sabre in Nextcloud answers them: principals with their
 * calendar home, addresses, inbox and outbox; a home that holds calendars, a task list, an inbox, an outbox and a trash
 * bin; `calendar-query` (which ignores `expand`, and answers every repeating object whatever its times), and
 * `free-busy-query`; objects under their entity tags; and, where scheduling is on, invitations, changes, cancellations
 * and answers delivered between the people of the server, and recorded as the messages the server would send.
 */
import {
  type Component,
  getProp,
  getProps,
  type Property,
  paramOf,
  parseICalendar,
  serializeICalendar,
  setParam,
  setProp,
  textOf,
} from '../../src/ical.js'
import { childOf, childrenOf, parseXml } from '../../src/xml.js'
import { askedProps, preconditions } from './files.js'
import { davError, enc, key, multistatus, NS, type PropResource, type StubRequest, type StubResponse } from './http.js'
import type { CalObject, Store, StubCalendar, User } from './store.js'

export interface CalOptions {
  scheduling: boolean
  noTimezone: boolean
  /** the path every DAV path of the stub begins with: `/remote.php/dav/` or `/dav/` */
  dav: string
  principals: string
}

// ---- times, enough for the stub's own reading -------------------------------------------------------------------

function offsetOf(zone: string, ms: number): number {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second)
  )
  return asUtc - Math.floor(ms / 1000) * 1000
}

/** The instant of a DATE or DATE-TIME property, a floating time in the calendar's zone. */
function instantOf(p: Property | undefined, floating: string): number | undefined {
  if (!p) return undefined
  const v = p.value.trim()
  const m = /^(\d{4})(\d\d)(\d\d)(?:T(\d\d)(\d\d)(\d\d)(Z?))?$/.exec(v)
  if (!m) return undefined
  const asUtc = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4] ?? 0),
    Number(m[5] ?? 0),
    Number(m[6] ?? 0)
  )
  if (m[7] === 'Z' || m[4] === undefined) return asUtc
  const zone = paramOf(p, 'TZID') ?? floating
  try {
    const guess = asUtc - offsetOf(zone, asUtc)
    return asUtc - offsetOf(zone, guess)
  } catch {
    return asUtc
  }
}

const DAY = 86_400_000

/** The busy spans of an object: its occurrences (a small reading of the rules a test writes), less the free ones. */
function busySpans(vcal: Component, floating: string, from: number, to: number): [number, number][] {
  const out: [number, number][] = []
  const events = vcal.components.filter((c) => c.name === 'VEVENT')
  const master = events.find((e) => !getProp(e, 'RECURRENCE-ID'))
  const overrides = events.filter((e) => e !== master)
  const spanOf = (e: Component): [number, number] | undefined => {
    const s = instantOf(getProp(e, 'DTSTART'), floating)
    if (s === undefined) return undefined
    const en = instantOf(getProp(e, 'DTEND'), floating) ?? s + (getProp(e, 'DTSTART')?.value.length === 8 ? DAY : 0)
    return [s, en]
  }
  const busy = (e: Component) =>
    (textOf(e, 'TRANSP') ?? 'OPAQUE').toUpperCase() !== 'TRANSPARENT' &&
    (textOf(e, 'STATUS') ?? '').toUpperCase() !== 'CANCELLED'
  const overridden = new Set(overrides.map((o) => instantOf(getProp(o, 'RECURRENCE-ID'), floating)))
  for (const o of overrides) {
    const sp = spanOf(o)
    if (sp && busy(o)) out.push(sp)
  }
  if (!master) return out
  const first = spanOf(master)
  if (!first) return out
  const len = first[1] - first[0]
  const starts = [first[0]]
  const rule = getProp(master, 'RRULE')?.value
  if (rule) {
    const parts = Object.fromEntries(rule.split(';').map((x) => x.split('=') as [string, string]))
    const interval = Number(parts.INTERVAL ?? 1)
    const count = parts.COUNT ? Number(parts.COUNT) : undefined
    const until = parts.UNTIL ? instantOf({ name: 'UNTIL', params: [], value: parts.UNTIL }, floating) : undefined
    const step = { DAILY: DAY, WEEKLY: 7 * DAY }[parts.FREQ as string]
    const days = parts.BYDAY ? (parts.BYDAY as string).split(',') : undefined
    const wd = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
    if (step) {
      for (let k = 0; starts.length < (count ?? 5000) && k < 5000; k++) {
        const base = first[0] + k * step * interval
        const candidates =
          parts.FREQ === 'WEEKLY' && days
            ? Array.from({ length: 7 }, (_, i) => base - new Date(base).getUTCDay() * DAY + DAY + i * DAY).filter((t) =>
                days.includes(wd[new Date(t).getUTCDay()] as string)
              )
            : [base]
        for (const t of candidates) {
          if (t <= first[0] || starts.includes(t)) continue
          if ((until !== undefined && t > until) || t > to) break
          starts.push(t)
          if (count !== undefined && starts.length >= count) break
        }
        if (base > to) break
      }
    }
  }
  const ex = new Set(
    getProps(master, 'EXDATE').flatMap((p) => p.value.split(',').map((v) => instantOf({ ...p, value: v }, floating)))
  )
  if (busy(master)) for (const s of starts) if (!ex.has(s) && !overridden.has(s)) out.push([s, s + len])
  return out.filter(([s, e]) => s < to && e > from)
}

const z = (ms: number) => `${new Date(ms).toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`

function vfreebusy(spans: [number, number][], from: number, to: number, extra: string[] = []): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Sabre//Sabre VObject 4.5//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VFREEBUSY',
    `DTSTART:${z(from)}`,
    `DTEND:${z(to)}`,
    `DTSTAMP:${z(Date.now())}`,
    ...extra,
  ]
  for (const [s, e] of spans.sort((a, b) => a[0] - b[0]))
    lines.push(`FREEBUSY:${z(Math.max(s, from))}/${z(Math.min(e, to))}`)
  lines.push('END:VFREEBUSY', 'END:VCALENDAR')
  return `${lines.join('\r\n')}\r\n`
}

const address = (p: Property) => (/^mailto:/i.test(p.value) ? p.value.slice(7).trim().toLowerCase() : undefined)

export class StubCalDav {
  public constructor(
    private readonly store: Store,
    private readonly o: CalOptions
  ) {}

  private home(u: User): string {
    return `${this.o.dav}calendars/${enc(u.id)}/`
  }

  public principalProps(u: User): Map<string, string> {
    const v = new Map<string, string>()
    const home = this.home(u)
    v.set(key(NS.D, 'resourcetype'), '<d:principal/>')
    v.set(key(NS.D, 'displayname'), u.name)
    v.set(key(NS.CAL, 'calendar-home-set'), `<d:href>${home}</d:href>`)
    v.set(
      key(NS.CAL, 'calendar-user-address-set'),
      `${u.email ? `<d:href>mailto:${u.email}</d:href>` : ''}<d:href>${this.o.principals}${enc(u.id)}/</d:href>`
    )
    v.set(key(NS.CAL, 'schedule-inbox-URL'), `<d:href>${home}inbox/</d:href>`)
    v.set(key(NS.CAL, 'schedule-outbox-URL'), `<d:href>${home}outbox/</d:href>`)
    v.set(key(NS.D, 'current-user-principal'), `<d:href>${this.o.principals}${enc(u.id)}/</d:href>`)
    return v
  }

  private davHeader(): string {
    return `1, 3, extended-mkcol, access-control, calendar-access${this.o.scheduling ? ', calendar-auto-schedule' : ''}${this.o.noTimezone ? ', calendar-no-timezone' : ''}, 2`
  }

  private calendarProps(u: User, cal: StubCalendar, writable: boolean): Map<string, string> {
    const v = new Map<string, string>()
    v.set(key(NS.D, 'resourcetype'), '<d:collection/><cal:calendar/>')
    v.set(key(NS.D, 'displayname'), cal.displayName)
    v.set(
      key(NS.CAL, 'supported-calendar-component-set'),
      cal.components.map((c) => `<cal:comp name="${c}"/>`).join('')
    )
    if (cal.timezone)
      v.set(
        key(NS.CAL, 'calendar-timezone'),
        `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTIMEZONE\r\nTZID:${cal.timezone}\r\nEND:VTIMEZONE\r\nEND:VCALENDAR\r\n`
      )
    const privs = writable
      ? ['write', 'write-properties', 'write-content', 'bind', 'unbind', 'read', 'read-current-user-privilege-set']
      : ['write-properties', 'read', 'read-current-user-privilege-set']
    v.set(
      key(NS.D, 'current-user-privilege-set'),
      [
        ...privs.map((p) => `<d:privilege><d:${p}/></d:privilege>`),
        '<d:privilege><cal:read-free-busy/></d:privilege>',
      ].join('')
    )
    v.set(key(NS.OC, 'owner-principal'), `principals/users/${cal.owner}`)
    v.set(key(NS.CS, 'getctag'), `ctag-${cal.objects.size}`)
    void u
    return v
  }

  /** A request under `{dav}calendars/{user}/`. */
  public handle(req: StubRequest, u: User, below: string[]): StubResponse {
    const m = req.method
    const home = this.home(u)
    if (m === 'OPTIONS')
      return {
        status: 200,
        headers: { dav: this.davHeader(), allow: 'OPTIONS, GET, PUT, DELETE, PROPFIND, REPORT, POST' },
      }
    const cals = this.store.calendarsOf(u.id)
    if (below.length === 0 && m === 'PROPFIND') {
      const depth = req.headers.depth ?? 'infinity'
      if (depth !== '0' && depth !== '1') return davError(403, 'Forbidden')
      const asked = askedProps(req.body)
      const out: PropResource[] = [
        {
          href: home,
          values: new Map([
            [key(NS.D, 'resourcetype'), '<d:collection/>'],
            [
              key(NS.D, 'current-user-privilege-set'),
              '<d:privilege><d:read/></d:privilege><d:privilege><d:write/></d:privilege>',
            ],
          ]),
        },
      ]
      if (depth === '1') {
        for (const c of cals)
          out.push({ href: `${home}${enc(c.name)}/`, values: this.calendarProps(u, c.cal, c.writable) })
        out.push({
          href: `${home}inbox/`,
          values: new Map([[key(NS.D, 'resourcetype'), '<d:collection/><cal:schedule-inbox/>']]),
        })
        out.push({
          href: `${home}outbox/`,
          values: new Map([[key(NS.D, 'resourcetype'), '<d:collection/><cal:schedule-outbox/>']]),
        })
        out.push({
          href: `${home}trashbin/`,
          values: new Map([
            [key(NS.D, 'resourcetype'), '<d:collection/><x1:trash-bin xmlns:x1="http://nextcloud.com/ns"/>'],
          ]),
        })
        out.push({
          href: `${home}contacts/`,
          values: new Map([
            [
              key(NS.D, 'resourcetype'),
              '<d:collection/><card:addressbook xmlns:card="urn:ietf:params:xml:ns:carddav"/>',
            ],
          ]),
        })
      }
      return multistatus(out, asked)
    }
    if (below[0] === 'inbox' && below.length === 1 && m === 'PROPFIND') {
      const def = cals.find((c) => c.cal.owner === u.id && c.name === 'personal')
      return multistatus(
        [
          {
            href: `${home}inbox/`,
            values: new Map([
              [key(NS.D, 'resourcetype'), '<d:collection/><cal:schedule-inbox/>'],
              ...(def
                ? [
                    [key(NS.CAL, 'schedule-default-calendar-URL'), `<d:href>${home}${def.name}/</d:href>`] as [
                      string,
                      string,
                    ],
                  ]
                : []),
            ]),
          },
        ],
        askedProps(req.body)
      )
    }
    if (below[0] === 'outbox' && below.length === 1 && m === 'POST') return this.outbox(req, u)
    const c = cals.find((x) => x.name === below[0])
    if (!c) return davError(404, 'NotFound')
    const calHref = `${home}${enc(c.name)}/`
    if (below.length === 1) {
      if (m === 'PROPFIND') {
        const depth = req.headers.depth ?? 'infinity'
        if (depth !== '0' && depth !== '1') return davError(403, 'Forbidden')
        const out: PropResource[] = [{ href: calHref, values: this.calendarProps(u, c.cal, c.writable) }]
        if (depth === '1')
          for (const ob of c.cal.objects.values())
            out.push({
              href: `${calHref}${enc(ob.name)}`,
              values: new Map([
                [key(NS.D, 'getetag'), ob.etag],
                [key(NS.D, 'resourcetype'), ''],
              ]),
            })
        return multistatus(out, askedProps(req.body))
      }
      if (m === 'REPORT') return this.report(req, c.cal, calHref)
      return davError(405, 'MethodNotAllowed')
    }
    if (below.length !== 2) return davError(404, 'NotFound')
    const name = below[1] as string
    const existing = c.cal.objects.get(name)
    if (m === 'GET') {
      if (!existing) return davError(404, 'NotFound')
      return {
        status: 200,
        headers: { 'content-type': 'text/calendar; charset=utf-8', etag: existing.etag },
        body: existing.data,
      }
    }
    if (m === 'PUT') {
      if (!preconditions(req, existing?.etag, true)) return davError(412, 'PreconditionFailed')
      if (!c.writable) return davError(403, 'Forbidden')
      let vcal: Component
      try {
        vcal = parseICalendar(req.body.toString('utf8'))
      } catch {
        return davError(400, 'BadRequest', 'The object is not iCalendar')
      }
      const events = vcal.components.filter((x) => x.name === 'VEVENT')
      const uids = new Set(events.map((e) => textOf(e, 'UID')))
      if (vcal.name !== 'VCALENDAR' || !events.length || uids.size !== 1 || uids.has(undefined))
        return davError(400, 'BadRequest', 'An object holds one UID')
      if (!this.o.noTimezone)
        for (const e of events)
          for (const p of e.props) {
            const tz = paramOf(p, 'TZID')
            if (tz && !vcal.components.some((x) => x.name === 'VTIMEZONE' && textOf(x, 'TZID') === tz))
              return davError(400, 'BadRequest', `The object names the zone ${tz} without its VTIMEZONE`)
          }
      const before = existing ? parseICalendar(existing.data) : undefined
      const ob: CalObject = { ...this.store.object(serializeICalendar(vcal)), name }
      c.cal.objects.set(name, ob)
      if (this.o.scheduling) this.schedule(u, before, vcal, req.headers['schedule-reply']?.toUpperCase() === 'F')
      return { status: existing ? 204 : 201, headers: { etag: ob.etag } }
    }
    if (m === 'DELETE') {
      if (!existing) return davError(404, 'NotFound')
      if (!preconditions(req, existing.etag, true)) return davError(412, 'PreconditionFailed')
      if (!c.writable) return davError(403, 'Forbidden')
      c.cal.objects.delete(name)
      if (this.o.scheduling) this.schedule(u, parseICalendar(existing.data), undefined, false)
      return { status: 204 }
    }
    return davError(405, 'MethodNotAllowed')
  }

  private report(req: StubRequest, cal: StubCalendar, calHref: string): StubResponse {
    const root = parseXml(req.body.toString('utf8'))
    const floating = cal.timezone ?? 'UTC'
    const rangeOf = (el: ReturnType<typeof childOf>) => {
      const s = el?.attrs.start ? instantOf({ name: 'S', params: [], value: el.attrs.start }, 'UTC') : undefined
      const e = el?.attrs.end ? instantOf({ name: 'E', params: [], value: el.attrs.end }, 'UTC') : undefined
      return { s: s ?? -8.64e15, e: e ?? 8.64e15 }
    }
    if (root.ns === NS.CAL && root.name === 'free-busy-query') {
      const { s, e } = rangeOf(childOf(root, NS.CAL, 'time-range'))
      const spans: [number, number][] = []
      for (const ob of cal.objects.values()) spans.push(...busySpans(parseICalendar(ob.data), floating, s, e))
      return { status: 200, headers: { 'content-type': 'text/calendar; charset=utf-8' }, body: vfreebusy(spans, s, e) }
    }
    if (root.ns === NS.CAL && root.name === 'calendar-query') {
      const filter = childOf(root, NS.CAL, 'filter')
      const vev = childOf(childOf(filter, NS.CAL, 'comp-filter'), NS.CAL, 'comp-filter')
      const range = childOf(vev, NS.CAL, 'time-range')
      const { s, e } = rangeOf(range)
      const asked = childrenOf(childOf(root, NS.D, 'prop')).map((p) => [p.ns, p.name] as const)
      const out: PropResource[] = []
      for (const ob of cal.objects.values()) {
        const vcal = parseICalendar(ob.data)
        const events = vcal.components.filter((x) => x.name === 'VEVENT')
        const repeats = events.some((x) => getProp(x, 'RRULE') || getProp(x, 'RDATE') || getProp(x, 'RECURRENCE-ID'))
        const inRange =
          repeats ||
          events.some((x) => {
            const st = instantOf(getProp(x, 'DTSTART'), floating) ?? 0
            const en =
              instantOf(getProp(x, 'DTEND'), floating) ?? st + (getProp(x, 'DTSTART')?.value.length === 8 ? DAY : 0)
            return st < e && (en > s || (en === st && st >= s))
          })
        if (!inRange) continue
        out.push({
          href: `${calHref}${enc(ob.name)}`,
          values: new Map([
            [key(NS.D, 'getetag'), ob.etag],
            [key(NS.CAL, 'calendar-data'), ob.data.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')],
          ]),
        })
      }
      return multistatus(out, asked)
    }
    return davError(501, 'NotImplemented')
  }

  /** A busy-time request of the outbox (RFC 6638 §5): each attendee's times, or 3.7 for an address of nobody here. */
  private outbox(req: StubRequest, u: User): StubResponse {
    let vcal: Component
    try {
      vcal = parseICalendar(req.body.toString('utf8'))
    } catch {
      return davError(400, 'BadRequest')
    }
    const fb = vcal.components.find((c) => c.name === 'VFREEBUSY')
    const org = fb ? getProp(fb, 'ORGANIZER') : undefined
    if (!fb || !org || address(org) !== u.email?.toLowerCase())
      return davError(403, 'Forbidden', 'The organizer is not you')
    const from = instantOf(getProp(fb, 'DTSTART'), 'UTC') ?? 0
    const to = instantOf(getProp(fb, 'DTEND'), 'UTC') ?? 0
    const parts: string[] = []
    for (const a of getProps(fb, 'ATTENDEE')) {
      const addr = address(a) ?? ''
      const who = [...this.store.users.values()].find((x) => x.email?.toLowerCase() === addr)
      let status = '3.7;Invalid calendar user'
      let data = ''
      if (who) {
        const spans: [number, number][] = []
        for (const c of this.store.calendars.filter((x) => x.owner === who.id))
          for (const ob of c.objects.values())
            spans.push(...busySpans(parseICalendar(ob.data), c.timezone ?? 'UTC', from, to))
        status = '2.0;Success'
        data = vfreebusy(spans, from, to, [`ATTENDEE:mailto:${addr}`])
      }
      parts.push(
        `<cal:response><cal:recipient><d:href>mailto:${addr}</d:href></cal:recipient><cal:request-status>${status}</cal:request-status>${data ? `<cal:calendar-data>${data.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</cal:calendar-data>` : ''}</cal:response>`
      )
    }
    return {
      status: 200,
      headers: { 'content-type': 'application/xml; charset=utf-8' },
      body: `<?xml version="1.0"?>\n<cal:schedule-response xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">${parts.join('')}</cal:schedule-response>`,
    }
  }

  // ---- scheduling (RFC 6638 §3.2) -----------------------------------------------------------------------------

  /** The attendees the server schedules: as Sabre reads it, every one but SCHEDULE-AGENT=CLIENT (NONE included). */
  private attendeesOf(vcal: Component | undefined): Map<string, Property> {
    const out = new Map<string, Property>()
    for (const e of vcal?.components.filter((c) => c.name === 'VEVENT') ?? [])
      for (const a of getProps(e, 'ATTENDEE')) {
        const addr = address(a)
        const agent = (paramOf(a, 'SCHEDULE-AGENT') ?? 'SERVER').toUpperCase()
        if (addr && agent !== 'CLIENT') out.set(addr, a)
      }
    return out
  }

  private titleOf(vcal: Component): string {
    const e = vcal.components.find((c) => c.name === 'VEVENT')
    return e ? (textOf(e, 'SUMMARY') ?? '') : ''
  }

  private schedule(u: User, before: Component | undefined, after: Component | undefined, noReply: boolean): void {
    const any = after ?? before
    if (!any) return
    const master = any.components.find((c) => c.name === 'VEVENT')
    const org = master ? getProp(master, 'ORGANIZER') : undefined
    const orgAddr = org ? address(org) : undefined
    const me = u.email?.toLowerCase()
    if (!orgAddr || !me) return
    if (orgAddr === me) this.asOrganizer(u, before, after)
    else if (after && before) this.asAttendee(u, me, orgAddr, before, after, noReply)
  }

  private personal(uid: string): StubCalendar {
    return this.store.calendarOf(uid, 'personal') ?? this.store.calendar(uid, 'personal', 'Personal')
  }

  private copyOf(cal: StubCalendar, uid: string): CalObject | undefined {
    for (const ob of cal.objects.values()) {
      const v = parseICalendar(ob.data)
      if (v.components.some((c) => c.name === 'VEVENT' && textOf(c, 'UID') === uid)) return ob
    }
    return undefined
  }

  private deliver(to: string, subject: string, vcal: Component, method: string): void {
    this.store.messages.push({
      to,
      subject,
      text: `${subject}\n\n${textOf(vcal.components.find((c) => c.name === 'VEVENT') ?? vcal, 'DESCRIPTION') ?? ''}`.trim(),
    })
    const who = [...this.store.users.values()].find((x) => x.email?.toLowerCase() === to)
    if (who) {
      const box = this.store.inbox.get(who.id) ?? []
      box.push({
        ...this.store.object(
          serializeICalendar({ ...vcal, props: [...vcal.props, { name: 'METHOD', params: [], value: method }] })
        ),
        name: `${box.length}.ics`,
      })
      this.store.inbox.set(who.id, box)
    }
  }

  private asOrganizer(u: User, before: Component | undefined, after: Component | undefined): void {
    const old = this.attendeesOf(before)
    const now = this.attendeesOf(after)
    const title = this.titleOf((after ?? before) as Component)
    const uid =
      textOf(((after ?? before) as Component).components.find((c) => c.name === 'VEVENT') as Component, 'UID') ?? ''
    for (const [addr] of now) {
      if (addr === u.email?.toLowerCase()) continue
      const who = [...this.store.users.values()].find((x) => x.email?.toLowerCase() === addr)
      if (who && after) {
        const cal = this.personal(who.id)
        const mine = this.copyOf(cal, uid)
        const copy = parseICalendar(serializeICalendar(after))
        // the attendee's own answers stay as they gave them
        if (mine) {
          const theirs = parseICalendar(mine.data)
          for (const ev of copy.components.filter((c) => c.name === 'VEVENT')) {
            const rid = getProp(ev, 'RECURRENCE-ID')?.value
            const t = theirs.components.find((c) => c.name === 'VEVENT' && getProp(c, 'RECURRENCE-ID')?.value === rid)
            const theirLine = t ? getProps(t, 'ATTENDEE').find((a) => address(a) === addr) : undefined
            const line = getProps(ev, 'ATTENDEE').find((a) => address(a) === addr)
            if (line && theirLine) setParam(line, 'PARTSTAT', paramOf(theirLine, 'PARTSTAT'))
          }
        }
        const name = mine?.name ?? `${uid}.ics`
        cal.objects.set(name, { ...this.store.object(serializeICalendar(copy)), name })
      }
      this.deliver(
        addr,
        `${old.has(addr) ? 'Invitation updated' : 'Invitation'}: ${title}`,
        after as Component,
        'REQUEST'
      )
    }
    for (const [addr] of old) {
      if (now.has(addr) || addr === u.email?.toLowerCase()) continue
      const who = [...this.store.users.values()].find((x) => x.email?.toLowerCase() === addr)
      if (who) {
        const cal = this.personal(who.id)
        const mine = this.copyOf(cal, uid)
        if (mine) {
          const copy = parseICalendar(mine.data)
          for (const ev of copy.components.filter((c) => c.name === 'VEVENT')) setProp(ev, 'STATUS', 'CANCELLED')
          cal.objects.set(mine.name, { ...this.store.object(serializeICalendar(copy)), name: mine.name })
        }
      }
      this.deliver(addr, `Cancelled: ${title}`, (before ?? after) as Component, 'CANCEL')
    }
  }

  private asAttendee(
    u: User,
    me: string,
    orgAddr: string,
    before: Component,
    after: Component,
    noReply: boolean
  ): void {
    const partstats = (v: Component) =>
      new Map(
        v.components
          .filter((c) => c.name === 'VEVENT')
          .map((c) => [
            getProp(c, 'RECURRENCE-ID')?.value ?? '',
            paramOf(
              getProps(c, 'ATTENDEE').find((a) => address(a) === me),
              'PARTSTAT'
            ),
          ])
      )
    const was = partstats(before)
    const now = partstats(after)
    const changed = [...now].filter(([rid, p]) => p !== undefined && was.get(rid) !== p)
    if (!changed.length || noReply) return
    const organizer = [...this.store.users.values()].find((x) => x.email?.toLowerCase() === orgAddr)
    const uid = textOf(after.components.find((c) => c.name === 'VEVENT') as Component, 'UID') ?? ''
    if (organizer)
      for (const cal of this.store.calendars.filter((c) => c.owner === organizer.id)) {
        const ob = this.copyOf(cal, uid)
        if (!ob) continue
        const v = parseICalendar(ob.data)
        for (const [rid, p] of changed) {
          let ev = v.components.find((c) => c.name === 'VEVENT' && (getProp(c, 'RECURRENCE-ID')?.value ?? '') === rid)
          if (!ev) {
            const source = after.components.find(
              (c) => c.name === 'VEVENT' && (getProp(c, 'RECURRENCE-ID')?.value ?? '') === rid
            )
            if (!source) continue
            ev = parseICalendar(serializeICalendar({ name: 'VCALENDAR', props: [], components: [source] }))
              .components[0] as Component
            v.components.push(ev)
          }
          const line = getProps(ev, 'ATTENDEE').find((a) => address(a) === me)
          if (line && p) setParam(line, 'PARTSTAT', p)
        }
        cal.objects.set(ob.name, { ...this.store.object(serializeICalendar(v)), name: ob.name })
      }
    this.deliver(orgAddr, `Reply from ${u.name}: ${this.titleOf(after)}`, after, 'REPLY')
  }
}
