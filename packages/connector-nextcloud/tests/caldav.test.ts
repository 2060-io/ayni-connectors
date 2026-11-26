/**
 * Calendar over CalDAV (providers §4): the account's calendars found from an address (FEAT-CALDAV-002), occurrences
 * worked out by the connector (003), a change that keeps what it does not change, raises SEQUENCE and is written with
 * If-Match (004), a creation with a new UID, DTSTAMP and its VTIMEZONE (005), invitations only where the server
 * schedules, sent by it (006), calendars not portable (007); and what B receives of invitations and answers, and
 * nothing for `notify: false`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseICalendar, textOf } from '../src/ical.js'
import { connect, type Json, type TestClient } from './client.js'
import { headersOf, type Started, startRun } from './setup.js'

const PARIS = 'Europe/Paris'

describe('a Nextcloud with scheduling', () => {
  let s: Started
  let a: TestClient
  let b: TestClient
  const first = '/remote.php/dav/calendars/ana/personal/'
  const bCal = '/remote.php/dav/calendars/jonas/personal/'
  beforeAll(async () => {
    s = await startRun()
    s.stub.store.calendar('ana', 'tasks', 'Tasks').components = ['VTODO']
    a = await connect(s.connector.url, headersOf(s, 'ana'))
    b = await connect(s.connector.url, headersOf(s, 'jonas'))
  })
  afterAll(async () => {
    await a.close()
    await b.close()
    await s.close()
  })

  const lastPut = () => {
    const put = [...s.stub.requests]
      .reverse()
      .find((r) => r.method === 'PUT' && r.path.startsWith('/remote.php/dav/calendars/'))
    if (!put) throw new Error('no PUT')
    return put
  }

  it('FEAT-CALDAV-002: lists the calendars that take events, not the task list, the inbox, the trash or contacts', async () => {
    const cals = (await a.ok('calendar_calendars', {})).calendars as { ref: string; title: string; primary?: true }[]
    expect(cals.map((c) => c.title)).toEqual(['Personal'])
    expect(cals[0]?.primary).toBe(true)
    expect(cals[0]?.ref).toBe(first)
  })

  it('FEAT-CALDAV-005: a creation writes one VEVENT with a new UID, DTSTAMP and the zone it names, If-None-Match', async () => {
    const e = (
      await a.ok('calendar_create_event', {
        calendar: first,
        title: 'Planning',
        start: '2027-01-11T10:00:00+01:00',
        end: '2027-01-11T11:00:00+01:00',
        timeZone: PARIS,
      })
    ).event as Json
    expect(e).toMatchObject({ start: '2027-01-11T10:00:00+01:00', end: '2027-01-11T11:00:00+01:00', timeZone: PARIS })
    const put = lastPut()
    expect(put.ifNoneMatch).toBe('*')
    const vcal = parseICalendar(put.body)
    const events = vcal.components.filter((c) => c.name === 'VEVENT')
    expect(events).toHaveLength(1)
    expect(textOf(events[0] as never, 'UID')).toMatch(/^[0-9a-f-]{36}$/)
    expect(textOf(events[0] as never, 'DTSTAMP')).toMatch(/^\d{8}T\d{6}Z$/)
    const vtz = vcal.components.find((c) => c.name === 'VTIMEZONE')
    expect(vtz && textOf(vtz, 'TZID')).toBe(PARIS)
    expect(vtz?.components.map((c) => c.name).sort()).toEqual(['DAYLIGHT', 'STANDARD'])
    expect(put.path).toBe(`${first}${textOf(events[0] as never, 'UID')}.ics`)
  })

  it('FEAT-CALDAV-004: a change keeps an alarm and an X- property, raises SEQUENCE for a time, and is written with If-Match', async () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Other client//EN',
      'X-WR-CALNAME:kept',
      'BEGIN:VEVENT',
      'UID:kept-1',
      'DTSTAMP:20261101T000000Z',
      'DTSTART:20270201T090000Z',
      'DTEND:20270201T100000Z',
      'SUMMARY:With an alarm',
      'SEQUENCE:3',
      'X-OTHER-CLIENT;X-PARAM=1:something of its own',
      'CATEGORIES:Work,Ayni',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'DESCRIPTION:Soon',
      'TRIGGER:-PT15M',
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n')
    const cal = s.stub.store.calendarOf('ana', 'personal')
    cal?.objects.set('kept-1.ics', { ...s.stub.store.object(ics), name: 'kept-1.ics' })
    const ref = `${first}kept-1.ics`
    const before = (await a.ok('calendar_get_event', { calendar: first, ref })).event as Json
    await a.ok('calendar_update_event', { calendar: first, ref, title: 'Renamed', ifVersion: before.version })
    let put = lastPut()
    expect(put.ifMatch).toBe(before.version)
    let ev = parseICalendar(put.body).components.find((c) => c.name === 'VEVENT')
    expect(ev?.components.map((c) => c.name)).toEqual(['VALARM'])
    expect(put.body).toContain('X-OTHER-CLIENT;X-PARAM=1:something of its own')
    expect(put.body).toContain('CATEGORIES:Work,Ayni')
    expect(put.body).toContain('X-WR-CALNAME:kept')
    expect(textOf(ev as never, 'SEQUENCE')).toBe('3')
    await a.ok('calendar_update_event', {
      calendar: first,
      ref,
      start: '2027-02-01T09:30:00Z',
      end: '2027-02-01T10:30:00Z',
    })
    put = lastPut()
    ev = parseICalendar(put.body).components.find((c) => c.name === 'VEVENT')
    expect(textOf(ev as never, 'SEQUENCE')).toBe('4')
    const stale = await a.err('calendar_update_event', { calendar: first, ref, title: 'x', ifVersion: before.version })
    expect(stale.code).toBe('version-mismatch')
  })

  it('FEAT-CALDAV-003: works out a weekly series with one moved and one removed occurrence itself', async () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Other client//EN',
      'BEGIN:VEVENT',
      'UID:weekly-1',
      'DTSTAMP:20261101T000000Z',
      'DTSTART;TZID=Europe/Paris:20270301T100000',
      'DTEND;TZID=Europe/Paris:20270301T110000',
      'RRULE:FREQ=WEEKLY;COUNT=5',
      'EXDATE;TZID=Europe/Paris:20270315T100000',
      'SUMMARY:Weekly',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:weekly-1',
      'DTSTAMP:20261101T000000Z',
      'RECURRENCE-ID;TZID=Europe/Paris:20270322T100000',
      'DTSTART;TZID=Europe/Paris:20270323T140000',
      'DTEND;TZID=Europe/Paris:20270323T150000',
      'SUMMARY:Weekly, moved',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n')
    const cal = s.stub.store.calendarOf('ana', 'personal')
    cal?.objects.set('weekly-1.ics', { ...s.stub.store.object(ics), name: 'weekly-1.ics' })
    const events = (
      await a.ok('calendar_list_events', {
        calendar: first,
        from: '2027-02-28T00:00:00Z',
        to: '2027-04-05T00:00:00Z',
        query: 'weekly',
      })
    ).events as Json[]
    expect(events.map((e) => e.start)).toEqual([
      '2027-03-01T10:00:00+01:00',
      '2027-03-08T10:00:00+01:00',
      '2027-03-23T14:00:00+01:00',
      // across the change of offset of the last Sunday of March, the wall clock stays (FEAT-CAL-032)
      '2027-03-29T10:00:00+02:00',
    ])
    expect(new Set(events.map((e) => e.series))).toEqual(new Set([`${first}weekly-1.ics`]))
    expect(events[2]?.ref).toBe(`${first}weekly-1.ics#20270322T090000Z`)
    expect(events[2]?.title).toBe('Weekly, moved')
    // the stub was never asked to expand
    expect(s.stub.requests.filter((r) => r.method === 'REPORT').every((r) => !r.body.includes('expand'))).toBe(true)
  })

  it('FEAT-CALDAV-006: the server sends the invitation; notify false sends nothing (SCHEDULE-AGENT=NONE)', async () => {
    const before = s.stub.messagesTo('jonas@example.org').length
    const sent = (
      await a.ok('calendar_create_event', {
        calendar: first,
        title: 'Budget review',
        start: '2027-01-20T09:00:00Z',
        end: '2027-01-20T10:00:00Z',
        attendees: [{ address: 'jonas@example.org', name: 'Jonas Example' }],
      })
    ).event as Json
    const got = s.stub.messagesTo('jonas@example.org').slice(before)
    expect(got.map((m) => m.subject)).toEqual(['Invitation: Budget review'])
    expect(sent.organizer).toEqual({ address: 'ana@example.org', name: 'Ana Example' })
    expect(sent.attendees).toEqual([{ address: 'jonas@example.org', name: 'Jonas Example', response: 'needs-action' }])
    const inB = (
      await b.ok('calendar_list_events', { calendar: bCal, from: '2027-01-20T00:00:00Z', to: '2027-01-21T00:00:00Z' })
    ).events as Json[]
    expect(inB.map((e) => [e.title, e.mine])).toEqual([['Budget review', false]])

    const quiet = s.stub.messagesTo('jonas@example.org').length
    await a.ok('calendar_create_event', {
      calendar: first,
      title: 'Quiet',
      start: '2027-01-21T09:00:00Z',
      end: '2027-01-21T10:00:00Z',
      attendees: [{ address: 'jonas@example.org' }],
      notify: false,
    })
    expect(lastPut().body).toContain('SCHEDULE-AGENT=NONE')
    expect(s.stub.messagesTo('jonas@example.org').length).toBe(quiet)
  })

  it('answers an invitation: the organizer is told, but not with notify false (Schedule-Reply: F); a comment is refused', async () => {
    const inv = (
      await b.ok('calendar_create_event', {
        calendar: bCal,
        title: 'From Jonas',
        start: '2027-01-25T09:00:00Z',
        end: '2027-01-25T10:00:00Z',
        attendees: [{ address: 'ana@example.org' }],
      })
    ).event as Json
    const inA = (
      (
        await a.ok('calendar_list_events', {
          calendar: first,
          from: '2027-01-25T00:00:00Z',
          to: '2027-01-26T00:00:00Z',
        })
      ).events as Json[]
    ).find((e) => e.title === 'From Jonas') as Json
    expect(inA.uid).toBe(inv.uid)
    expect((inA.attendees as Json[]).find((x) => x.self)).toMatchObject({ address: 'ana@example.org', self: true })
    const before = s.stub.messagesTo('jonas@example.org').length
    const answered = (await a.ok('calendar_respond', { calendar: first, ref: inA.ref, response: 'tentative' }))
      .event as Json
    expect((answered.attendees as Json[]).find((x) => x.self)?.response).toBe('tentative')
    expect(
      s.stub
        .messagesTo('jonas@example.org')
        .slice(before)
        .map((m) => m.subject)
    ).toEqual(['Reply from Ana Example: From Jonas'])
    const ofB = (await b.ok('calendar_get_event', { calendar: bCal, ref: inv.ref })).event as Json
    expect((ofB.attendees as Json[])[0]?.response).toBe('tentative')

    const quiet = s.stub.messagesTo('jonas@example.org').length
    await a.ok('calendar_respond', { calendar: first, ref: inA.ref, response: 'declined', notify: false })
    expect(lastPut().scheduleReply).toBe('F')
    expect(s.stub.messagesTo('jonas@example.org').length).toBe(quiet)
    const e = await a.err('calendar_respond', { calendar: first, ref: inA.ref, response: 'accepted', comment: 'Late' })
    expect([e.code, e.field]).toEqual(['not-supported', 'comment'])
    expect((await a.err('calendar_update_event', { calendar: first, ref: inA.ref, title: 'Mine now' })).code).toBe(
      'permission-denied'
    )
  })

  it('refuses a comment on a cancellation, which CalDAV carries to nobody; tells B of the cancellation', async () => {
    const e = (
      await a.ok('calendar_create_event', {
        calendar: first,
        title: 'To cancel',
        start: '2027-01-26T09:00:00Z',
        end: '2027-01-26T10:00:00Z',
        attendees: [{ address: 'jonas@example.org' }],
      })
    ).event as Json
    const refused = await a.err('calendar_cancel_event', { calendar: first, ref: e.ref, comment: 'Moved' })
    expect([refused.code, refused.field]).toEqual(['not-supported', 'comment'])
    const before = s.stub.messagesTo('jonas@example.org').length
    expect(await a.ok('calendar_cancel_event', { calendar: first, ref: e.ref })).toEqual({
      cancelled: true,
      ref: e.ref,
    })
    expect(
      s.stub
        .messagesTo('jonas@example.org')
        .slice(before)
        .map((m) => m.subject)
    ).toEqual(['Cancelled: To cancel'])
  })

  it('free-busy: the calendar merged, and the people of the server through the outbox, known or not', async () => {
    await b.ok('calendar_create_event', {
      calendar: bCal,
      title: 'Busy Jonas',
      start: '2027-03-02T09:00:00Z',
      end: '2027-03-02T10:00:00Z',
    })
    const out = (await a.ok('calendar_free_busy', {
      calendar: first,
      from: '2027-03-02T00:00:00Z',
      to: '2027-03-03T00:00:00Z',
      people: ['jonas@example.org', 'nobody@example.org'],
    })) as Json
    expect(out.people).toEqual([
      {
        address: 'jonas@example.org',
        known: true,
        busy: [{ start: '2027-03-02T09:00:00Z', end: '2027-03-02T10:00:00Z' }],
      },
      { address: 'nobody@example.org', known: false, busy: [] },
    ])
    expect(JSON.stringify(out)).not.toContain('Busy Jonas')
  })

  it('FEAT-CALDAV-007: every calendar is not portable', async () => {
    const cals = (await b.ok('calendar_calendars', {})).calendars as { portable: boolean }[]
    expect(cals.length).toBeGreaterThan(0)
    expect(cals.every((c) => c.portable === false)).toBe(true)
  })
})

describe('a plain CalDAV server without scheduling', () => {
  let s: Started
  let a: TestClient
  beforeAll(async () => {
    s = await startRun({ nextcloud: false, scheduling: false, noTimezone: true })
    a = await connect(s.connector.url, headersOf(s, 'ana'))
  })
  afterAll(async () => {
    await a.close()
    await s.close()
  })

  it('FEAT-CALDAV-001, 006: declares recurrence and free-busy, never attendees, respond or meeting', async () => {
    const d = (await a.declared())['org.ayni/calendar'] as Json
    expect(d.capabilities).toEqual(['free-busy', 'recurrence'])
    expect(d.atomicWrites).toBe(true)
    const e = await a.err('calendar_create_event', {
      calendar: '/dav/calendars/ana/personal/',
      title: 'x',
      start: '2027-01-04T10:00:00Z',
      end: '2027-01-04T11:00:00Z',
      attendees: [{ address: 'jonas@example.org' }],
    })
    expect([e.code, e.field]).toEqual(['not-supported', 'attendees'])
  })

  it('FEAT-CALDAV-002, 005: found from the server root, and no VTIMEZONE for a server of calendar-no-timezone', async () => {
    const root = await connect(s.connector.url, headersOf(s, 'ana', `${s.stub.origin()}/`))
    const cals = (await root.ok('calendar_calendars', {})).calendars as { ref: string }[]
    expect(cals.map((c) => c.ref)).toEqual(['/dav/calendars/ana/personal/'])
    expect(s.stub.requests.some((r) => r.path === '/.well-known/caldav')).toBe(true)
    await root.ok('calendar_create_event', {
      calendar: '/dav/calendars/ana/personal/',
      title: 'Zoned',
      start: '2027-01-04T10:00:00+01:00',
      end: '2027-01-04T11:00:00+01:00',
      timeZone: PARIS,
    })
    const put = [...s.stub.requests].reverse().find((r) => r.method === 'PUT')
    expect(put?.body).toContain('DTSTART;TZID=Europe/Paris:20270104T100000')
    expect(put?.body).not.toContain('BEGIN:VTIMEZONE')
    await root.close()
  })

  it('answers known: false for people, the server having no scheduling to ask', async () => {
    const out = (await a.ok('calendar_free_busy', {
      calendar: '/dav/calendars/ana/personal/',
      from: '2027-03-02T00:00:00Z',
      to: '2027-03-03T00:00:00Z',
      people: ['jonas@example.org'],
    })) as Json
    expect(out.people).toEqual([{ address: 'jonas@example.org', known: false, busy: [] }])
  })
})
