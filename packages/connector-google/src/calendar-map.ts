/**
 * How Google Calendar reads as Calendar 1.0 (providers §6, the Google column of calendar §6): an event's members, its
 * times in the zone it was set in, its attendees, its rule and its meeting. Pure functions, unit-tested on their own.
 */
import type { Attendee, AttendeeResponse, Calendar, CalendarEvent } from '@ayni.org/ayni-feature-profiles'
import { formatInstant, instantOf, knownZone, utc } from './time.js'

export interface GTime {
  date?: string | null
  dateTime?: string | null
  timeZone?: string | null
}

export interface GAttendee {
  email?: string
  displayName?: string
  organizer?: boolean
  self?: boolean
  resource?: boolean
  optional?: boolean
  responseStatus?: string
  comment?: string
}

/** An event of the Calendar API v3, with the members the connector reads. */
export interface GEvent {
  id: string
  etag?: string
  status?: string
  htmlLink?: string
  created?: string
  updated?: string
  summary?: string
  description?: string
  location?: string
  organizer?: { email?: string; displayName?: string; self?: boolean }
  start?: GTime
  end?: GTime
  recurrence?: string[]
  recurringEventId?: string
  originalStartTime?: GTime
  transparency?: string
  iCalUID?: string
  attendees?: GAttendee[]
  hangoutLink?: string
  conferenceData?: {
    createRequest?: { status?: { statusCode?: string } }
    entryPoints?: { entryPointType?: string; uri?: string }[]
    conferenceSolution?: { name?: string; key?: { type?: string } }
  }
}

export interface GCalendarEntry {
  id: string
  summary?: string
  summaryOverride?: string
  description?: string
  timeZone?: string
  accessRole?: string
  primary?: boolean
}

export const EVENT_FIELDS =
  'id,etag,status,htmlLink,created,updated,summary,description,location,organizer,start,end,recurrence,recurringEventId,originalStartTime,transparency,iCalUID,attendees,hangoutLink,conferenceData'

export const CALENDAR_FIELDS = 'id,summary,summaryOverride,description,timeZone,accessRole,primary'

/** What people know Google's meetings by (calendar §4.5). */
export const MEETING_LABEL = 'Google Meet'

const RESPONSES: Record<string, AttendeeResponse> = {
  needsAction: 'needs-action',
  accepted: 'accepted',
  tentative: 'tentative',
  declined: 'declined',
}

export function responseOf(status: string | undefined): AttendeeResponse {
  return RESPONSES[status ?? ''] ?? 'needs-action'
}

export function googleResponseOf(response: 'accepted' | 'tentative' | 'declined'): string {
  return response
}

/** A calendar of the account's list (calendar §2). */
export function calendarOf(e: GCalendarEntry): Calendar {
  const title = e.summaryOverride ?? e.summary ?? e.id
  return {
    ref: e.id,
    title,
    ...(e.description ? { description: e.description } : {}),
    ...(e.timeZone ? { timeZone: e.timeZone } : {}),
    writable: e.accessRole === 'owner' || e.accessRole === 'writer',
    portable: true,
    ...(e.primary === true ? { primary: true as const } : {}),
  }
}

/** A text lower-cased in its ASCII letters only (calendar §3.1, §3.2: "whatever the case of ASCII letters"). */
export function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase())
}

export function holdsText(haystack: string | undefined, needle: string): boolean {
  return haystack !== undefined && asciiLower(haystack).includes(asciiLower(needle))
}

/** The plain text of a description Google keeps marked up (calendar §1: "a service that keeps marked-up text gives its text"). */
export function plainText(text: string): string {
  if (!/<\/?[a-z][^>]*>/i.test(text)) return text
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** An instant of an event in the zone it was set in, or in UTC (calendar §1, Times). */
export function timeOf(t: GTime | undefined, zone: string | undefined): string | undefined {
  if (!t) return undefined
  if (t.date) return t.date
  if (!t.dateTime) return undefined
  const ms = Date.parse(t.dateTime)
  if (Number.isNaN(ms)) return t.dateTime
  return zone ? formatInstant(ms, zone) : utc(ms)
}

/** The zone an event was set in, when the runtime knows it. */
export function zoneOf(ev: GEvent): string | undefined {
  const z = ev.start?.date ? undefined : (ev.start?.timeZone ?? undefined)
  return z && knownZone(z) ? z : undefined
}

/** The rule of a series: the value of its `RRULE` line (calendar §4.2). */
export function ruleOf(recurrence: string[] | undefined): string | undefined {
  const line = recurrence?.find((l) => /^RRULE:/i.test(l))
  return line ? line.replace(/^RRULE:/i, '') : undefined
}

/** The meeting of an event: its video entry point, or Google Meet's link (calendar §1, `meeting`). */
export function meetingOf(ev: GEvent): { url: string; label?: string } | undefined {
  const video = ev.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video' && p.uri)
  const label = ev.conferenceData?.conferenceSolution?.name
  if (video?.uri) return { url: video.uri, ...(label ? { label } : {}) }
  if (ev.hangoutLink) return { url: ev.hangoutLink, label: MEETING_LABEL }
  return undefined
}

/** The people invited, as the profile reads them; a resource (a room) is not a person (calendar §5). */
export function attendeesOf(list: GAttendee[] | undefined): Attendee[] {
  return (list ?? [])
    .filter((a) => !a.resource && a.email)
    .map((a) => ({
      address: (a.email as string).replace(/^mailto:/i, ''),
      ...(a.displayName ? { name: a.displayName } : {}),
      response: responseOf(a.responseStatus),
      ...(a.optional === true ? { optional: true as const } : {}),
      ...(a.self === true ? { self: true as const } : {}),
    }))
}

/** Whether the account organizes an event: no organizer, or this calendar's copy is the organizer's. */
export function isMine(ev: GEvent): boolean {
  return !ev.organizer || ev.organizer.self === true
}

/** The profile's event of one of Google's (calendar §1). */
export function eventOf(ev: GEvent, calendar: string): CalendarEvent {
  const allDay = !!ev.start?.date
  const zone = zoneOf(ev)
  const start = timeOf(ev.start, zone) ?? ''
  const end = timeOf(ev.end, zone) ?? start
  const status = ev.status === 'tentative' || ev.status === 'cancelled' ? ev.status : 'confirmed'
  const description = ev.description ? plainText(ev.description) : undefined
  const attendees = attendeesOf(ev.attendees)
  const recurring = !!ev.recurringEventId || !!ruleOf(ev.recurrence)
  const rule = ev.recurringEventId ? undefined : ruleOf(ev.recurrence)
  const meeting = meetingOf(ev)
  const organizer = ev.organizer
    ? {
        ...(ev.organizer.email ? { address: ev.organizer.email } : {}),
        ...(ev.organizer.displayName ? { name: ev.organizer.displayName } : {}),
      }
    : undefined
  const created = instantOf(ev.created)
  const modified = instantOf(ev.updated)
  return {
    ref: ev.id,
    calendar,
    ...(ev.iCalUID ? { uid: ev.iCalUID } : {}),
    title: ev.summary ?? '',
    ...(description ? { description } : {}),
    ...(ev.location ? { place: ev.location } : {}),
    allDay,
    start,
    end,
    ...(zone ? { timeZone: zone } : {}),
    status,
    busy: ev.transparency !== 'transparent',
    ...(organizer && Object.keys(organizer).length ? { organizer } : {}),
    mine: isMine(ev),
    ...(attendees.length ? { attendees } : {}),
    recurring,
    ...(ev.recurringEventId ? { series: ev.recurringEventId } : {}),
    ...(rule ? { rule } : {}),
    ...(meeting ? { meeting } : {}),
    ...(ev.htmlLink ? { webUrl: ev.htmlLink } : {}),
    ...(created ? { createdAt: created } : {}),
    ...(modified ? { modifiedAt: modified } : {}),
    version: ev.etag ?? `"${ev.updated ?? ev.id}"`,
  }
}

/** Google's time of an event for a start or an end the profile gives (calendar §1: in UTC when no zone is given). */
export function googleTime(value: string, allDay: boolean, zone: string | undefined): GTime {
  if (allDay) return { date: value, dateTime: null, timeZone: null }
  const ms = Date.parse(value)
  return zone ? { dateTime: value, timeZone: zone, date: null } : { dateTime: utc(ms), timeZone: null, date: null }
}

/** Busy times merged and in order, within the time asked (calendar §4.1). */
export function mergeBusy(spans: { start: string; end: string }[], fromMs: number, toMs: number) {
  const list = spans
    .map((s) => [Math.max(Date.parse(s.start), fromMs), Math.min(Date.parse(s.end), toMs)] as [number, number])
    .filter(([s, e]) => !Number.isNaN(s) && !Number.isNaN(e) && e > s)
    .sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const s of list) {
    const last = merged[merged.length - 1]
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1])
    else merged.push([s[0], s[1]])
  }
  return merged.map(([s, e]) => ({ start: utc(s), end: utc(e) }))
}
