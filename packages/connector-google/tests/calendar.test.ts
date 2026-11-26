/**
 * Calendar over the stub of Google Calendar, beyond what the conformance kit reaches: each tool with no more than the
 * scope of the agent's table (architecture §10.10), what Google sends and when (`sendUpdates`), the refusal of a
 * cancellation's comment, a series moved through one of its occurrences, a description kept as HTML.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connect, type Json, type TestClient } from './client.js'
import { type Started, startRun } from './setup.js'
import { SCOPE } from './stub/index.js'

let s: Started
let a: TestClient
let b: TestClient
const A = 'avery@example.org'
const B = 'blake@example.org'

beforeAll(async () => {
  s = await startRun()
  a = await connect(s.connector.url, s.tokens.A)
  b = await connect(s.connector.url, s.tokens.B)
})
afterAll(async () => {
  await a.close()
  await b.close()
  await s.close()
})

const event = (o: Json) => o.event as Json & { ref: string; version: string }

describe('scopes of the agent’s table', () => {
  it('runs each tool with the one scope the table gives it, and refuses without it', async () => {
    const only = async (scope: string) => connect(s.connector.url, s.stub.token('avery', [SCOPE(scope)]))
    const list = await only('calendar.calendarlist.readonly')
    await list.ok('calendar_calendars', {})
    expect(
      (
        await list.err('calendar_list_events', {
          calendar: A,
          from: '2027-01-01T00:00:00Z',
          to: '2027-01-02T00:00:00Z',
        })
      ).code
    ).toBe('permission-denied')
    const write = await only('calendar.events')
    const made = event(
      await write.ok('calendar_create_event', {
        calendar: A,
        title: 'Scoped',
        start: '2027-04-01T10:00:00Z',
        end: '2027-04-01T11:00:00Z',
      })
    )
    await write.ok('calendar_update_event', { calendar: A, ref: made.ref, title: 'Scoped 2' })
    // the calendar list is not among what calendar.events reaches: creating an event never reads it
    expect((await write.err('calendar_calendars', {})).code).toBe('permission-denied')
    const read = await only('calendar.events.readonly')
    await read.ok('calendar_list_events', { calendar: A, from: '2027-04-01T00:00:00Z', to: '2027-04-02T00:00:00Z' })
    await read.ok('calendar_get_event', { calendar: A, ref: made.ref })
    expect((await read.err('calendar_cancel_event', { calendar: A, ref: made.ref })).code).toBe('permission-denied')
    const busy = await only('calendar.events.freebusy')
    const fb = await busy.ok('calendar_free_busy', {
      calendar: A,
      from: '2027-04-01T00:00:00Z',
      to: '2027-04-02T00:00:00Z',
      people: [B],
    })
    expect((fb.calendar as { busy: unknown[] }).busy).toEqual([
      { start: '2027-04-01T10:00:00Z', end: '2027-04-01T11:00:00Z' },
    ])
    expect((fb.people as { known: boolean }[])[0]?.known).toBe(true)
    expect((await busy.err('calendar_get_event', { calendar: A, ref: made.ref })).code).toBe('permission-denied')
    await write.ok('calendar_cancel_event', { calendar: A, ref: made.ref })
    // an answer to an invitation, with calendar.events
    const inv = event(
      await b.ok('calendar_create_event', {
        calendar: B,
        title: 'Scoped invitation',
        start: '2027-04-02T10:00:00Z',
        end: '2027-04-02T11:00:00Z',
        attendees: [{ address: A }],
        notify: false,
      })
    )
    await write.ok('calendar_respond', { calendar: A, ref: inv.ref, response: 'accepted', notify: false })
    for (const c of [list, write, read, busy]) await c.close()
  })
})

describe('what Google sends', () => {
  it('invites, tells of a change and of a cancellation with notify, and sends nothing without', async () => {
    const before = s.stub.messagesTo(B).length
    const loud = event(
      await a.ok('calendar_create_event', {
        calendar: A,
        title: 'Loud meeting',
        description: 'Agenda',
        start: '2027-05-03T10:00:00Z',
        end: '2027-05-03T11:00:00Z',
        attendees: [{ address: B }],
      })
    )
    const quiet = event(
      await a.ok('calendar_create_event', {
        calendar: A,
        title: 'Quiet meeting',
        start: '2027-05-03T12:00:00Z',
        end: '2027-05-03T13:00:00Z',
        attendees: [{ address: B }],
        notify: false,
      })
    )
    await a.ok('calendar_update_event', { calendar: A, ref: quiet.ref, title: 'Quiet meeting moved', notify: false })
    await a.ok('calendar_update_event', { calendar: A, ref: loud.ref, place: 'Room 3' })
    await a.ok('calendar_cancel_event', { calendar: A, ref: loud.ref })
    const got = s.stub.messagesTo(B).slice(before)
    expect(got.map((m) => [m.kind, m.subject])).toEqual([
      ['invitation', 'Invitation: Loud meeting'],
      ['update', 'Updated invitation: Loud meeting'],
      ['cancellation', 'Canceled event: Loud meeting'],
    ])
    // the invitation reached B's calendar, which B reads as an event B does not organize
    const inB = (await b.ok('calendar_get_event', { calendar: B, ref: quiet.ref })).event as Json
    expect([inB.mine, (inB.organizer as Json).address]).toEqual([false, A])
  })

  it('refuses a cancellation’s comment, which Google cannot send, and cancels nothing', async () => {
    const e = event(
      await a.ok('calendar_create_event', {
        calendar: A,
        title: 'Kept',
        start: '2027-05-04T10:00:00Z',
        end: '2027-05-04T11:00:00Z',
        attendees: [{ address: B }],
        notify: false,
      })
    )
    const refused = await a.err('calendar_cancel_event', { calendar: A, ref: e.ref, comment: 'Moved to next week' })
    expect(refused).toMatchObject({ code: 'not-supported', field: 'comment' })
    expect(event(await a.ok('calendar_get_event', { calendar: A, ref: e.ref })).status).toBe('confirmed')
    await a.ok('calendar_cancel_event', { calendar: A, ref: e.ref, notify: false })
  })

  it('tells the organizer of an answer, with its comment, only with notify', async () => {
    const inv = event(
      await b.ok('calendar_create_event', {
        calendar: B,
        title: 'Answer me',
        start: '2027-05-05T10:00:00Z',
        end: '2027-05-05T11:00:00Z',
        attendees: [{ address: A }],
        notify: false,
      })
    )
    const before = s.stub.messagesTo(B).length
    await a.ok('calendar_respond', { calendar: A, ref: inv.ref, response: 'tentative', notify: false })
    expect(s.stub.messagesTo(B).length).toBe(before)
    const out = event(
      await a.ok('calendar_respond', { calendar: A, ref: inv.ref, response: 'declined', comment: 'Away' })
    )
    expect((out.attendees as Json[]).find((x) => x.self === true)?.response).toBe('declined')
    expect(s.stub.messagesTo(B).slice(before)).toEqual([expect.objectContaining({ kind: 'reply', text: 'Away' })])
    // the organizer reads the answer on their own copy
    const mine = event(await b.ok('calendar_get_event', { calendar: B, ref: inv.ref }))
    expect((mine.attendees as Json[]).find((x) => x.address === A)?.response).toBe('declined')
  })
})

describe('series and times', () => {
  it('moves a series through one of its occurrences, every occurrence by as much', async () => {
    const series = event(
      await a.ok('calendar_create_event', {
        calendar: A,
        title: 'Weekly shift',
        start: '2027-06-07T10:00:00+02:00',
        end: '2027-06-07T11:00:00+02:00',
        timeZone: 'Europe/Paris',
        rule: 'FREQ=WEEKLY;COUNT=3',
      })
    )
    const span = { calendar: A, from: '2027-06-06T00:00:00Z', to: '2027-06-30T00:00:00Z', query: 'Weekly shift' }
    const before = (await a.ok('calendar_list_events', span)).events as Json[]
    expect(before.map((x) => x.start)).toEqual([
      '2027-06-07T10:00:00+02:00',
      '2027-06-14T10:00:00+02:00',
      '2027-06-21T10:00:00+02:00',
    ])
    const second = before[1] as Json
    await a.ok('calendar_update_event', {
      calendar: A,
      ref: second.ref,
      start: '2027-06-14T12:00:00+02:00',
      end: '2027-06-14T13:00:00+02:00',
      scope: 'series',
    })
    const after = (await a.ok('calendar_list_events', span)).events as Json[]
    expect(after.map((x) => x.start)).toEqual([
      '2027-06-07T12:00:00+02:00',
      '2027-06-14T12:00:00+02:00',
      '2027-06-21T12:00:00+02:00',
    ])
    expect(after.every((x) => x.series === series.ref)).toBe(true)
  })

  it('reads a description Google keeps as HTML as its text, and an event of another calendar as not-found', async () => {
    const made = event(
      await a.ok('calendar_create_event', {
        calendar: A,
        title: 'Marked up',
        start: '2027-06-08T10:00:00Z',
        end: '2027-06-08T11:00:00Z',
      })
    )
    const stored = s.stub.calendar.events.get(made.ref)
    if (stored) stored.description = '<p>Line one</p><p>Line <b>two</b> &amp; more</p>'
    const got = event(await a.ok('calendar_get_event', { calendar: A, ref: made.ref }))
    expect(got.description).toBe('Line one\nLine two & more')
    expect((await b.err('calendar_get_event', { calendar: A, ref: made.ref })).code).toBe('not-found')
  })

  it('asks Google Meet for a link, and removes it', async () => {
    const made = event(
      await a.ok('calendar_create_event', {
        calendar: A,
        title: 'Call',
        start: '2027-06-09T10:00:00Z',
        end: '2027-06-09T11:00:00Z',
        meeting: true,
      })
    )
    expect(made.meeting).toEqual({ url: expect.stringMatching(/^https:\/\/meet\.google\.com\//), label: 'Google Meet' })
    const removed = event(await a.ok('calendar_update_event', { calendar: A, ref: made.ref, meeting: false }))
    expect(removed.meeting).toBeUndefined()
    const again = event(await a.ok('calendar_update_event', { calendar: A, ref: made.ref, meeting: true }))
    expect(typeof (again.meeting as Json | undefined)?.url).toBe('string')
  })
})
