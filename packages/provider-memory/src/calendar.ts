/**
 * A calendar server in memory, and its provider of Calendar 1.0 with every capability (calendar §1 to §4). An
 * invitation is delivered to each invited account's main calendar as an event of its own that reads its organizer's;
 * the messages a calendar sends (invitations, changes, cancellations, replies) go to the service's outbox.
 */
import {
  type Attendee,
  type AttendeeResponse,
  type BusyTime,
  type Calendar,
  type CalendarCapability,
  type CalendarDeclaration,
  type CalendarEvent,
  type EventStatus,
  formatRule,
  type InviteeInput,
  isFullDate,
  parseRule,
  type Rule,
} from '@ayni.org/ayni-feature-profiles'
import { type CalendarProvider, type CallContext, errors, pageByOffset } from '@ayni.org/ayni-provider-kit'
import type { MemoryService, MemoryUser } from './store.js'
import {
  dayNumber,
  formatDate,
  formatInstant,
  fromDayNumber,
  type Local,
  occurrenceDates,
  parseDate,
  toInstant,
  toLocal,
  utc,
} from './time.js'

export interface MemoryCalendarOptions {
  /** the capabilities declared, every one when absent */
  capabilities?: CalendarCapability[]
  /** the time zone of each account's main calendar */
  timeZone?: string
  /** the name people know the service's meetings by */
  meetingLabel?: string
}

const ALL: CalendarCapability[] = ['free-busy', 'recurrence', 'attendees', 'respond', 'meeting']
const DAY = 86_400_000

/** When an event takes place: all day (dates), set in a zone, in UTC, or floating (read in the calendar's zone). */
type Times =
  | { kind: 'all-day'; start: string; days: number }
  | { kind: 'zoned'; local: Local; zone: string; ms: number }
  | { kind: 'utc'; startMs: number; ms: number }
  | { kind: 'floating'; local: Local; ms: number }

interface Override {
  times?: Times
  title?: string
  description?: string | null
  place?: string | null
  busy?: boolean
  responses?: Record<string, AttendeeResponse>
}

interface EventRec {
  id: string
  calendar: string
  /** a delivered invitation: the organizer's event it reads */
  source?: string
  uid: string
  title: string
  description?: string
  place?: string
  times: Times
  status: EventStatus
  busy: boolean
  organizer?: { userId?: string; address: string; name?: string }
  attendees: { address: string; name?: string; response: AttendeeResponse; optional?: boolean }[]
  rule?: Rule
  exdates: Set<string>
  overrides: Map<string, Override>
  meeting?: { url: string; label?: string }
  createdAt: number
  modifiedAt: number
  version: string
}

interface CalRec {
  id: string
  owner: string
  title: string
  description?: string
  timeZone: string
  primary: boolean
  readers: Set<string>
  writers: Set<string>
}

/** An occurrence of an event: its key (its original start), and when it takes place. */
interface Occ {
  key: string
  startMs: number
  endMs: number
  times: Times
  override?: Override
}

type Ctx = CallContext<MemoryUser, CalendarDeclaration>

const pad = (n: number) => String(n).padStart(2, '0')

function compactUtc(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
}

function untilMs(until: string): number {
  const m = /^(\d{4})(\d\d)(\d\d)(T(\d\d)(\d\d)(\d\d)Z)?$/.exec(until)
  if (!m) return Number.POSITIVE_INFINITY
  if (!m[4]) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59)
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[5]), Number(m[6]), Number(m[7]))
}

function parseLocal(text: string): Local {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d))?/.exec(text)
  if (!m) throw new Error(`not a local time: ${text}`)
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]), h: Number(m[4]), mi: Number(m[5]), s: Number(m[6] ?? 0) }
}

export class MemoryCalendars {
  public readonly options: Required<MemoryCalendarOptions>
  private readonly calendars = new Map<string, CalRec>()
  private readonly events = new Map<string, EventRec>()

  public constructor(
    private readonly service: MemoryService,
    options: MemoryCalendarOptions = {}
  ) {
    this.options = {
      capabilities: options.capabilities ?? ALL,
      timeZone: options.timeZone ?? 'Europe/Paris',
      meetingLabel: options.meetingLabel ?? 'Memory Meet',
    }
    for (const u of service.users) {
      const id = `cal-${u.id}`
      this.calendars.set(id, {
        id,
        owner: u.id,
        title: `Calendar of ${u.name}`,
        timeZone: this.options.timeZone,
        primary: true,
        readers: new Set(),
        writers: new Set(),
      })
    }
  }

  public declaration(): Omit<CalendarDeclaration, 'version'> {
    const caps = this.options.capabilities
    return {
      capabilities: caps,
      atomicWrites: true,
      ...(caps.includes('meeting') ? { meeting: { label: this.options.meetingLabel } } : {}),
    }
  }

  // ---- by other means (common §13)

  public primaryOf(userId: string): string {
    return `cal-${userId}`
  }

  public seedCalendar(
    owner: string,
    title: string,
    opts: { timeZone?: string; readers?: string[]; writers?: string[] } = {}
  ): string {
    const id = this.service.next('cal')
    this.calendars.set(id, {
      id,
      owner,
      title,
      timeZone: opts.timeZone ?? this.options.timeZone,
      primary: false,
      readers: new Set(opts.readers ?? []),
      writers: new Set(opts.writers ?? []),
    })
    return id
  }

  /**
   * An event put in a calendar by other means: a floating time (`start` with no offset and `floating`), a repetition
   * the provider does not declare, a meeting link of an iCalendar `CONFERENCE`.
   */
  public seedEvent(
    calendarId: string,
    fields: {
      title: string
      start: string
      end: string
      allDay?: boolean
      timeZone?: string
      floating?: boolean
      rule?: string
      organizer?: string
      /** the addresses invited */
      attendees?: string[]
      meeting?: { url: string; label?: string }
    }
  ): string {
    const cal = this.calendars.get(calendarId)
    if (!cal) throw new Error(`no calendar ${calendarId}`)
    let times: Times
    if (fields.floating) {
      const local = parseLocal(fields.start)
      const endLocal = parseLocal(fields.end)
      times = {
        kind: 'floating',
        local,
        ms:
          Date.UTC(endLocal.y, endLocal.m - 1, endLocal.d, endLocal.h, endLocal.mi, endLocal.s) -
          Date.UTC(local.y, local.m - 1, local.d, local.h, local.mi, local.s),
      }
    } else {
      times = this.timesOf(fields.start, fields.end, fields.allDay ?? false, fields.timeZone)
    }
    const organizer = fields.organizer ? this.service.userById(fields.organizer) : undefined
    const rule = fields.rule ? parseRule(fields.rule) : undefined
    const id = this.service.next('e')
    const now = this.service.now()
    this.events.set(id, {
      id,
      calendar: calendarId,
      uid: `${id}@calendar.memory.invalid`,
      title: fields.title,
      times,
      status: 'confirmed',
      busy: true,
      ...(organizer ? { organizer: { userId: organizer.id, address: organizer.email, name: organizer.name } } : {}),
      attendees: (fields.attendees ?? []).map((address) => ({ address, response: 'needs-action' as const })),
      ...(rule && 'rule' in rule ? { rule: rule.rule } : {}),
      exdates: new Set(),
      overrides: new Map(),
      ...(fields.meeting ? { meeting: fields.meeting } : {}),
      createdAt: now,
      modifiedAt: now,
      version: this.service.next('v'),
    })
    return id
  }

  // ---- the model

  private timesOf(start: string, end: string, allDay: boolean, zone: string | undefined): Times {
    if (allDay) {
      const s = parseDate(start)
      const e = parseDate(end)
      return { kind: 'all-day', start, days: dayNumber(e.y, e.m, e.d) - dayNumber(s.y, s.m, s.d) }
    }
    const startMs = Date.parse(start)
    const ms = Date.parse(end) - startMs
    if (zone) return { kind: 'zoned', local: toLocal(startMs, zone), zone, ms }
    return { kind: 'utc', startMs, ms }
  }

  private sourceOf(ev: EventRec): EventRec {
    return ev.source ? (this.events.get(ev.source) ?? ev) : ev
  }

  private calTz(ev: EventRec): string {
    return this.calendars.get(ev.calendar)?.timeZone ?? this.options.timeZone
  }

  /** The instants of a start of `times` on another date, keeping its wall clock. */
  private startOn(
    times: Times,
    date: { y: number; m: number; d: number } | undefined,
    calTz: string
  ): { startMs: number; endMs: number } {
    switch (times.kind) {
      case 'all-day': {
        const s = date ?? parseDate(times.start)
        const startMs = toInstant({ ...s, h: 0, mi: 0, s: 0 }, calTz)
        const e = fromDayNumber(dayNumber(s.y, s.m, s.d) + times.days)
        return { startMs, endMs: toInstant({ ...e, h: 0, mi: 0, s: 0 }, calTz) }
      }
      case 'zoned':
      case 'floating': {
        const zone = times.kind === 'zoned' ? times.zone : calTz
        const local = { ...times.local, ...(date ?? {}) }
        const startMs = toInstant(local, zone)
        return { startMs, endMs: startMs + times.ms }
      }
      case 'utc': {
        if (!date) return { startMs: times.startMs, endMs: times.startMs + times.ms }
        const l = toLocal(times.startMs, 'UTC')
        const startMs = Date.UTC(date.y, date.m - 1, date.d, l.h, l.mi, l.s)
        return { startMs, endMs: startMs + times.ms }
      }
    }
  }

  private firstDate(times: Times, calTz: string): { y: number; m: number; d: number } {
    switch (times.kind) {
      case 'all-day':
        return parseDate(times.start)
      case 'zoned':
      case 'floating':
        return { y: times.local.y, m: times.local.m, d: times.local.d }
      case 'utc': {
        const l = toLocal(times.startMs, 'UTC')
        void calTz
        return { y: l.y, m: l.m, d: l.d }
      }
    }
  }

  private keyOf(times: Times, startMs: number, date: { y: number; m: number; d: number }): string {
    return times.kind === 'all-day' ? `${date.y}${pad(date.m)}${pad(date.d)}` : compactUtc(startMs)
  }

  /** The occurrences of an event up to an instant, each with its override; one for an event that does not repeat. */
  private occurrences(ev: EventRec, toMs: number): Occ[] {
    const src = this.sourceOf(ev)
    const tz = this.calTz(ev)
    if (!src.rule) {
      const { startMs, endMs } = this.startOn(src.times, undefined, tz)
      return [{ key: '', startMs, endMs, times: src.times }]
    }
    const first = this.firstDate(src.times, tz)
    const lastDay = Math.floor(toMs / DAY) + 2
    const until = src.rule.until ? untilMs(src.rule.until) : Number.POSITIVE_INFINITY
    const dates = occurrenceDates(
      first,
      src.rule,
      lastDay,
      (date) => this.startOn(src.times, date, tz).startMs <= until
    )
    const out: Occ[] = []
    for (const date of dates) {
      const { startMs, endMs } = this.startOn(src.times, date, tz)
      const key = this.keyOf(src.times, startMs, date)
      if (src.exdates.has(key)) continue
      const override = src.overrides.get(key)
      if (override?.times) {
        const moved = this.startOn(override.times, undefined, tz)
        out.push({ key, startMs: moved.startMs, endMs: moved.endMs, times: override.times, override })
      } else out.push({ key, startMs, endMs, times: src.times, ...(override ? { override } : {}) })
    }
    return out
  }

  private formatTimes(
    times: Times,
    startMs: number,
    endMs: number,
    tz: string
  ): { start: string; end: string; timeZone?: string } {
    switch (times.kind) {
      case 'all-day': {
        const s = toLocal(startMs, tz)
        const e = toLocal(endMs, tz)
        return { start: formatDate(s.y, s.m, s.d), end: formatDate(e.y, e.m, e.d) }
      }
      case 'zoned':
        return {
          start: formatInstant(startMs, times.zone),
          end: formatInstant(endMs, times.zone),
          timeZone: times.zone,
        }
      case 'floating':
        return { start: formatInstant(startMs, tz), end: formatInstant(endMs, tz) }
      case 'utc':
        return { start: formatInstant(startMs), end: formatInstant(endMs) }
    }
  }

  private render(user: MemoryUser, ev: EventRec, occ: Occ | undefined, asSeries = false): CalendarEvent {
    const src = this.sourceOf(ev)
    const tz = this.calTz(ev)
    const o = occ?.override
    const { startMs, endMs } = occ ?? this.startOn(src.times, undefined, tz)
    const times = this.formatTimes(occ?.times ?? src.times, startMs, endMs, tz)
    const description = o && o.description !== undefined ? o.description : src.description
    const place = o && o.place !== undefined ? o.place : src.place
    const email = user.email.toLowerCase()
    const attendees: Attendee[] = src.attendees.map((a) => {
      const response = o?.responses?.[a.address.toLowerCase()] ?? a.response
      return {
        address: a.address,
        ...(a.name ? { name: a.name } : {}),
        response,
        ...(a.optional ? { optional: true as const } : {}),
        ...(a.address.toLowerCase() === email ? { self: true as const } : {}),
      }
    })
    const recurring = !!src.rule
    const isOccurrence = recurring && !asSeries && occ !== undefined && occ.key !== ''
    return {
      ref: isOccurrence ? `${ev.id}#${occ?.key}` : ev.id,
      calendar: ev.calendar,
      uid: src.uid,
      title: o?.title ?? src.title,
      ...(description ? { description } : {}),
      ...(place ? { place } : {}),
      allDay: (occ?.times ?? src.times).kind === 'all-day',
      ...times,
      status: src.status,
      busy: o?.busy ?? src.busy,
      ...(src.organizer
        ? { organizer: { address: src.organizer.address, ...(src.organizer.name ? { name: src.organizer.name } : {}) } }
        : {}),
      mine: !src.organizer || src.organizer.userId === user.id,
      ...(attendees.length ? { attendees } : {}),
      recurring,
      ...(isOccurrence ? { series: ev.id } : {}),
      ...(recurring && !isOccurrence && src.rule ? { rule: formatRule(src.rule) } : {}),
      ...(src.meeting ? { meeting: src.meeting } : {}),
      webUrl: `https://calendar.memory.invalid/event/${ev.id}`,
      createdAt: utc(src.createdAt),
      modifiedAt: utc(src.modifiedAt),
      version: src.version,
    }
  }

  private calendarOf(user: MemoryUser, ref: string): CalRec {
    const cal = this.calendars.get(ref)
    if (!cal || !(cal.owner === user.id || cal.readers.has(user.id) || cal.writers.has(user.id)))
      throw errors.notFound('No such calendar for this account.')
    return cal
  }

  private writable(user: MemoryUser, cal: CalRec): boolean {
    return cal.owner === user.id || cal.writers.has(user.id)
  }

  /** The event of a reference in a calendar, and the occurrence it names, if any; `not-found` otherwise. */
  private eventIn(cal: CalRec, ref: string): { ev: EventRec; occ?: Occ } {
    const [id, key] = ref.split('#') as [string, string | undefined]
    const ev = this.events.get(id)
    if (!ev || ev.calendar !== cal.id) throw errors.notFound('No such event in this calendar.')
    if (key === undefined) return { ev }
    const src = this.sourceOf(ev)
    if (!src.rule) throw errors.notFound('No such event in this calendar.')
    const at = /^\d{8}$/.test(key)
      ? Date.UTC(Number(key.slice(0, 4)), Number(key.slice(4, 6)) - 1, Number(key.slice(6, 8)))
      : untilMs(key)
    const occ = this.occurrences(ev, at + 3 * DAY).find((o) => o.key === key)
    if (!occ) throw errors.notFound('No such occurrence of this event.')
    return { ev, occ }
  }

  private guard(ctx: Ctx, write: boolean): MemoryUser {
    if (!this.service.available) throw errors.unavailable()
    if (write && this.service.askBeforeWrite)
      ctx.ask({ key: 'confirm-write', message: 'The calendar asks you to confirm this change.' })
    return ctx.account.data
  }

  private touch(src: EventRec): void {
    src.version = this.service.next('v')
    src.modifiedAt = this.service.now()
  }

  private tell(src: EventRec, kind: 'invitation' | 'update' | 'cancellation', text: string, to?: string[]): void {
    for (const a of to ?? src.attendees.map((x) => x.address))
      this.service.send({ to: a, kind, subject: `${kind}: ${src.title}`, text })
  }

  /** Delivers an invitation to each invited account's main calendar, and takes back those no longer invited. */
  private deliver(src: EventRec): void {
    const invited = new Set(
      src.attendees.map((a) => this.service.userByEmail(a.address)?.id).filter((x): x is string => !!x)
    )
    for (const copy of [...this.events.values()].filter((e) => e.source === src.id)) {
      const owner = this.calendars.get(copy.calendar)?.owner
      if (!owner || !invited.has(owner)) this.events.delete(copy.id)
      else invited.delete(owner)
    }
    for (const userId of invited) {
      if (userId === src.organizer?.userId) continue
      const id = this.service.next('e')
      this.events.set(id, {
        ...src,
        id,
        calendar: this.primaryOf(userId),
        source: src.id,
        exdates: new Set(),
        overrides: new Map(),
      })
    }
  }

  private withAttendees(list: InviteeInput[], previous: EventRec['attendees']): EventRec['attendees'] {
    return list.map((a) => {
      const before = previous.find((p) => p.address.toLowerCase() === a.address.toLowerCase())
      return {
        address: a.address,
        ...(a.name ? { name: a.name } : {}),
        response: before?.response ?? 'needs-action',
        ...(a.optional ? { optional: true } : {}),
      }
    })
  }

  private busyIn(cal: CalRec, user: MemoryUser, fromMs: number, toMs: number): BusyTime[] {
    const spans: [number, number][] = []
    for (const ev of this.events.values()) {
      if (ev.calendar !== cal.id) continue
      const src = this.sourceOf(ev)
      if (src.status === 'cancelled') continue
      for (const o of this.occurrences(ev, toMs)) {
        if ((o.override?.busy ?? src.busy) === false) continue
        if (o.startMs < toMs && o.endMs > fromMs) spans.push([Math.max(o.startMs, fromMs), Math.min(o.endMs, toMs)])
      }
    }
    spans.sort((a, b) => a[0] - b[0])
    const merged: [number, number][] = []
    for (const s of spans) {
      const last = merged[merged.length - 1]
      if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1])
      else merged.push([...s])
    }
    void user
    return merged.map(([s, e]) => ({ start: utc(s), end: utc(e) }))
  }

  // ---- the provider of one account

  public provider(): CalendarProvider<MemoryUser> {
    const caps = this.options.capabilities
    const self = this
    const view = (user: MemoryUser, c: CalRec): Calendar => ({
      ref: c.id,
      title: c.title,
      ...(c.description ? { description: c.description } : {}),
      timeZone: c.timeZone,
      writable: self.writable(user, c),
      portable: true,
      ...(c.primary && c.owner === user.id ? { primary: true as const } : {}),
    })
    /** The event an account organizes, for a change or a cancellation; `permission-denied` for another's. */
    const organized = (user: MemoryUser, ev: EventRec): EventRec => {
      const src = self.sourceOf(ev)
      if (ev.source || (src.organizer && src.organizer.userId !== user.id))
        throw errors.permissionDenied('Only the organizer of an event changes or cancels it.')
      return src
    }

    const provider: CalendarProvider<MemoryUser> = {
      declaration: this.declaration(),

      calendars(args, ctx) {
        const user = self.guard(ctx, false)
        const q = args.query?.toLowerCase()
        const list = [...self.calendars.values()]
          .filter((c) => c.owner === user.id || c.readers.has(user.id) || c.writers.has(user.id))
          .filter((c) => q === undefined || c.title.toLowerCase().includes(q))
          .sort(
            (a, b) =>
              Number(b.primary && b.owner === user.id) - Number(a.primary && a.owner === user.id) ||
              (a.title + a.id < b.title + b.id ? -1 : 1)
          )
        const page = pageByOffset(list, ctx.page)
        return {
          calendars: page.items.map((c) => view(user, c)),
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        }
      },

      listEvents(args, ctx) {
        const user = self.guard(ctx, false)
        const cal = self.calendarOf(user, args.calendar)
        const fromMs = Date.parse(args.from)
        const toMs = Date.parse(args.to)
        const q = args.query?.toLowerCase()
        const found: { ev: CalendarEvent; startMs: number }[] = []
        for (const ev of self.events.values()) {
          if (ev.calendar !== cal.id) continue
          for (const o of self.occurrences(ev, toMs)) {
            if (!(o.startMs < toMs && o.endMs > fromMs)) continue
            const e = self.render(user, ev, o.key ? o : undefined)
            if (q && ![e.title, e.description ?? '', e.place ?? ''].some((t) => t.toLowerCase().includes(q))) continue
            found.push({ ev: e, startMs: o.startMs })
          }
        }
        found.sort((a, b) => a.startMs - b.startMs || (a.ev.ref < b.ev.ref ? -1 : a.ev.ref > b.ev.ref ? 1 : 0))
        const page = pageByOffset(found, ctx.page)
        return { events: page.items.map((f) => f.ev), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }
      },

      getEvent(args, ctx) {
        const user = self.guard(ctx, false)
        const cal = self.calendarOf(user, args.calendar)
        const { ev, occ } = self.eventIn(cal, args.ref)
        return { event: self.render(user, ev, occ, occ === undefined) }
      },

      createEvent(args, ctx) {
        const user = self.guard(ctx, false)
        const cal = self.calendarOf(user, args.calendar)
        if (!self.writable(user, cal)) throw errors.permissionDenied('This calendar is not writable for this account.')
        self.guard(ctx, true)
        const rule = args.rule ? parseRule(args.rule) : undefined
        const id = self.service.next('e')
        const now = self.service.now()
        const ev: EventRec = {
          id,
          calendar: cal.id,
          uid: `${id}@calendar.memory.invalid`,
          title: args.title,
          ...(args.description ? { description: args.description } : {}),
          ...(args.place ? { place: args.place } : {}),
          times: self.timesOf(args.start, args.end, args.allDay ?? false, args.timeZone),
          status: 'confirmed',
          busy: args.busy ?? true,
          organizer: { userId: user.id, address: user.email, name: user.name },
          attendees: self.withAttendees(args.attendees ?? [], []),
          ...(rule && 'rule' in rule ? { rule: rule.rule } : {}),
          exdates: new Set(),
          overrides: new Map(),
          ...(args.meeting
            ? { meeting: { url: `https://meet.memory.invalid/${id}`, label: self.options.meetingLabel } }
            : {}),
          createdAt: now,
          modifiedAt: now,
          version: self.service.next('v'),
        }
        self.events.set(id, ev)
        if (ev.attendees.length) {
          self.deliver(ev)
          if (args.notify !== false) self.tell(ev, 'invitation', '')
        }
        return { event: self.render(user, ev, undefined, true) }
      },

      updateEvent(args, ctx) {
        const user = self.guard(ctx, false)
        const cal = self.calendarOf(user, args.calendar)
        const { ev, occ } = self.eventIn(cal, args.ref)
        const src = organized(user, ev)
        if (!caps.includes('recurrence') && (occ || src.rule))
          throw errors.notSupported('This server does not change an occurrence or a series.')
        if (args.ifVersion !== undefined && args.ifVersion !== src.version) throw errors.versionMismatch(src.version)
        const series = !occ || args.scope === 'series'
        if (args.rule !== undefined && !series)
          throw errors.invalidArgument('rule', 'A change of the rule is of the series only.')
        const tz = self.calTz(ev)
        const current = occ?.times ?? src.times
        let times: Times | undefined
        if (args.start !== undefined && args.end !== undefined) {
          const allDay = args.allDay ?? isFullDate(args.start)
          const zone = args.timeZone ?? (current.kind === 'zoned' ? current.zone : undefined)
          times = self.timesOf(args.start, args.end, allDay, allDay ? undefined : zone)
        } else if (args.allDay !== undefined && args.allDay !== (current.kind === 'all-day')) {
          throw errors.invalidArgument('start', 'Give the start and the end with a change of "allDay".')
        } else if (args.timeZone !== undefined && current.kind !== 'all-day') {
          const at = self.startOn(current, undefined, tz)
          times = {
            kind: 'zoned',
            local: toLocal(at.startMs, args.timeZone),
            zone: args.timeZone,
            ms: at.endMs - at.startMs,
          }
        }
        self.guard(ctx, true)
        const fields: (keyof Override)[] = []
        if (series) {
          if (times) {
            if (occ) {
              // moved through an occurrence: every occurrence moves by as much
              const before = self.startOn(src.times, undefined, tz)
              const moved = self.startOn(times, undefined, tz)
              const delta = moved.startMs - occ.startMs
              const startMs = before.startMs + delta
              const ms = moved.endMs - moved.startMs
              src.times =
                times.kind === 'zoned'
                  ? { kind: 'zoned', local: toLocal(startMs, times.zone), zone: times.zone, ms }
                  : times.kind === 'utc'
                    ? { kind: 'utc', startMs, ms }
                    : times
            } else src.times = times
            fields.push('times')
          }
          if (args.title !== undefined) {
            src.title = args.title
            fields.push('title')
          }
          if (args.description !== undefined) {
            src.description = args.description || undefined
            fields.push('description')
          }
          if (args.place !== undefined) {
            src.place = args.place || undefined
            fields.push('place')
          }
          if (args.busy !== undefined) {
            src.busy = args.busy
            fields.push('busy')
          }
          if (args.rule !== undefined) {
            const r = parseRule(args.rule)
            if ('rule' in r) src.rule = r.rule
          }
          for (const o of src.overrides.values()) for (const f of fields) delete o[f]
        } else if (occ) {
          const o = src.overrides.get(occ.key) ?? {}
          if (times) o.times = times
          if (args.title !== undefined) o.title = args.title
          if (args.description !== undefined) o.description = args.description || null
          if (args.place !== undefined) o.place = args.place || null
          if (args.busy !== undefined) o.busy = args.busy
          src.overrides.set(occ.key, o)
        }
        if (args.attendees !== undefined) src.attendees = self.withAttendees(args.attendees, src.attendees)
        if (args.meeting === true && !src.meeting)
          src.meeting = { url: `https://meet.memory.invalid/${src.id}`, label: self.options.meetingLabel }
        if (args.meeting === false) src.meeting = undefined
        self.touch(src)
        if (args.attendees !== undefined || src.attendees.length) self.deliver(src)
        if (src.attendees.length && args.notify !== false && caps.includes('attendees')) self.tell(src, 'update', '')
        const after = occ ? self.occurrences(ev, occ.startMs + 400 * DAY).find((x) => x.key === occ.key) : undefined
        return { event: self.render(user, ev, after, !occ) }
      },

      cancelEvent(args, ctx) {
        const user = self.guard(ctx, false)
        const cal = self.calendarOf(user, args.calendar)
        const { ev, occ } = self.eventIn(cal, args.ref)
        const src = organized(user, ev)
        if (!caps.includes('recurrence') && (occ || src.rule))
          throw errors.notSupported('This server does not cancel an occurrence or a series.')
        if (args.ifVersion !== undefined && args.ifVersion !== src.version) throw errors.versionMismatch(src.version)
        self.guard(ctx, true)
        const notify = args.notify !== false && caps.includes('attendees') && src.attendees.length > 0
        if (occ && args.scope !== 'series') {
          src.exdates.add(occ.key)
          self.touch(src)
        } else {
          self.events.delete(src.id)
          for (const copy of [...self.events.values()].filter((e) => e.source === src.id)) self.events.delete(copy.id)
        }
        if (notify) self.tell(src, 'cancellation', args.comment ?? '')
        return { cancelled: true, ref: args.ref }
      },
    }

    if (caps.includes('free-busy'))
      provider.freeBusy = (args, ctx) => {
        const user = self.guard(ctx, false)
        const cal = self.calendarOf(user, args.calendar)
        const fromMs = Date.parse(args.from)
        const toMs = Date.parse(args.to)
        const out: ReturnType<NonNullable<CalendarProvider['freeBusy']>> = {
          calendar: { busy: self.busyIn(cal, user, fromMs, toMs) },
        }
        if (args.people) {
          ;(out as { people?: unknown[] }).people = args.people.map((address) => {
            const u = self.service.userByEmail(address)
            const primary = u ? self.calendars.get(self.primaryOf(u.id)) : undefined
            return primary
              ? { address, known: true, busy: self.busyIn(primary, user, fromMs, toMs) }
              : { address, known: false, busy: [] }
          })
        }
        return out
      }

    if (caps.includes('respond'))
      provider.respond = (args, ctx) => {
        const user = self.guard(ctx, false)
        const cal = self.calendarOf(user, args.calendar)
        const { ev, occ } = self.eventIn(cal, args.ref)
        const src = self.sourceOf(ev)
        const email = user.email.toLowerCase()
        const line = src.attendees.find((a) => a.address.toLowerCase() === email)
        if (!line || src.organizer?.userId === user.id)
          throw errors.notSupported('The account is not invited to this event.')
        self.guard(ctx, true)
        if (occ && args.scope !== 'series') {
          const o = src.overrides.get(occ.key) ?? {}
          o.responses = { ...(o.responses ?? {}), [email]: args.response }
          src.overrides.set(occ.key, o)
        } else {
          line.response = args.response
          for (const o of src.overrides.values()) if (o.responses) delete o.responses[email]
        }
        self.touch(src)
        if (args.notify !== false && src.organizer)
          self.service.send({
            to: src.organizer.address,
            kind: 'reply',
            subject: `${args.response}: ${src.title}`,
            text: args.comment ?? '',
          })
        const after = occ ? self.occurrences(ev, occ.startMs + 400 * DAY).find((x) => x.key === occ.key) : undefined
        return { event: self.render(user, ev, after, !occ) }
      }

    return provider
  }
}
