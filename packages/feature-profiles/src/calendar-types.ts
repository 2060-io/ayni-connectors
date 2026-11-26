/** The TypeScript shapes of Calendar 1.0 (calendar §1 to §4): events, calendars, the declaration, each tool's arguments and result. */
import type { CalendarCapability } from './calendar.js'
import type { DeclarationBase } from './common.js'
import type { Page, PageArgs } from './files-types.js'

export type AttendeeResponse = 'needs-action' | 'accepted' | 'tentative' | 'declined'

/** An attendee (calendar §1). */
export interface Attendee {
  address: string
  name?: string
  response: AttendeeResponse
  optional?: true
  self?: true
}

export type EventStatus = 'confirmed' | 'tentative' | 'cancelled'

/** An event (calendar §1). */
export interface CalendarEvent {
  ref: string
  calendar: string
  uid?: string
  title: string
  description?: string
  place?: string
  allDay: boolean
  start: string
  end: string
  timeZone?: string
  status: EventStatus
  busy: boolean
  organizer?: { address?: string; name?: string }
  mine: boolean
  attendees?: Attendee[]
  recurring: boolean
  series?: string
  rule?: string
  meeting?: { url: string; label?: string }
  webUrl?: string
  createdAt?: string
  modifiedAt?: string
  version: string
  [member: `x_${string}`]: unknown
}

/** A calendar, the location (calendar §2). */
export interface Calendar {
  ref: string
  title: string
  description?: string
  timeZone?: string
  writable: boolean
  portable: boolean
  primary?: true
}

/** What a provider of Calendar declares (common §3, calendar §4). */
export interface CalendarDeclaration extends DeclarationBase<CalendarCapability> {
  meeting?: { label: string }
}

export type Scope = 'this' | 'series'

export interface InviteeInput {
  address: string
  name?: string
  optional?: boolean
}

export interface CalendarCalendarsArgs extends PageArgs {
  query?: string
}
export interface CalendarCalendarsResult extends Page {
  calendars: Calendar[]
}

export interface CalendarListEventsArgs extends PageArgs {
  calendar: string
  from: string
  to: string
  query?: string
}
export interface CalendarListEventsResult extends Page {
  events: CalendarEvent[]
}

export interface CalendarGetEventArgs {
  calendar: string
  ref: string
}
export interface EventResult {
  event: CalendarEvent
}

export interface EventMembersInput {
  title?: string
  start?: string
  end?: string
  allDay?: boolean
  timeZone?: string
  description?: string
  place?: string
  busy?: boolean
  /** capability `recurrence` */
  rule?: string
  /** capability `attendees` */
  attendees?: InviteeInput[]
  /** capability `attendees` */
  notify?: boolean
  /** capability `meeting` */
  meeting?: boolean
}

export interface CalendarCreateEventArgs extends EventMembersInput {
  calendar: string
  title: string
  start: string
  end: string
}

export interface CalendarUpdateEventArgs extends EventMembersInput {
  calendar: string
  ref: string
  ifVersion?: string
  /** capability `recurrence` */
  scope?: Scope
}

export interface CalendarCancelEventArgs {
  calendar: string
  ref: string
  ifVersion?: string
  /** capability `attendees` */
  notify?: boolean
  /** capability `attendees` */
  comment?: string
  /** capability `recurrence` */
  scope?: Scope
}
export interface CalendarCancelEventResult {
  cancelled: true
  ref: string
}

export interface BusyTime {
  start: string
  end: string
}

export interface CalendarFreeBusyArgs {
  calendar: string
  from: string
  to: string
  people?: string[]
}
export interface CalendarFreeBusyResult {
  calendar: { busy: BusyTime[] }
  people?: { address: string; known: boolean; busy: BusyTime[] }[]
}

export interface CalendarRespondArgs {
  calendar: string
  ref: string
  response: 'accepted' | 'tentative' | 'declined'
  comment?: string
  notify?: boolean
  /** capability `recurrence` */
  scope?: Scope
}
