/**
 * Calendar 1.0 (spec `v4/ayni-feature-profiles/calendar.md`), transcribed: identifier `org.ayni/calendar`, prefix
 * `calendar_`, location argument `calendar`. The descriptions are the words the model reads; the titles, those people
 * read.
 */
import {
  COMMON_ERRORS,
  errorContentSchema,
  INSTANT_SCHEMA,
  type JsonSchema,
  NEXT_CURSOR_SCHEMA,
  REF_SCHEMA,
  VERSION_SCHEMA,
} from './common.js'
import { type ArgumentDefinition, type ProfileDefinition, pageArguments, type ToolDefinition } from './profile.js'

export const CALENDAR_ID = 'org.ayni/calendar'
export const CALENDAR_VERSION = '1.0'
export const CALENDAR_PREFIX = 'calendar_'

export const CALENDAR_CAPABILITIES = ['free-busy', 'recurrence', 'attendees', 'respond', 'meeting'] as const
export type CalendarCapability = (typeof CALENDAR_CAPABILITIES)[number]

/** The most days `calendar_list_events` and `calendar_free_busy` take between `from` and `to` (calendar §3.2, §4.1). */
export const LIST_EVENTS_MAX_DAYS = 366
export const FREE_BUSY_MAX_DAYS = 62

const EMAIL: JsonSchema = { type: 'string', format: 'email', maxLength: 254 }
const TIME: JsonSchema = { type: 'string', minLength: 10 }
const DATE_TIME: JsonSchema = { type: 'string', format: 'date-time' }
const TIME_ZONE: JsonSchema = { type: 'string', minLength: 1 }
const RESPONSES = ['needs-action', 'accepted', 'tentative', 'declined']

/** An attendee of an event (calendar §1): `optional` and `self` present only when true; an address without `mailto:`. */
export const ATTENDEE_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['address', 'response'],
  properties: {
    address: { type: 'string', minLength: 1, pattern: '^(?![Mm][Aa][Ii][Ll][Tt][Oo]:)' },
    name: { type: 'string' },
    response: { enum: RESPONSES },
    optional: { const: true },
    self: { const: true },
  },
}

/** An event (calendar §1). */
export const EVENT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['ref', 'calendar', 'title', 'allDay', 'start', 'end', 'status', 'busy', 'mine', 'recurring', 'version'],
  properties: {
    ref: REF_SCHEMA,
    calendar: REF_SCHEMA,
    uid: { type: 'string', minLength: 1 },
    title: { type: 'string' },
    description: { type: 'string' },
    place: { type: 'string' },
    allDay: { type: 'boolean' },
    start: { type: 'string', minLength: 10 },
    end: { type: 'string', minLength: 10 },
    timeZone: { type: 'string', minLength: 1 },
    status: { enum: ['confirmed', 'tentative', 'cancelled'] },
    busy: { type: 'boolean' },
    organizer: { type: 'object', properties: { address: { type: 'string' }, name: { type: 'string' } } },
    mine: { type: 'boolean' },
    attendees: { type: 'array', items: ATTENDEE_SCHEMA },
    recurring: { type: 'boolean' },
    series: REF_SCHEMA,
    rule: { type: 'string', minLength: 1 },
    meeting: {
      type: 'object',
      required: ['url'],
      properties: { url: { type: 'string', minLength: 1 }, label: { type: 'string' } },
    },
    webUrl: { type: 'string', minLength: 1 },
    createdAt: INSTANT_SCHEMA,
    modifiedAt: INSTANT_SCHEMA,
    version: VERSION_SCHEMA,
  },
}

/** A calendar, the location of the profile (calendar §2): `primary` present only on the account's main calendar. */
export const CALENDAR_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['ref', 'title', 'writable', 'portable'],
  properties: {
    ref: REF_SCHEMA,
    title: { type: 'string' },
    description: { type: 'string' },
    timeZone: { type: 'string', minLength: 1 },
    writable: { type: 'boolean' },
    portable: { type: 'boolean' },
    primary: { const: true },
  },
}

const BUSY_TIMES: JsonSchema = {
  type: 'array',
  items: {
    type: 'object',
    required: ['start', 'end'],
    properties: { start: DATE_TIME, end: DATE_TIME },
  },
}

function object(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: 'object', required, properties }
}

const CALENDAR_ARG: ArgumentDefinition = { name: 'calendar', title: 'Calendar', schema: REF_SCHEMA, required: true }
const EVENT_REF: ArgumentDefinition = { name: 'ref', title: 'Event', schema: REF_SCHEMA, required: true }
const IF_VERSION: ArgumentDefinition = {
  name: 'ifVersion',
  title: 'Version read',
  schema: VERSION_SCHEMA,
  required: false,
}
const SCOPE: ArgumentDefinition = {
  name: 'scope',
  title: 'Applies to',
  schema: { enum: ['this', 'series'] },
  required: false,
  capability: 'recurrence',
}
const ATTENDEES_ARG: ArgumentDefinition = {
  name: 'attendees',
  title: 'Invited',
  schema: {
    type: 'array',
    maxItems: 100,
    items: {
      type: 'object',
      required: ['address'],
      properties: { address: EMAIL, name: { type: 'string' }, optional: { type: 'boolean' } },
      additionalProperties: false,
    },
  },
  required: false,
  capability: 'attendees',
  addresses: ['*/address'],
}

/** The members of an event a creation takes (calendar §3.4), required as a creation requires them. */
function eventMembers(creation: boolean): ArgumentDefinition[] {
  return [
    { name: 'title', title: 'Title', schema: { type: 'string', maxLength: 1024 }, required: creation },
    { name: 'start', title: 'Starts', schema: TIME, required: creation },
    { name: 'end', title: 'Ends', schema: TIME, required: creation },
    { name: 'allDay', title: 'All day', schema: { type: 'boolean' }, required: false },
    { name: 'timeZone', title: 'Time zone', schema: TIME_ZONE, required: false },
    { name: 'description', title: 'Description', schema: { type: 'string' }, required: false },
    { name: 'place', title: 'Place', schema: { type: 'string' }, required: false },
    { name: 'busy', title: 'Shows as busy', schema: { type: 'boolean' }, required: false },
    {
      name: 'rule',
      title: 'Repeats',
      schema: { type: 'string', minLength: 1 },
      required: false,
      capability: 'recurrence',
    },
    ATTENDEES_ARG,
    {
      name: 'notify',
      title: 'Send invitations',
      schema: { type: 'boolean' },
      required: false,
      capability: 'attendees',
    },
    { name: 'meeting', title: 'Online meeting', schema: { type: 'boolean' }, required: false, capability: 'meeting' },
  ]
}

const EVENT_RESULT = object(['event'], { event: EVENT_SCHEMA })

export const CALENDAR_TOOLS: ToolDefinition[] = [
  // §3 Core operations
  {
    name: 'calendar_calendars',
    title: 'List calendars',
    description: 'List the calendars you can use. Give a text to keep those whose title holds it.',
    capability: null,
    effect: 'read',
    untrusted: 'names',
    arguments: [
      {
        name: 'query',
        title: 'Title holds',
        schema: { type: 'string', minLength: 1, maxLength: 200 },
        required: false,
      },
      ...pageArguments(),
    ],
    result: object(['calendars'], {
      calendars: { type: 'array', items: CALENDAR_SCHEMA },
      nextCursor: NEXT_CURSOR_SCHEMA,
    }),
    itemMembers: [],
    errors: [],
    pages: true,
    located: false,
  },
  {
    name: 'calendar_list_events',
    title: 'List events',
    description:
      'List the events of a calendar between two times, each occurrence of a repeating event on its own. Give a text to keep the events whose title, description or place holds it.',
    capability: null,
    effect: 'read',
    untrusted: 'names and content',
    arguments: [
      CALENDAR_ARG,
      { name: 'from', title: 'From', schema: DATE_TIME, required: true },
      { name: 'to', title: 'To', schema: DATE_TIME, required: true },
      { name: 'query', title: 'Text', schema: { type: 'string', minLength: 1, maxLength: 200 }, required: false },
      ...pageArguments(),
    ],
    result: object(['events'], { events: { type: 'array', items: EVENT_SCHEMA }, nextCursor: NEXT_CURSOR_SCHEMA }),
    itemMembers: ['events'],
    errors: ['invalid-argument'],
    pages: true,
    located: true,
  },
  {
    name: 'calendar_get_event',
    title: 'Look at an event',
    description:
      "Look at one event. Given a repeating event's own reference, it answers the series once, with its rule.",
    capability: null,
    effect: 'read',
    untrusted: 'names and content',
    arguments: [CALENDAR_ARG, EVENT_REF],
    result: EVENT_RESULT,
    itemMembers: ['event'],
    errors: ['not-found'],
    pages: false,
    located: true,
  },
  {
    name: 'calendar_create_event',
    title: 'Add an event',
    description: 'Add an event to a calendar. Give a time zone for an event that repeats.',
    capability: null,
    effect: 'write',
    externalWhen: { addresses: true },
    untrusted: 'names',
    arguments: [CALENDAR_ARG, ...eventMembers(true)],
    result: EVENT_RESULT,
    itemMembers: ['event'],
    errors: ['invalid-argument', 'not-supported', 'permission-denied'],
    pages: false,
    located: true,
  },
  {
    name: 'calendar_update_event',
    title: 'Change an event',
    description:
      'Change an event you organize. Only the members you give change; an empty description or place removes it. Give the version you read to change nothing if the event changed since.',
    capability: null,
    effect: 'write',
    externalWhen: { addresses: true },
    untrusted: 'names',
    arguments: [CALENDAR_ARG, EVENT_REF, IF_VERSION, ...eventMembers(false), SCOPE],
    constraints: [{ kind: 'together', arguments: ['start', 'end'] }],
    result: EVENT_RESULT,
    itemMembers: ['event'],
    errors: ['permission-denied', 'not-supported', 'version-mismatch', 'not-found', 'invalid-argument'],
    pages: false,
    located: true,
  },
  {
    name: 'calendar_cancel_event',
    title: 'Cancel an event',
    description:
      'Cancel an event you organize. Those invited are told where the calendar sends invitations. A cancelled event cannot be brought back.',
    capability: null,
    effect: 'delete',
    untrusted: 'no',
    arguments: [
      CALENDAR_ARG,
      EVENT_REF,
      IF_VERSION,
      {
        name: 'notify',
        title: 'Tell those invited',
        schema: { type: 'boolean' },
        required: false,
        capability: 'attendees',
      },
      {
        name: 'comment',
        title: 'Message',
        schema: { type: 'string', maxLength: 1000 },
        required: false,
        capability: 'attendees',
      },
      SCOPE,
    ],
    result: object(['cancelled', 'ref'], { cancelled: { const: true }, ref: REF_SCHEMA }),
    itemMembers: [],
    errors: ['permission-denied', 'not-supported', 'version-mismatch', 'not-found'],
    pages: false,
    located: true,
  },
  // §4.1 free-busy
  {
    name: 'calendar_free_busy',
    title: 'See when people are busy',
    description: 'See when a calendar, and other people, are busy between two times, without anything of their events.',
    capability: 'free-busy',
    effect: 'read',
    untrusted: 'no',
    arguments: [
      CALENDAR_ARG,
      { name: 'from', title: 'From', schema: DATE_TIME, required: true },
      { name: 'to', title: 'To', schema: DATE_TIME, required: true },
      {
        name: 'people',
        title: 'People',
        schema: { type: 'array', minItems: 1, maxItems: 20, items: EMAIL },
        required: false,
      },
    ],
    result: object(['calendar'], {
      calendar: object(['busy'], { busy: BUSY_TIMES }),
      people: {
        type: 'array',
        items: object(['address', 'known', 'busy'], {
          address: { type: 'string', minLength: 1 },
          known: { type: 'boolean' },
          busy: BUSY_TIMES,
        }),
      },
    }),
    itemMembers: [],
    errors: ['invalid-argument'],
    pages: false,
    located: true,
  },
  // §4.4 respond
  {
    name: 'calendar_respond',
    title: 'Answer an invitation',
    description: 'Answer an invitation to an event you are invited to: accept, maybe, or decline.',
    capability: 'respond',
    effect: 'write',
    untrusted: 'names and content',
    arguments: [
      CALENDAR_ARG,
      EVENT_REF,
      { name: 'response', title: 'Answer', schema: { enum: ['accepted', 'tentative', 'declined'] }, required: true },
      { name: 'comment', title: 'Message', schema: { type: 'string', maxLength: 1000 }, required: false },
      { name: 'notify', title: 'Tell the organizer', schema: { type: 'boolean' }, required: false },
      SCOPE,
    ],
    result: EVENT_RESULT,
    itemMembers: ['event'],
    errors: ['not-supported'],
    pages: false,
    located: true,
  },
]

export const CALENDAR_PROFILE: ProfileDefinition = {
  id: CALENDAR_ID,
  version: CALENDAR_VERSION,
  prefix: CALENDAR_PREFIX,
  title: 'Calendar',
  location: {
    argument: 'calendar',
    labels: { one: 'Calendar', list: 'Calendars', any: 'Any calendar you can reach' },
    listTool: 'calendar_calendars',
  },
  capabilities: [
    { name: 'free-busy', tools: ['calendar_free_busy'], adds: '', requires: [] },
    {
      name: 'recurrence',
      tools: [],
      adds: '`rule` on a creation and a change; `scope` on a change, a cancellation and an answer',
      requires: [],
    },
    {
      name: 'attendees',
      tools: [],
      adds: '`attendees` and `notify` on a creation and a change; `notify` and `comment` on a cancellation',
      requires: [],
    },
    { name: 'respond', tools: ['calendar_respond'], adds: '', requires: [] },
    { name: 'meeting', tools: [], adds: '`meeting` on a creation and a change', requires: [] },
  ],
  tools: CALENDAR_TOOLS,
  errors: [],
  declarationMembers: {
    meeting: { type: 'object', required: ['label'], properties: { label: { type: 'string', minLength: 1 } } },
  },
}

export const CALENDAR_ERROR_SCHEMA: JsonSchema = errorContentSchema(COMMON_ERRORS)
