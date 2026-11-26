/**
 * A stub of the Calendar API v3, the parts the connector uses, after Google's public documentation: `calendarList.list`,
 * `events` (list with `timeMin`, `timeMax`, `singleEvents`, `orderBy=startTime`, pages; get; insert; patch with
 * `If-Match`; delete; `sendUpdates`; `conferenceDataVersion` and Google Meet), recurring events read as instances with
 * ids of their own and `recurringEventId`, an invitation in each invited account's primary calendar (one event, as
 * Google keeps one id for every copy), attendees' answers on their own copy, and `freeBusy.query`. Answers write
 * `dateTime` with the offset of the calendar's zone, as Google does by default, and keep `timeZone` apart.
 */
import {
  domainOf,
  eventId,
  fail,
  flag,
  iso,
  jsonBody,
  notFound,
  pageOf,
  type SentMessage,
  type StubRequest,
  type StubUser,
} from './core.js'
import { partial } from './fields.js'
import { datesOf, instantOf, localOf, ruleOfRecurrence, withOffset } from './rrule.js'

type CRole = 'freeBusyReader' | 'reader' | 'writer' | 'owner'
const RANK: Record<CRole, number> = { freeBusyReader: 1, reader: 2, writer: 3, owner: 4 }

interface SCal {
  id: string
  summary: string
  description?: string
  timeZone: string
  acl: Map<string, CRole>
  /** the user whose primary calendar this is */
  primaryOf?: string
}

/** When an event takes place: a date, or an instant with the zone it was set in. */
interface STime {
  date?: string
  ms?: number
  timeZone?: string
}

interface SAtt {
  email: string
  displayName?: string
  optional?: boolean
  responseStatus: string
  comment?: string
  resource?: boolean
}

interface SException {
  start?: STime
  end?: STime
  summary?: string
  description?: string
  location?: string
  transparency?: string
  cancelled?: boolean
  responses: Map<string, { status: string; comment?: string }>
  n: number
}

interface SEvent {
  id: string
  calendarId: string
  iCalUID: string
  summary?: string
  description?: string
  location?: string
  start: STime
  end: STime
  transparency?: string
  status: 'confirmed' | 'tentative' | 'cancelled'
  recurrence?: string[]
  attendees: SAtt[]
  organizer: { email: string; displayName?: string }
  conference?: { id: string; uri: string }
  created: number
  updated: number
  n: number
  sequence: number
  exceptions: Map<string, SException>
  /** the attendees' calendars this event was removed from */
  hiddenFor: Set<string>
}

interface Occurrence {
  key: string
  start: STime
  end: STime
  original: STime
  exception?: SException
}

const DAY = 86_400_000
const pad = (n: number) => String(n).padStart(2, '0')
const compact = (ms: number) => {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
}
const addDays = (date: string, n: number) => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}
const knownZone = (z: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z })
    return true
  } catch {
    return false
  }
}

export class StubCalendar {
  public readonly calendars = new Map<string, SCal>()
  public readonly events = new Map<string, SEvent>()

  public constructor(
    private readonly users: StubUser[],
    private readonly send: (m: SentMessage) => void,
    private readonly zone = 'America/Bogota',
    private readonly now: () => number = () => Date.now()
  ) {
    for (const u of users)
      this.calendars.set(u.email, {
        id: u.email,
        summary: u.email,
        timeZone: zone,
        acl: new Map([[u.id, 'owner']]),
        primaryOf: u.id,
      })
  }

  // ---- by other means

  public primaryOf(user: StubUser): string {
    return user.email
  }

  public seedCalendar(owner: StubUser, summary: string, share: { userId: string; role: CRole }[] = []): string {
    const id = `${eventId().slice(0, 20)}@group.calendar.google.com`
    this.calendars.set(id, {
      id,
      summary,
      timeZone: this.zone,
      acl: new Map<string, CRole>([[owner.id, 'owner'], ...share.map((s) => [s.userId, s.role] as [string, CRole])]),
    })
    return id
  }

  /** An event put in a calendar by other means, with a Google Meet conference when asked. */
  public seedEvent(
    calendarId: string,
    fields: { summary: string; start: string; end: string; timeZone?: string; conference?: boolean }
  ): string {
    const cal = this.calendars.get(calendarId) as SCal
    const ev = this.newEvent(cal, {
      summary: fields.summary,
      start: { dateTime: fields.start, ...(fields.timeZone ? { timeZone: fields.timeZone } : {}) },
      end: { dateTime: fields.end, ...(fields.timeZone ? { timeZone: fields.timeZone } : {}) },
    })
    if (fields.conference) ev.conference = this.newConference()
    return ev.id
  }

  // ---- the model

  private role(u: StubUser, cal: SCal): number {
    const r = cal.acl.get(u.id)
    return r ? RANK[r] : 0
  }

  private calendarFor(r: StubRequest, id: string, need: number): SCal {
    const cal = this.calendars.get(id)
    const rank = cal ? this.role(r.caller.user, cal) : 0
    if (!cal || rank < Math.min(need, RANK.reader)) return notFound('Not Found')
    if (rank < need) return fail(403, 'requiredAccessLevel', 'You need to have writer access to this calendar.')
    return cal
  }

  private organizerOf(cal: SCal): { email: string; displayName?: string } {
    const u = cal.primaryOf ? this.users.find((x) => x.id === cal.primaryOf) : undefined
    return u ? { email: u.email, displayName: u.name } : { email: cal.id, displayName: cal.summary }
  }

  /** Whether an event shows in a calendar: the organizer's, or an invited account's primary calendar. */
  private shows(ev: SEvent, cal: SCal): boolean {
    if (ev.calendarId === cal.id) return true
    if (!cal.primaryOf || ev.hiddenFor.has(cal.id)) return false
    return ev.attendees.some((a) => a.email.toLowerCase() === cal.id.toLowerCase())
  }

  private time(t: Record<string, unknown> | undefined, field: string): STime {
    if (!t) return fail(400, 'required', `Missing ${field} time.`)
    if (typeof t.date === 'string' && t.date) return { date: t.date }
    if (typeof t.dateTime !== 'string' || !t.dateTime) return fail(400, 'required', `Missing ${field} time.`)
    const zone = typeof t.timeZone === 'string' && t.timeZone ? t.timeZone : undefined
    if (zone && !knownZone(zone)) return fail(400, 'invalid', `Invalid time zone definition for ${field} time.`)
    const ms = Date.parse(t.dateTime)
    if (Number.isNaN(ms)) return fail(400, 'invalid', `Invalid ${field} time.`)
    if (!/(Z|[+-]\d\d:\d\d)$/.test(t.dateTime) && !zone)
      return fail(400, 'invalid', `Missing time zone definition for ${field} time.`)
    return { ms, ...(zone ? { timeZone: zone } : {}) }
  }

  private checkTimes(start: STime, end: STime, recurring: boolean): void {
    if ((start.date === undefined) !== (end.date === undefined))
      fail(400, 'invalid', 'The start and the end are of one kind.')
    const empty =
      start.date !== undefined ? (end.date as string) <= start.date : (end.ms as number) <= (start.ms as number)
    if (empty) fail(400, 'timeRangeEmpty', 'The specified time range is empty.')
    if (recurring && start.date === undefined && !start.timeZone)
      fail(400, 'invalid', 'Missing time zone definition for start time.')
  }

  private newConference() {
    const code = () => eventId().slice(0, 4).replace(/[0-9]/g, 'k')
    const id = `${code().slice(0, 3)}-${code()}-${code().slice(0, 3)}`
    return { id, uri: `https://meet.google.com/${id}` }
  }

  private newEvent(cal: SCal, body: Record<string, unknown>): SEvent {
    const start = this.time(body.start as Record<string, unknown>, 'start')
    const end = this.time(body.end as Record<string, unknown>, 'end')
    const recurrence = Array.isArray(body.recurrence) ? (body.recurrence as string[]) : undefined
    this.checkTimes(start, end, !!recurrence)
    const id = eventId()
    const now = this.now()
    const ev: SEvent = {
      id,
      calendarId: cal.id,
      iCalUID: `${id}@google.com`,
      ...(typeof body.summary === 'string' ? { summary: body.summary } : {}),
      ...(typeof body.description === 'string' && body.description ? { description: body.description } : {}),
      ...(typeof body.location === 'string' && body.location ? { location: body.location } : {}),
      start,
      end,
      ...(body.transparency === 'transparent' ? { transparency: 'transparent' } : {}),
      status: body.status === 'tentative' ? 'tentative' : 'confirmed',
      ...(recurrence ? { recurrence } : {}),
      attendees: this.attendeesOf(body.attendees, []),
      organizer: this.organizerOf(cal),
      created: now,
      updated: now,
      n: 1,
      sequence: 0,
      exceptions: new Map(),
      hiddenFor: new Set(),
    }
    this.events.set(id, ev)
    return ev
  }

  private attendeesOf(list: unknown, before: SAtt[]): SAtt[] {
    if (!Array.isArray(list)) return before
    return (list as Record<string, unknown>[]).map((a) => {
      if (typeof a.email !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(a.email))
        fail(400, 'invalid', 'Invalid attendee email.')
      return {
        email: a.email as string,
        ...(typeof a.displayName === 'string' ? { displayName: a.displayName } : {}),
        ...(a.optional === true ? { optional: true } : {}),
        responseStatus: typeof a.responseStatus === 'string' ? a.responseStatus : 'needsAction',
        ...(typeof a.comment === 'string' ? { comment: a.comment } : {}),
        ...(a.resource === true ? { resource: true } : {}),
      }
    })
  }

  /** The occurrences of an event that start before `toMs` (one for an event that does not repeat). */
  private occurrences(ev: SEvent, toMs: number): Occurrence[] {
    const rule = ruleOfRecurrence(ev.recurrence)
    if (!rule) return [{ key: '', start: ev.start, end: ev.end, original: ev.start }]
    const out: Occurrence[] = []
    const lastDay = Math.floor(toMs / DAY) + 2
    if (ev.start.date !== undefined) {
      const [y, m, d] = ev.start.date.split('-').map(Number) as [number, number, number]
      const days = Math.round((Date.parse(`${ev.end.date}T00:00:00Z`) - Date.parse(`${ev.start.date}T00:00:00Z`)) / DAY)
      for (const x of datesOf({ y, m, d }, rule, lastDay)) {
        const date = `${x.y}-${pad(x.m)}-${pad(x.d)}`
        const key = date.replace(/-/g, '')
        out.push(
          this.withException(ev, { key, start: { date }, end: { date: addDays(date, days) }, original: { date } })
        )
      }
    } else {
      const zone = ev.start.timeZone as string
      const first = localOf(ev.start.ms as number, zone)
      const length = (ev.end.ms as number) - (ev.start.ms as number)
      const until =
        rule.until && rule.until.length > 8
          ? Date.parse(
              `${rule.until.slice(0, 4)}-${rule.until.slice(4, 6)}-${rule.until.slice(6, 8)}T${rule.until.slice(9, 11)}:${rule.until.slice(11, 13)}:${rule.until.slice(13, 15)}Z`
            )
          : Infinity
      for (const x of datesOf({ y: first.y, m: first.m, d: first.d }, rule, lastDay)) {
        const ms = instantOf({ ...first, y: x.y, m: x.m, d: x.d }, zone)
        if (ms > until) break
        const start = { ms, timeZone: zone }
        out.push(
          this.withException(ev, { key: compact(ms), start, end: { ms: ms + length, timeZone: zone }, original: start })
        )
      }
    }
    return out
  }

  private withException(ev: SEvent, o: Occurrence): Occurrence {
    const exception = ev.exceptions.get(o.key)
    if (!exception) return o
    return { ...o, start: exception.start ?? o.start, end: exception.end ?? o.end, exception }
  }

  private msOf(t: STime, cal: SCal): number {
    if (t.ms !== undefined) return t.ms
    const [y, m, d] = (t.date as string).split('-').map(Number) as [number, number, number]
    return instantOf({ y, m, d, h: 0, mi: 0, s: 0 }, cal.timeZone)
  }

  /** An instance of a series, or a single event, by its id in a calendar. */
  private find(cal: SCal, id: string): { ev: SEvent; occ?: Occurrence } {
    const direct = this.events.get(id)
    if (direct) {
      if (!this.shows(direct, cal)) return notFound('Not Found')
      return { ev: direct }
    }
    const at = id.lastIndexOf('_')
    const ev = at > 0 ? this.events.get(id.slice(0, at)) : undefined
    if (!ev?.recurrence || !this.shows(ev, cal)) return notFound('Not Found')
    const key = id.slice(at + 1)
    const keyMs = /^\d{8}$/.test(key)
      ? Date.UTC(+key.slice(0, 4), +key.slice(4, 6) - 1, +key.slice(6, 8))
      : Date.parse(
          `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}T${key.slice(9, 11)}:${key.slice(11, 13)}:${key.slice(13, 15)}Z`
        )
    const occ = this.occurrences(ev, keyMs + 3 * DAY).find((o) => o.key === key)
    if (!occ) return notFound('Not Found')
    return { ev, occ }
  }

  private timeView(t: STime, cal: SCal, zone?: string): Record<string, unknown> {
    if (t.date !== undefined) return { date: t.date }
    return { dateTime: withOffset(t.ms as number, cal.timeZone), ...(zone ? { timeZone: zone } : {}) }
  }

  private etagOf(ev: SEvent, occ?: Occurrence): string {
    return `"${ev.n}${occ?.exception ? `.${occ.exception.n}` : ''}0000"`
  }

  /** An event as Google answers it in a calendar: the series, a single event, or an instance. */
  private view(ev: SEvent, cal: SCal, occ?: Occurrence): Record<string, unknown> {
    const x = occ?.exception
    const zone = ev.start.timeZone
    const cancelled = ev.status === 'cancelled' || x?.cancelled === true
    const own = (email: string) => email.toLowerCase() === cal.id.toLowerCase()
    const description = x?.description ?? ev.description
    const location = x?.location ?? ev.location
    const transparency = x?.transparency ?? ev.transparency
    const attendees = ev.attendees.map((a) => {
      const answer = x?.responses.get(a.email.toLowerCase())
      return {
        email: a.email,
        ...(a.displayName ? { displayName: a.displayName } : {}),
        ...(a.email.toLowerCase() === ev.organizer.email.toLowerCase() ? { organizer: true } : {}),
        ...(own(a.email) ? { self: true } : {}),
        ...(a.resource ? { resource: true } : {}),
        ...(a.optional ? { optional: true } : {}),
        responseStatus: answer?.status ?? a.responseStatus,
        ...((answer?.comment ?? a.comment) ? { comment: answer?.comment ?? a.comment } : {}),
      }
    })
    return {
      kind: 'calendar#event',
      etag: this.etagOf(ev, occ),
      id: occ ? `${ev.id}_${occ.key}` : ev.id,
      status: cancelled ? 'cancelled' : ev.status,
      htmlLink: `https://www.google.com/calendar/event?eid=${Buffer.from(`${ev.id} ${cal.id}`).toString('base64url')}`,
      created: iso(ev.created),
      updated: iso(ev.updated),
      ...((x?.summary ?? ev.summary) !== undefined ? { summary: x?.summary ?? ev.summary } : {}),
      ...(description ? { description } : {}),
      ...(location ? { location } : {}),
      creator: { email: ev.organizer.email },
      organizer: { ...ev.organizer, ...(ev.calendarId === cal.id ? { self: true } : {}) },
      start: this.timeView(occ?.start ?? ev.start, cal, zone),
      end: this.timeView(occ?.end ?? ev.end, cal, zone),
      ...(occ
        ? { recurringEventId: ev.id, originalStartTime: this.timeView(occ.original, cal, zone) }
        : ev.recurrence
          ? { recurrence: ev.recurrence }
          : {}),
      ...(transparency === 'transparent' ? { transparency } : {}),
      iCalUID: ev.iCalUID,
      sequence: ev.sequence,
      ...(attendees.length ? { attendees } : {}),
      ...(ev.conference
        ? {
            hangoutLink: ev.conference.uri,
            conferenceData: {
              createRequest: { status: { statusCode: 'success' } },
              entryPoints: [{ entryPointType: 'video', uri: ev.conference.uri, label: ev.conference.uri.slice(8) }],
              conferenceSolution: { key: { type: 'hangoutsMeet' }, name: 'Google Meet' },
              conferenceId: ev.conference.id,
            },
          }
        : {}),
      eventType: 'default',
    }
  }

  private tell(ev: SEvent, kind: SentMessage['kind'], text = '', only?: string[]): void {
    for (const a of ev.attendees) {
      if (a.resource || a.email.toLowerCase() === ev.organizer.email.toLowerCase()) continue
      if (only && !only.includes(a.email.toLowerCase())) continue
      const word = kind === 'invitation' ? 'Invitation' : kind === 'update' ? 'Updated invitation' : 'Canceled event'
      this.send({ to: a.email, kind, subject: `${word}: ${ev.summary ?? ''}`, text })
    }
  }

  // ---- the methods

  public handle(r: StubRequest): Response {
    const [a, b, c, d] = r.parts
    const m = r.method
    if (a === 'users' && b === 'me' && c === 'calendarList' && d === undefined && m === 'GET')
      return this.calendarList(r)
    if (a === 'freeBusy' && m === 'POST') return this.freeBusy(r)
    if (a === 'calendars' && b !== undefined && c === 'events') {
      if (d === undefined && m === 'GET') return this.list(r, b)
      if (d === undefined && m === 'POST') return this.insert(r, b)
      if (d !== undefined && m === 'GET') return this.get(r, b, d)
      if (d !== undefined && m === 'PATCH') return this.patch(r, b, d)
      if (d !== undefined && m === 'DELETE') return this.delete(r, b, d)
    }
    return notFound('Not Found')
  }

  private answer(r: StubRequest, value: unknown, status = 200): Response {
    return Response.json(partial(value, r.url.searchParams.get('fields')), { status })
  }

  private calendarList(r: StubRequest): Response {
    const u = r.caller.user
    const min = (r.url.searchParams.get('minAccessRole') ?? 'freeBusyReader') as CRole
    const entries = [...this.calendars.values()]
      .filter((c) => this.role(u, c) >= RANK[min])
      .map((c) => ({
        kind: 'calendar#calendarListEntry',
        etag: '"1"',
        id: c.id,
        summary: c.summary,
        ...(c.description ? { description: c.description } : {}),
        timeZone: c.timeZone,
        accessRole: c.acl.get(u.id),
        ...(c.primaryOf === u.id ? { primary: true } : {}),
        selected: true,
      }))
    const page = pageOf(entries, r.url, JSON.stringify(['cl', u.id, min]), { size: 100, max: 250 }, 'maxResults')
    return this.answer(r, {
      kind: 'calendar#calendarList',
      ...(page.next ? { nextPageToken: page.next } : {}),
      items: page.items,
    })
  }

  private list(r: StubRequest, calendarId: string): Response {
    const cal = this.calendarFor(r, calendarId, RANK.reader)
    const p = r.url.searchParams
    const single = flag(r.url, 'singleEvents', false)
    if (p.get('orderBy') === 'startTime' && !single)
      return fail(400, 'badRequest', 'The requested ordering is not available for the particular query.')
    if (!single) return fail(400, 'badRequest', 'The stub lists instances only (singleEvents=true).')
    const fromMs = p.get('timeMin') ? Date.parse(p.get('timeMin') as string) : -Infinity
    const toMs = p.get('timeMax') ? Date.parse(p.get('timeMax') as string) : Date.parse('2100-01-01T00:00:00Z')
    if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return fail(400, 'badRequest', 'Bad Request')
    const showDeleted = flag(r.url, 'showDeleted', false)
    const found: { ms: number; id: string; value: Record<string, unknown> }[] = []
    for (const ev of this.events.values()) {
      if (!this.shows(ev, cal)) continue
      if (ev.status === 'cancelled' && !showDeleted) continue
      for (const o of this.occurrences(ev, toMs)) {
        if (o.exception?.cancelled && !showDeleted) continue
        const s = this.msOf(o.start, cal)
        const e = this.msOf(o.end, cal)
        if (!(e > fromMs && s < toMs)) continue
        const value = this.view(ev, cal, o.key ? o : undefined)
        found.push({ ms: s, id: String(value.id), value })
      }
    }
    found.sort((x, y) => x.ms - y.ms || (x.id < y.id ? -1 : 1))
    const binding = JSON.stringify([r.caller.user.id, calendarId, p.get('timeMin'), p.get('timeMax'), showDeleted])
    const page = pageOf(found, r.url, binding, { size: 250, max: 2500 }, 'maxResults')
    return this.answer(r, {
      kind: 'calendar#events',
      summary: cal.summary,
      updated: iso(this.now()),
      timeZone: cal.timeZone,
      accessRole: cal.acl.get(r.caller.user.id),
      defaultReminders: [],
      ...(page.next ? { nextPageToken: page.next } : {}),
      items: page.items.map((x) => x.value),
    })
  }

  private get(r: StubRequest, calendarId: string, id: string): Response {
    const cal = this.calendarFor(r, calendarId, RANK.reader)
    const { ev, occ } = this.find(cal, id)
    return this.answer(r, this.view(ev, cal, occ))
  }

  private insert(r: StubRequest, calendarId: string): Response {
    const cal = this.calendarFor(r, calendarId, RANK.writer)
    const body = jsonBody(r)
    const ev = this.newEvent(cal, body)
    const conference = body.conferenceData as { createRequest?: unknown } | undefined
    if (conference?.createRequest && r.url.searchParams.get('conferenceDataVersion') === '1')
      ev.conference = this.newConference()
    if (r.url.searchParams.get('sendUpdates') === 'all') this.tell(ev, 'invitation', ev.description ?? '')
    return this.answer(r, this.view(ev, cal))
  }

  private ifMatch(r: StubRequest, current: string): void {
    const want = r.headers.get('if-match')
    if (want !== null && want !== current) fail(412, 'conditionNotMet', 'Precondition Failed')
  }

  private patch(r: StubRequest, calendarId: string, id: string): Response {
    const cal = this.calendarFor(r, calendarId, RANK.reader)
    const { ev, occ } = this.find(cal, id)
    if (ev.status === 'cancelled' || occ?.exception?.cancelled) return fail(410, 'deleted', 'Resource has been deleted')
    this.ifMatch(r, this.etagOf(ev, occ))
    const body = jsonBody(r)
    const notify = r.url.searchParams.get('sendUpdates') === 'all'
    if (ev.calendarId !== cal.id) return this.answerAsAttendee(r, cal, ev, occ, body, notify)
    if (this.role(r.caller.user, cal) < RANK.writer)
      return fail(403, 'requiredAccessLevel', 'You need to have writer access to this calendar.')
    const merge = (before: STime, patch: unknown, field: string): STime => {
      if (patch === undefined) return before
      const view =
        before.date !== undefined
          ? { date: before.date }
          : { dateTime: iso(before.ms as number), timeZone: before.timeZone }
      const merged: Record<string, unknown> = { ...view }
      for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
        if (v === null) delete merged[k]
        else merged[k] = v
      }
      return this.time(merged, field)
    }
    const text = (v: unknown) => (v === null ? undefined : typeof v === 'string' && v !== '' ? v : undefined)
    if (occ) {
      if (body.recurrence !== undefined) return fail(400, 'invalid', 'The recurrence of an instance is not changed.')
      const x: SException = occ.exception ?? { responses: new Map(), n: 0 }
      const start = merge(occ.start, body.start, 'start')
      const end = merge(occ.end, body.end, 'end')
      this.checkTimes(start, end, false)
      if (body.start !== undefined) x.start = start
      if (body.end !== undefined) x.end = end
      if ('summary' in body) x.summary = text(body.summary) ?? ''
      if ('description' in body) x.description = text(body.description) ?? ''
      if ('location' in body) x.location = text(body.location) ?? ''
      if ('transparency' in body) x.transparency = String(body.transparency)
      x.n++
      ev.exceptions.set(occ.key, x)
      ev.updated = this.now()
      if (notify) this.tell(ev, 'update', '')
      return this.answer(r, this.view(ev, cal, this.find(cal, id).occ))
    }
    const start = merge(ev.start, body.start, 'start')
    const end = merge(ev.end, body.end, 'end')
    const recurrence =
      body.recurrence === null
        ? undefined
        : Array.isArray(body.recurrence)
          ? (body.recurrence as string[])
          : ev.recurrence
    this.checkTimes(start, end, !!recurrence)
    const before = { start: ev.start, location: ev.location, recurrence: ev.recurrence }
    ev.start = start
    ev.end = end
    ev.recurrence = recurrence
    if ('summary' in body) ev.summary = text(body.summary) ?? ''
    if ('description' in body) ev.description = text(body.description)
    if ('location' in body) ev.location = text(body.location)
    if ('transparency' in body) ev.transparency = body.transparency === 'transparent' ? 'transparent' : undefined
    const invitedBefore = new Set(ev.attendees.map((a) => a.email.toLowerCase()))
    if (body.attendees !== undefined) ev.attendees = this.attendeesOf(body.attendees, ev.attendees)
    if (body.conferenceData === null) ev.conference = undefined
    else if (
      (body.conferenceData as { createRequest?: unknown } | undefined)?.createRequest &&
      r.url.searchParams.get('conferenceDataVersion') === '1' &&
      !ev.conference
    )
      ev.conference = this.newConference()
    if (
      JSON.stringify(before) !== JSON.stringify({ start: ev.start, location: ev.location, recurrence: ev.recurrence })
    )
      ev.sequence++
    // instances whose original start no longer exists lose their changes
    const keys = new Set(this.occurrences(ev, Date.parse('2100-01-01T00:00:00Z')).map((o) => o.key))
    for (const k of [...ev.exceptions.keys()]) if (!keys.has(k)) ev.exceptions.delete(k)
    ev.n++
    ev.updated = this.now()
    if (notify) {
      const added = ev.attendees
        .filter((a) => !invitedBefore.has(a.email.toLowerCase()))
        .map((a) => a.email.toLowerCase())
      this.tell(ev, 'invitation', ev.description ?? '', added)
      this.tell(
        ev,
        'update',
        '',
        ev.attendees.map((a) => a.email.toLowerCase()).filter((e) => !added.includes(e))
      )
    }
    return this.answer(r, this.view(ev, cal))
  }

  /** An attendee's change of their own copy: their answer and its comment, nothing shared (Google's `forbiddenForNonOrganizer`). */
  private answerAsAttendee(
    r: StubRequest,
    cal: SCal,
    ev: SEvent,
    occ: Occurrence | undefined,
    body: Record<string, unknown>,
    notify: boolean
  ): Response {
    const refuse = () =>
      fail(403, 'forbiddenForNonOrganizer', 'Shared properties can only be changed by the organizer of the event.')
    if (Object.keys(body).some((k) => k !== 'attendees') || !Array.isArray(body.attendees)) return refuse()
    const given = body.attendees as { email?: string; responseStatus?: string; comment?: string }[]
    const mine = cal.id.toLowerCase()
    const current = ev.attendees.map((a) => a.email.toLowerCase()).sort()
    if (JSON.stringify(given.map((a) => String(a.email).toLowerCase()).sort()) !== JSON.stringify(current))
      return refuse()
    let answer: { status: string; comment?: string } | undefined
    for (const a of given) {
      const email = String(a.email).toLowerCase()
      const was = ev.attendees.find((x) => x.email.toLowerCase() === email) as SAtt
      const wasStatus = occ?.exception?.responses.get(email)?.status ?? was.responseStatus
      if (email === mine) answer = { status: String(a.responseStatus), ...(a.comment ? { comment: a.comment } : {}) }
      else if (a.responseStatus !== undefined && a.responseStatus !== wasStatus) return refuse()
    }
    if (!answer) return refuse()
    if (occ) {
      const x: SException = occ.exception ?? { responses: new Map(), n: 0 }
      x.responses.set(mine, answer)
      x.n++
      ev.exceptions.set(occ.key, x)
    } else {
      const line = ev.attendees.find((x) => x.email.toLowerCase() === mine) as SAtt
      line.responseStatus = answer.status
      if (answer.comment) line.comment = answer.comment
      for (const x of ev.exceptions.values()) x.responses.delete(mine)
      ev.n++
    }
    ev.updated = this.now()
    if (notify)
      this.send({
        to: ev.organizer.email,
        kind: 'reply',
        subject: `${answer.status}: ${ev.summary ?? ''}`,
        text: answer.comment ?? '',
      })
    return this.answer(r, this.view(ev, cal, occ ? this.find(cal, `${ev.id}_${occ.key}`).occ : undefined))
  }

  private delete(r: StubRequest, calendarId: string, id: string): Response {
    const cal = this.calendarFor(r, calendarId, RANK.reader)
    const { ev, occ } = this.find(cal, id)
    if (ev.status === 'cancelled' || occ?.exception?.cancelled) return fail(410, 'deleted', 'Resource has been deleted')
    this.ifMatch(r, this.etagOf(ev, occ))
    const notify = r.url.searchParams.get('sendUpdates') === 'all'
    if (ev.calendarId !== cal.id) {
      // an attendee removes the event from their own calendar
      ev.hiddenFor.add(cal.id)
      return new Response(null, { status: 204 })
    }
    if (this.role(r.caller.user, cal) < RANK.writer)
      return fail(403, 'requiredAccessLevel', 'You need to have writer access to this calendar.')
    if (occ) {
      const x: SException = occ.exception ?? { responses: new Map(), n: 0 }
      x.cancelled = true
      x.n++
      ev.exceptions.set(occ.key, x)
    } else ev.status = 'cancelled'
    ev.n++
    ev.updated = this.now()
    if (notify) this.tell(ev, 'cancellation', '')
    return new Response(null, { status: 204 })
  }

  private freeBusy(r: StubRequest): Response {
    const u = r.caller.user
    const body = jsonBody<{ timeMin?: string; timeMax?: string; items?: { id?: string }[] }>(r)
    const fromMs = Date.parse(body.timeMin ?? '')
    const toMs = Date.parse(body.timeMax ?? '')
    if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return fail(400, 'badRequest', 'Bad Request')
    const calendars: Record<string, unknown> = {}
    for (const item of body.items ?? []) {
      const id = String(item.id ?? '')
      const cal =
        this.calendars.get(id) ?? [...this.calendars.values()].find((c) => c.id.toLowerCase() === id.toLowerCase())
      // a calendar the account may read, or the primary calendar of a person of the same organization
      const owner = cal?.primaryOf ? this.users.find((x) => x.id === cal.primaryOf) : undefined
      const visible =
        cal && (this.role(u, cal) >= RANK.freeBusyReader || (owner && domainOf(owner.email) === domainOf(u.email)))
      if (!cal || !visible) {
        calendars[id] = { errors: [{ domain: 'global', reason: 'notFound' }], busy: [] }
        continue
      }
      const busy: { start: string; end: string }[] = []
      for (const ev of this.events.values()) {
        if (!this.shows(ev, cal) || ev.status === 'cancelled') continue
        for (const o of this.occurrences(ev, toMs)) {
          if (o.exception?.cancelled) continue
          if ((o.exception?.transparency ?? ev.transparency) === 'transparent') continue
          const line = ev.attendees.find((a) => a.email.toLowerCase() === cal.id.toLowerCase())
          if (ev.calendarId !== cal.id && line?.responseStatus === 'declined') continue
          const s = this.msOf(o.start, cal)
          const e = this.msOf(o.end, cal)
          if (e > fromMs && s < toMs) busy.push({ start: iso(Math.max(s, fromMs)), end: iso(Math.min(e, toMs)) })
        }
      }
      busy.sort((x, y) => Date.parse(x.start) - Date.parse(y.start))
      calendars[id] = { busy }
    }
    return Response.json({ kind: 'calendar#freeBusy', timeMin: body.timeMin, timeMax: body.timeMax, calendars })
  }
}
