/**
 * Google Calendar as a provider of Calendar 1.0 (providers §6, the Google column of calendar §6). A calendar's
 * reference is its id, the same for every account it is shared with (`portable: true`); an event's is its id, an
 * occurrence having one of its own; its version is its `etag`, sent as `If-Match` on a change and a cancellation, which
 * Google compares and writes in one step (`atomicWrites: true`). Google sends the invitations, the changes, the
 * cancellations and the answers (`sendUpdates`); the connector sends nothing itself.
 *
 * Each tool calls only the methods its scope of the agent's table covers (the Ayni Agent's architecture §10.10):
 * `calendar_calendars` reads the calendar list; `calendar_list_events` and `calendar_get_event` read events;
 * `calendar_free_busy` asks `freeBusy.query` alone; the changes read and write events.
 */
import { type CalendarDeclaration, formatRule, isFullDate, parseRule } from '@ayni.org/ayni-feature-profiles'
import { type CalendarProvider, type CallContext, errors, pageByOffset } from '@ayni.org/ayni-provider-kit'
import {
  CALENDAR_FIELDS,
  calendarOf,
  EVENT_FIELDS,
  eventOf,
  type GAttendee,
  type GCalendarEntry,
  type GEvent,
  type GTime,
  googleTime,
  holdsText,
  isMine,
  MEETING_LABEL,
  mergeBusy,
  zoneOf,
} from './calendar-map.js'
import type { GoogleAccount } from './drive.js'
import { type GoogleClient, isGoogleError, profileErrorOf, seg } from './google.js'
import { allPages, fillPage } from './pages.js'
import { addDays, daysBetween, midnightIn } from './time.js'

type Ctx = CallContext<GoogleAccount, CalendarDeclaration>

export const CALENDAR_DECLARATION: CalendarProvider['declaration'] = {
  capabilities: ['free-busy', 'recurrence', 'attendees', 'respond', 'meeting'],
  atomicWrites: true,
  meeting: { label: MEETING_LABEL },
}

const GOOGLE_PAGE = 100
const EVENTS_PAGE = 2500

const events = (calendar: string) => `/calendars/${seg(calendar)}/events`
const eventPath = (calendar: string, id: string) => `${events(calendar)}/${seg(id)}`

/** The events Google answers for a time: every page, then the profile's order (calendar §3.2: by start, then by ref). */
async function eventsBetween(
  g: GoogleClient,
  calendar: string,
  from: string,
  to: string
): Promise<{ list: GEvent[]; zone?: string }> {
  let zone: string | undefined
  const list = await allPages(async (token) => {
    const data = await g
      .json<{ items?: GEvent[]; nextPageToken?: string; timeZone?: string }>('calendar', 'GET', events(calendar), {
        query: {
          timeMin: from,
          timeMax: to,
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: EVENTS_PAGE,
          ...(token ? { pageToken: token } : {}),
          fields: `nextPageToken,timeZone,items(${EVENT_FIELDS})`,
        },
      })
      .catch((e) => {
        throw profileErrorOf(e)
      })
    zone ??= data.timeZone
    return { items: data.items ?? [], ...(data.nextPageToken ? { next: data.nextPageToken } : {}) }
  })
  return { list, ...(zone ? { zone } : {}) }
}

async function getEvent(g: GoogleClient, calendar: string, id: string): Promise<GEvent> {
  return g.json<GEvent>('calendar', 'GET', eventPath(calendar, id), { query: { fields: EVENT_FIELDS } }).catch((e) => {
    throw profileErrorOf(e)
  })
}

/** An event to act on: not cancelled. */
async function liveEvent(g: GoogleClient, calendar: string, id: string): Promise<GEvent> {
  const ev = await getEvent(g, calendar, id)
  if (ev.status === 'cancelled') throw errors.notFound('No such event in this calendar.')
  return ev
}

/** The instant an event starts, for ordering: an all-day event at midnight of the calendar's zone. */
function startMs(ev: GEvent, zone: string | undefined): number {
  if (ev.start?.date) return midnightIn(ev.start.date, zone)
  const ms = Date.parse(ev.start?.dateTime ?? '')
  return Number.isNaN(ms) ? 0 : ms
}

const sendUpdates = (notify: boolean | undefined) => (notify === false ? 'none' : 'all')

/** A request id for Google Meet, new for each creation. */
const meetingRequest = () => ({
  createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } },
})

/** The attendees to write for a list the call gives: earlier answers kept, rooms and the organizer's own line kept. */
function attendeesFor(
  given: { address: string; name?: string; optional?: boolean }[],
  current: GAttendee[] | undefined
): GAttendee[] {
  const before = current ?? []
  const people = given.map((a) => {
    const was = before.find((b) => b.email?.toLowerCase() === a.address.toLowerCase())
    return {
      email: a.address,
      ...(a.name ? { displayName: a.name } : {}),
      ...(a.optional ? { optional: true } : {}),
      responseStatus: was?.responseStatus ?? 'needsAction',
    }
  })
  const kept = before.filter(
    (b) => b.resource === true && !given.some((a) => a.address.toLowerCase() === b.email?.toLowerCase())
  )
  return [...people, ...kept]
}

/** Waits for Google Meet's link of a new event, which Google may make after it answers (`createRequest` pending). */
async function withMeeting(g: GoogleClient, calendar: string, ev: GEvent): Promise<GEvent> {
  let current = ev
  for (let i = 0; i < 5 && current.conferenceData?.createRequest?.status?.statusCode === 'pending'; i++) {
    await new Promise((r) => setTimeout(r, 300 * (i + 1)))
    current = await getEvent(g, calendar, ev.id)
  }
  return current
}

export function calendarProvider(client: (ctx: Ctx) => GoogleClient): CalendarProvider<GoogleAccount> {
  const provider: CalendarProvider<GoogleAccount> = {
    declaration: CALENDAR_DECLARATION,

    async calendars(args, ctx) {
      const g = client(ctx)
      const query = args.query
      const page = await fillPage(
        async (token) => {
          const data = await g
            .json<{ items?: GCalendarEntry[]; nextPageToken?: string }>('calendar', 'GET', '/users/me/calendarList', {
              query: {
                minAccessRole: 'reader',
                maxResults: GOOGLE_PAGE,
                ...(token ? { pageToken: token } : {}),
                fields: `nextPageToken,items(${CALENDAR_FIELDS})`,
              },
            })
            .catch((e) => {
              throw profileErrorOf(e)
            })
          return { items: data.items ?? [], ...(data.nextPageToken ? { next: data.nextPageToken } : {}) }
        },
        (entry) => {
          const c = calendarOf(entry)
          return query === undefined || holdsText(c.title, query) ? c : undefined
        },
        ctx.page
      )
      return { calendars: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }
    },

    async listEvents(args, ctx) {
      const g = client(ctx)
      const { list, zone } = await eventsBetween(g, args.calendar, args.from, args.to)
      const q = args.query
      const kept = list
        .filter((ev) => ev.status !== 'cancelled')
        .map((ev) => ({ ev, at: startMs(ev, zone), e: eventOf(ev, args.calendar) }))
        .filter(({ e }) => q === undefined || [e.title, e.description, e.place].some((t) => holdsText(t, q)))
        .sort((a, b) => a.at - b.at || (a.e.ref < b.e.ref ? -1 : a.e.ref > b.e.ref ? 1 : 0))
      const page = pageByOffset(kept, ctx.page)
      return { events: page.items.map((k) => k.e), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }
    },

    async getEvent(args, ctx) {
      const g = client(ctx)
      return { event: eventOf(await getEvent(g, args.calendar, args.ref), args.calendar) }
    },

    async createEvent(args, ctx) {
      const g = client(ctx)
      const allDay = args.allDay ?? false
      const rule = args.rule !== undefined ? parseRule(args.rule) : undefined
      const body: Record<string, unknown> = {
        summary: args.title,
        ...(args.description ? { description: args.description } : {}),
        ...(args.place ? { location: args.place } : {}),
        start: googleTime(args.start, allDay, allDay ? undefined : args.timeZone),
        end: googleTime(args.end, allDay, allDay ? undefined : args.timeZone),
        transparency: args.busy === false ? 'transparent' : 'opaque',
        ...(rule && 'rule' in rule ? { recurrence: [`RRULE:${formatRule(rule.rule)}`] } : {}),
        ...(args.attendees?.length ? { attendees: attendeesFor(args.attendees, []) } : {}),
        ...(args.meeting ? { conferenceData: meetingRequest() } : {}),
      }
      const made = await g
        .json<GEvent>('calendar', 'POST', events(args.calendar), {
          query: { conferenceDataVersion: 1, sendUpdates: sendUpdates(args.notify), fields: EVENT_FIELDS },
          json: body,
        })
        .catch((e) => {
          throw profileErrorOf(e)
        })
      const ev = args.meeting ? await withMeeting(g, args.calendar, made) : made
      return { event: eventOf(ev, args.calendar) }
    },

    async updateEvent(args, ctx) {
      const g = client(ctx)
      const ev = await liveEvent(g, args.calendar, args.ref)
      if (!isMine(ev)) throw errors.permissionDenied('Only the organizer of an event changes it.')
      if (args.ifVersion !== undefined && args.ifVersion !== ev.etag) throw errors.versionMismatch(ev.etag ?? '')
      const occurrence = ev.recurringEventId !== undefined
      if (occurrence && args.scope !== 'series' && args.rule !== undefined)
        throw errors.invalidArgument('rule', 'A change of the rule is of the series only.')
      const onSeries = occurrence && args.scope === 'series'
      const target = onSeries ? await liveEvent(g, args.calendar, ev.recurringEventId as string) : ev
      const body: Record<string, unknown> = {}
      if (args.title !== undefined) body.summary = args.title
      if (args.description !== undefined) body.description = args.description
      if (args.place !== undefined) body.location = args.place
      if (args.busy !== undefined) body.transparency = args.busy ? 'opaque' : 'transparent'
      const currentAllDay = !!ev.start?.date
      if (args.start !== undefined && args.end !== undefined) {
        const allDay = args.allDay ?? isFullDate(args.start)
        const zone = allDay ? undefined : (args.timeZone ?? zoneOf(target))
        if (onSeries) Object.assign(body, shifted(ev, target, args.start, args.end, allDay, zone))
        else {
          body.start = googleTime(args.start, allDay, zone)
          body.end = googleTime(args.end, allDay, zone)
        }
      } else if (args.allDay !== undefined && args.allDay !== currentAllDay) {
        throw errors.invalidArgument('start', 'Give the start and the end with a change of "allDay".')
      } else if (args.timeZone !== undefined && !currentAllDay) {
        // the same instants, set in another zone
        body.start = { dateTime: target.start?.dateTime ?? null, timeZone: args.timeZone, date: null }
        body.end = { dateTime: target.end?.dateTime ?? null, timeZone: args.timeZone, date: null }
      }
      if (args.rule !== undefined) {
        const r = parseRule(args.rule)
        if ('rule' in r) {
          const others = (target.recurrence ?? []).filter((l) => !/^RRULE:/i.test(l))
          body.recurrence = [`RRULE:${formatRule(r.rule)}`, ...others]
        }
      }
      if (args.attendees !== undefined) body.attendees = attendeesFor(args.attendees, target.attendees)
      if (args.meeting === true && !target.conferenceData && !target.hangoutLink) body.conferenceData = meetingRequest()
      if (args.meeting === false) body.conferenceData = null
      const changed = await g
        .json<GEvent>('calendar', 'PATCH', eventPath(args.calendar, target.id), {
          query: { conferenceDataVersion: 1, sendUpdates: sendUpdates(args.notify), fields: EVENT_FIELDS },
          json: body,
          // Google compares the version and writes in one step (atomicWrites: true)
          ...(args.ifVersion !== undefined && target.id === ev.id ? { headers: { 'if-match': args.ifVersion } } : {}),
        })
        .catch(async (e) => {
          if (isGoogleError(e) && e.status === 412) {
            const now = await getEvent(g, args.calendar, target.id)
            throw errors.versionMismatch(now.etag ?? '')
          }
          throw profileErrorOf(e)
        })
      let out = args.meeting ? await withMeeting(g, args.calendar, changed) : changed
      if (onSeries) {
        // answered as the occurrence the call named, when Google still has it by that reference
        out = await getEvent(g, args.calendar, ev.id).catch(() => out)
      }
      return { event: eventOf(out, args.calendar) }
    },

    async cancelEvent(args, ctx) {
      const g = client(ctx)
      const ev = await liveEvent(g, args.calendar, args.ref)
      if (!isMine(ev)) throw errors.permissionDenied('Only the organizer of an event cancels it.')
      // Google's cancellation carries no message of the organizer: a comment would be dropped, so it is refused
      if (args.comment !== undefined)
        throw errors.notSupported('Google Calendar sends no message with a cancellation.', 'comment')
      if (args.ifVersion !== undefined && args.ifVersion !== ev.etag) throw errors.versionMismatch(ev.etag ?? '')
      const targetId = ev.recurringEventId !== undefined && args.scope === 'series' ? ev.recurringEventId : ev.id
      await g
        .request('calendar', 'DELETE', eventPath(args.calendar, targetId), {
          query: { sendUpdates: sendUpdates(args.notify) },
          ...(args.ifVersion !== undefined && targetId === ev.id ? { headers: { 'if-match': args.ifVersion } } : {}),
          read: 'none',
        })
        .catch(async (e) => {
          if (isGoogleError(e) && e.status === 412) {
            const now = await getEvent(g, args.calendar, targetId)
            throw errors.versionMismatch(now.etag ?? '')
          }
          throw profileErrorOf(e)
        })
      return { cancelled: true, ref: args.ref }
    },

    async freeBusy(args, ctx) {
      const g = client(ctx)
      const people = args.people ?? []
      const data = await g
        .json<{
          calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: { reason?: string }[] }>
        }>('calendar', 'POST', '/freeBusy', {
          json: {
            timeMin: args.from,
            timeMax: args.to,
            items: [{ id: args.calendar }, ...people.map((id) => ({ id }))],
          },
        })
        .catch((e) => {
          throw profileErrorOf(e)
        })
      const entries = Object.entries(data.calendars ?? {})
      const find = (id: string) => entries.find(([k]) => k.toLowerCase() === id.toLowerCase())?.[1]
      const fromMs = Date.parse(args.from)
      const toMs = Date.parse(args.to)
      const own = find(args.calendar)
      if (!own || own.errors?.length) throw errors.notFound('No such calendar for this account.')
      return {
        calendar: { busy: mergeBusy(own.busy ?? [], fromMs, toMs) },
        ...(args.people
          ? {
              people: people.map((address) => {
                const e = find(address)
                return e && !e.errors?.length
                  ? { address, known: true, busy: mergeBusy(e.busy ?? [], fromMs, toMs) }
                  : { address, known: false, busy: [] }
              }),
            }
          : {}),
      }
    },

    async respond(args, ctx) {
      const g = client(ctx)
      const ev = await liveEvent(g, args.calendar, args.ref)
      if (isMine(ev)) throw errors.notSupported('The account organizes this event.')
      if (!ev.attendees?.some((a) => a.self === true))
        throw errors.notSupported('The account is not invited to this event.')
      const onSeries = ev.recurringEventId !== undefined && args.scope === 'series'
      const target = onSeries ? await liveEvent(g, args.calendar, ev.recurringEventId as string) : ev
      const attendees = (target.attendees ?? []).map((a) =>
        a.self === true
          ? { ...a, responseStatus: args.response, ...(args.comment !== undefined ? { comment: args.comment } : {}) }
          : a
      )
      const changed = await g
        .json<GEvent>('calendar', 'PATCH', eventPath(args.calendar, target.id), {
          query: { sendUpdates: sendUpdates(args.notify), fields: EVENT_FIELDS },
          json: { attendees },
        })
        .catch((e) => {
          throw profileErrorOf(e)
        })
      const out = onSeries ? await getEvent(g, args.calendar, ev.id) : changed
      return { event: eventOf(out, args.calendar) }
    },
  }
  return provider
}

/**
 * A series moved through one of its occurrences (`scope: "series"`): every occurrence moves by as much as that one
 * (calendar §4.2), its length the one given.
 */
function shifted(
  occurrence: GEvent,
  series: GEvent,
  start: string,
  end: string,
  allDay: boolean,
  zone: string | undefined
): { start: GTime; end: GTime } {
  if (allDay) {
    const from = occurrence.start?.date ?? occurrence.originalStartTime?.date ?? start
    const days = daysBetween(from, start)
    const first = addDays(series.start?.date ?? from, days)
    return {
      start: googleTime(first, true, undefined),
      end: googleTime(addDays(first, daysBetween(start, end)), true, undefined),
    }
  }
  const delta = Date.parse(start) - Date.parse(occurrence.start?.dateTime ?? start)
  const firstMs = Date.parse(series.start?.dateTime ?? start) + delta
  const length = Date.parse(end) - Date.parse(start)
  const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z')
  return { start: googleTime(iso(firstMs), false, zone), end: googleTime(iso(firstMs + length), false, zone) }
}
