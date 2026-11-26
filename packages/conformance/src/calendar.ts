/**
 * The tests of Calendar 1.0 (calendar §7): the core (FEAT-CAL-001 to 017) and each capability's group. Every event
 * the run makes is cancelled at the end. The events of a run carry its token in their titles, and every listing is
 * narrowed by it, so that the first calendar may hold events of other runs.
 */
import { CALENDAR_PROFILE } from '@ayni.org/ayni-feature-profiles'
import type { CoreState, Declared, ProfileRun } from './core.js'
import type { RunState, Test, TestContext } from './harness.js'
import type { Json, Session } from './session.js'
import type { CalendarConformance } from './types.js'

export interface CalendarState extends CoreState {
  calendar: CalendarConformance
  /** every event the run made, to cancel at the end */
  events: { session: Session; calendar: string; ref: string }[]
}

const has = (s: CalendarState, c: string) => s.run.declaration.capabilities.includes(c)
const PARIS = 'Europe/Paris'

function _requires(t: TestContext, s: CalendarState, ...caps: string[]) {
  for (const c of caps) if (!has(s, c)) t.skip(`needs the capability ${c}, which the server does not declare`)
}

async function add(
  t: TestContext,
  s: CalendarState,
  fields: Json,
  session: Session = s.A,
  calendar = s.run.first
): Promise<Json> {
  const out = t.success(
    await session.call('calendar_create_event', { calendar, ...fields }),
    `calendar_create_event ${String(fields.title)}`
  )
  const event = out.event as Json
  s.events.push({ session, calendar, ref: String(event.ref) })
  return event
}

async function list(
  t: TestContext,
  session: Session,
  calendar: string,
  from: string,
  to: string,
  query?: string
): Promise<Json[]> {
  const out: Json[] = []
  let cursor: string | undefined
  do {
    const page = t.success(
      await session.call('calendar_list_events', {
        calendar,
        from,
        to,
        ...(query ? { query } : {}),
        ...(cursor ? { cursor } : {}),
      }),
      'calendar_list_events'
    )
    out.push(...((page.events as Json[]) ?? []))
    cursor = page.nextCursor as string | undefined
  } while (cursor && out.length < 10000)
  return out
}

const get = async (t: TestContext, s: CalendarState, ref: string, session = s.A, calendar = s.run.first) =>
  (t.success(await session.call('calendar_get_event', { calendar, ref }), 'calendar_get_event').event ?? {}) as Json

/** B's calendar: given, or B's main one. */
async function bCalendar(t: TestContext, s: CalendarState): Promise<string> {
  if (s.calendar.bCalendar) return s.calendar.bCalendar
  const out = t.success(await s.B.call('calendar_calendars', {}), "B's calendars")
  const primary = ((out.calendars as Json[]) ?? []).find((c) => c.primary === true)
  if (!primary) t.skip("B's main calendar is not found: give calendar.bCalendar")
  return String(primary.ref)
}

/**
 * B's event that invites A, as A reads it in the first calendar: made by B with `attendees`, or the fixture. The
 * invitation is sent (`notify` left to its default): a CalDAV server delivers it to A's calendar only by scheduling it
 * (RFC 6638), and `notify: false` asks it to schedule nothing (providers §4); A's messages are not counted.
 */
async function invitation(
  t: TestContext,
  s: CalendarState,
  label: string,
  more: Json = {}
): Promise<{ inA: Json; ofB?: Json; bCal?: string }> {
  const a = s.options.accounts.A.address
  if (has(s, 'attendees') && a) {
    const bCal = await bCalendar(t, s)
    const title = `${s.token} ${label} invitation`
    const ofB = await add(
      t,
      s,
      {
        title,
        start: '2027-01-27T09:00:00Z',
        end: '2027-01-27T10:00:00Z',
        attendees: [{ address: a }],
        ...more,
      },
      s.B,
      bCal
    )
    const found = (await list(t, s.A, s.run.first, '2027-01-01T00:00:00Z', '2027-12-31T00:00:00Z', title)).find(
      (e) => e.title === title
    )
    t.ok(found, "B's invitation does not reach A's first calendar")
    return { inA: found, ofB, bCal }
  }
  const ref = s.calendar.fixtures?.invitation
  if (!ref)
    t.skip("needs B's invitation in A's calendar: the capability attendees and A's address, or the fixture invitation")
  return { inA: await get(t, s, ref) }
}

/** A weekly series in the first calendar: made with a rule, or the fixture. */
async function weekly(
  t: TestContext,
  s: CalendarState,
  label: string,
  start: string,
  count = 4
): Promise<{ series: string; from: string; to: string }> {
  if (has(s, 'recurrence')) {
    const end = new Date(Date.parse(start) + 3_600_000).toISOString().replace('.000Z', 'Z')
    const e = await add(t, s, {
      title: `${s.token} ${label}`,
      start,
      end,
      timeZone: PARIS,
      rule: `FREQ=WEEKLY;COUNT=${count}`,
    })
    return {
      series: String(e.ref),
      from: new Date(Date.parse(start) - 86_400_000).toISOString(),
      to: new Date(Date.parse(start) + (count * 7 - 1) * 86_400_000).toISOString(),
    }
  }
  const f = s.calendar.fixtures?.weeklySeries
  if (!f) t.skip('needs a weekly series: the capability recurrence, or the fixture weeklySeries')
  return { series: f.ref, from: f.from, to: f.to }
}

/** The adapter of the common tests for Calendar. */
export function calendarRun(
  state: RunState,
  declaration: Declared,
  calendar: CalendarConformance,
  events: CalendarState['events']
): ProfileRun {
  const titles = new Map<string, string>()
  let hour = 0
  return {
    profile: CALENDAR_PROFILE,
    declaration,
    ...(calendar.expect ? { expect: calendar.expect } : {}),
    first: calendar.first.ref,
    second: calendar.second.ref,
    unknownRef: `${state.token}-no-such-event`,
    async make(s, name) {
      const at = Date.UTC(2027, 5, 7, 0, 0, 0) + hour++ * 3_600_000
      const title = `${state.token} ${name}`
      const out = await s.call('calendar_create_event', {
        calendar: calendar.first.ref,
        title,
        start: new Date(at).toISOString().replace('.000Z', 'Z'),
        end: new Date(at + 1_800_000).toISOString().replace('.000Z', 'Z'),
      })
      if (!out.ok) throw new Error(`calendar_create_event answered ${out.error.code}: ${out.error.message}`)
      const e = out.content.event as Json
      events.push({ session: s, calendar: calendar.first.ref, ref: String(e.ref) })
      titles.set(String(e.ref), title)
      return { ref: String(e.ref), version: String(e.version) }
    },
    read: (s, location, ref) => s.call('calendar_get_event', { calendar: location, ref }),
    change: (s, location, ref, ifVersion, n) =>
      s.call('calendar_update_event', { calendar: location, ref, ifVersion, title: `${state.token} change ${n}` }),
    async many(n) {
      const day = Date.UTC(2027, 6, 1 + (n % 27), 0, 0, 0)
      const query = `${state.token}-many-${n}`
      const refs: string[] = []
      for (let i = 0; i < n; i++) {
        const at = day + i * 600_000
        const out = await state.A.call('calendar_create_event', {
          calendar: calendar.first.ref,
          title: `${query} ${i}`,
          start: new Date(at).toISOString().replace('.000Z', 'Z'),
          end: new Date(at + 300_000).toISOString().replace('.000Z', 'Z'),
        })
        if (!out.ok) throw new Error(`calendar_create_event answered ${out.error.code}`)
        const ref = String((out.content.event as Json).ref)
        refs.push(ref)
        events.push({ session: state.A, calendar: calendar.first.ref, ref })
      }
      return {
        tool: 'calendar_list_events',
        args: {
          calendar: calendar.first.ref,
          from: new Date(day).toISOString(),
          to: new Date(day + 86_400_000).toISOString(),
          query,
        },
        member: 'events',
        refs,
      }
    },
    listCall: (location) => ({
      tool: 'calendar_list_events',
      args: { calendar: location, from: '2027-01-01T00:00:00Z', to: '2027-12-31T00:00:00Z', query: state.token },
      member: 'events',
    }),
    nameOf: (ref) => titles.get(ref),
  }
}

export const CALENDAR_TESTS: Test<CalendarState>[] = [
  {
    id: 'FEAT-CAL-001',
    capability: null,
    async run(t: TestContext, s) {
      const listed = new Set((await s.A.listTools()).map((x) => String(x.name)))
      for (const n of [
        'calendar_calendars',
        'calendar_list_events',
        'calendar_get_event',
        'calendar_create_event',
        'calendar_update_event',
        'calendar_cancel_event',
      ])
        t.ok(listed.has(n), `${n} is not listed`)
      t.success(await s.A.call('calendar_calendars', {}), 'calendar_calendars')
      const e = await add(t, s, { title: `${s.token} 001`, start: '2027-01-04T10:00:00Z', end: '2027-01-04T11:00:00Z' })
      await list(t, s.A, s.run.first, '2027-01-04T00:00:00Z', '2027-01-05T00:00:00Z', `${s.token} 001`)
      await get(t, s, String(e.ref))
      const changed = t.success(
        await s.A.call('calendar_update_event', { calendar: s.run.first, ref: e.ref, title: `${s.token} 001 changed` }),
        'calendar_update_event'
      )
      const done = t.success(
        await s.A.call('calendar_cancel_event', { calendar: s.run.first, ref: (changed.event as Json).ref }),
        'calendar_cancel_event'
      )
      t.equal(done.cancelled, true, 'cancelled')
    },
  },
  {
    id: 'FEAT-CAL-002',
    capability: null,
    late: true,
    async run(t: TestContext, s) {
      const tally = s.observer.result(CALENDAR_PROFILE.id, 'FEAT-CAL-002')
      t.ok(tally.violations.length === 0, tally.violations.join(' | '))
      t.ok(tally.seen > 0, 'no event was checked')
      t.note(`${tally.seen} events checked`)
    },
  },
  {
    id: 'FEAT-CAL-003',
    capability: null,
    async run(t: TestContext, s) {
      const e = await add(t, s, {
        title: `${s.token} 003`,
        start: '2027-01-04T10:00:00+01:00',
        end: '2027-01-04T11:00:00+01:00',
        timeZone: PARIS,
      })
      const r = await get(t, s, String(e.ref))
      t.equal(
        [r.start, r.end, r.timeZone],
        ['2027-01-04T10:00:00+01:00', '2027-01-04T11:00:00+01:00', PARIS],
        'a winter event of Europe/Paris'
      )
      const d = await add(t, s, { title: `${s.token} 003 day`, start: '2027-01-05', end: '2027-01-06', allDay: true })
      const rd = await get(t, s, String(d.ref))
      t.equal([rd.allDay, rd.start, rd.end], [true, '2027-01-05', '2027-01-06'], 'an all-day event of one day')
    },
  },
  {
    id: 'FEAT-CAL-004',
    capability: null,
    async run(t: TestContext, s) {
      const q = `${s.token} 004`
      await add(t, s, { title: `${q} before`, start: '2027-01-11T08:00:00Z', end: '2027-01-11T09:00:00Z' })
      const across = await add(t, s, {
        title: `${q} across`,
        start: '2027-01-11T09:30:00Z',
        end: '2027-01-11T10:30:00Z',
      })
      const also = await add(t, s, { title: `${q} also`, start: '2027-01-11T10:00:00Z', end: '2027-01-11T10:15:00Z' })
      await add(t, s, { title: `${q} after`, start: '2027-01-11T12:00:00Z', end: '2027-01-11T13:00:00Z' })
      const got = await list(t, s.A, s.run.first, '2027-01-11T10:00:00Z', '2027-01-11T12:00:00Z', q)
      t.equal(
        got.map((e) => e.ref),
        [across.ref, also.ref],
        'the events of the time asked, by start'
      )
      t.refused(
        await s.A.call('calendar_list_events', {
          calendar: s.run.first,
          from: '2027-01-01T00:00:00Z',
          to: '2028-02-05T00:00:00Z',
        }),
        'invalid-argument',
        'a span of 400 days',
        'to'
      )
      t.refused(
        await s.A.call('calendar_list_events', {
          calendar: s.run.first,
          from: '2027-01-02T00:00:00Z',
          to: '2027-01-01T00:00:00Z',
        }),
        'invalid-argument',
        'a to before from',
        'to'
      )
    },
  },
  {
    id: 'FEAT-CAL-005',
    capability: null,
    async run(t: TestContext, s) {
      const w = await weekly(t, s, '005 weekly', '2027-01-18T10:00:00+01:00')
      const occ = (await list(t, s.A, s.run.first, w.from, w.to)).filter((e) => e.series === w.series)
      t.equal(occ.length, 4, 'the occurrences of a weekly series over four weeks')
      t.equal(new Set(occ.map((e) => e.ref)).size, 4, 'the references of the occurrences')
      for (const e of occ) t.equal(e.recurring, true, 'recurring of an occurrence')
    },
  },
  {
    id: 'FEAT-CAL-006',
    capability: null,
    async run(t: TestContext, s) {
      const q = `${s.token} budget`
      const a = await add(t, s, {
        title: `${s.token} Budget review`,
        start: '2027-01-12T09:00:00Z',
        end: '2027-01-12T10:00:00Z',
      })
      const b = await add(t, s, {
        title: `${s.token} Room`,
        place: `${s.token} Budget room`,
        start: '2027-01-12T11:00:00Z',
        end: '2027-01-12T12:00:00Z',
      })
      await add(t, s, { title: `${s.token} Planning`, start: '2027-01-12T13:00:00Z', end: '2027-01-12T14:00:00Z' })
      const got = await list(t, s.A, s.run.first, '2027-01-12T00:00:00Z', '2027-01-13T00:00:00Z', q)
      t.equal(
        got.map((e) => e.ref),
        [a.ref, b.ref],
        `the events that hold "${q}", whatever the case`
      )
    },
  },
  {
    id: 'FEAT-CAL-007',
    capability: null,
    async run(t: TestContext, s) {
      const fields = {
        title: `${s.token} 007`,
        start: '2027-01-13T10:00:00+01:00',
        end: '2027-01-13T11:30:00+01:00',
        timeZone: PARIS,
        description: 'Agenda: three points.',
        place: 'Room 2',
        busy: false,
      }
      const e = await add(t, s, fields)
      const r = await get(t, s, String(e.ref))
      t.equal(
        [r.title, r.start, r.end, r.timeZone, r.description, r.place, r.busy],
        [fields.title, fields.start, fields.end, PARIS, fields.description, fields.place, false],
        'a created event read back'
      )
    },
  },
  {
    id: 'FEAT-CAL-008',
    capability: null,
    async run(t: TestContext, s) {
      const e = await add(t, s, {
        title: `${s.token} 008`,
        start: '2027-01-14T10:00:00Z',
        end: '2027-01-14T11:00:00Z',
        place: 'Room 1',
      })
      const r = (t.success(
        await s.A.call('calendar_update_event', { calendar: s.run.first, ref: e.ref, title: `${s.token} 008 renamed` }),
        'a change of the title'
      ).event ?? {}) as Json
      t.equal(
        [r.start, r.end, r.place],
        [e.start, e.end, 'Room 1'],
        'the times and the place after a change of the title'
      )
      t.refused(
        await s.A.call('calendar_update_event', { calendar: s.run.first, ref: e.ref, start: '2027-01-14T09:00:00Z' }),
        'invalid-argument',
        'a change of start alone'
      )
      t.success(
        await s.A.call('calendar_update_event', { calendar: s.run.first, ref: e.ref, place: '' }),
        'a change of the place to empty'
      )
      t.ok((await get(t, s, String(e.ref))).place === undefined, 'a place given empty is still there')
    },
  },
  {
    id: 'FEAT-CAL-009',
    capability: null,
    async run(t: TestContext, s) {
      const { inA, ofB, bCal } = await invitation(t, s, '009')
      t.refused(
        await s.A.call('calendar_update_event', { calendar: s.run.first, ref: inA.ref, title: 'changed by A' }),
        'permission-denied',
        "A's change of B's event"
      )
      t.refused(
        await s.A.call('calendar_cancel_event', { calendar: s.run.first, ref: inA.ref }),
        'permission-denied',
        "A's cancellation of B's event"
      )
      if (ofB && bCal) {
        const still = await get(t, s, String(ofB.ref), s.B, bCal)
        t.equal([still.title, still.version], [ofB.title, ofB.version], "B's event after A's attempts")
      }
    },
  },
  {
    id: 'FEAT-CAL-010',
    capability: null,
    async run(t: TestContext, s) {
      const e = await add(t, s, { title: `${s.token} 010`, start: '2027-01-15T10:00:00Z', end: '2027-01-15T11:00:00Z' })
      t.success(await s.A.call('calendar_cancel_event', { calendar: s.run.first, ref: e.ref }), 'calendar_cancel_event')
      const listed = (
        await list(t, s.A, s.run.first, '2027-01-15T00:00:00Z', '2027-01-16T00:00:00Z', `${s.token} 010`)
      ).filter((x) => x.ref === e.ref)
      t.ok(
        listed.every((x) => x.status === 'cancelled'),
        'a cancelled event is listed, not as cancelled'
      )
      const read = await s.A.call('calendar_get_event', { calendar: s.run.first, ref: e.ref })
      t.ok(
        !read.ok ? read.error.code === 'not-found' : (read.content.event as Json).status === 'cancelled',
        'a read of a cancelled event'
      )
    },
  },
  {
    id: 'FEAT-CAL-011',
    capability: null,
    async run(t: TestContext, s) {
      if (has(s, 'recurrence')) t.notApplicable('the server declares recurrence')
      t.refused(
        await s.A.call('calendar_create_event', {
          calendar: s.run.first,
          title: `${s.token} 011`,
          start: '2027-01-18T10:00:00+01:00',
          end: '2027-01-18T11:00:00+01:00',
          timeZone: PARIS,
          rule: 'FREQ=WEEKLY',
        }),
        'not-supported',
        'a creation with a rule',
        'rule'
      )
      const f = s.calendar.fixtures?.weeklySeries
      if (!f) {
        t.note('no fixture weeklySeries: the change of an occurrence is not tested')
        return
      }
      const occ = (await list(t, s.A, s.run.first, f.from, f.to)).find((e) => e.series === f.ref)
      t.ok(occ, 'no occurrence of the fixture series is listed')
      t.refused(
        await s.A.call('calendar_update_event', { calendar: s.run.first, ref: occ.ref, title: 'x' }),
        'not-supported',
        'a change of an occurrence'
      )
    },
  },
  {
    id: 'FEAT-CAL-012',
    capability: null,
    async run(t: TestContext, s) {
      const all = (t.success(await s.A.call('calendar_calendars', {}), 'calendar_calendars').calendars as Json[]) ?? []
      t.equal(all.filter((c) => c.primary === true).length, 1, "the calendars of A's list that carry primary")
      t.ok(
        all.every((c) => c.primary === undefined || c.primary === true),
        'a calendar carries primary: false'
      )
      const sample = all.find((c) => String(c.title).replace(/[^A-Za-z]/g, '').length >= 4)
      if (sample) {
        const letters =
          String(sample.title)
            .match(/[A-Za-z]{2,}/g)
            ?.join('') ?? ''
        const word = String(sample.title).match(/[A-Za-z]{4,}/)?.[0] ?? letters.slice(0, 4)
        const query =
          word.slice(0, 4).toLowerCase() === word.slice(0, 4)
            ? word.slice(0, 4).toUpperCase()
            : word.slice(0, 4).toLowerCase()
        const found =
          (t.success(await s.A.call('calendar_calendars', { query }), 'calendar_calendars with a query')
            .calendars as Json[]) ?? []
        t.ok(
          found.some((c) => c.ref === sample.ref),
          `"${query}" does not find "${String(sample.title)}"`
        )
        for (const c of found)
          t.ok(String(c.title).toLowerCase().includes(query.toLowerCase()), `"${query}" finds "${String(c.title)}"`)
      } else t.note('no calendar title of four letters: the query is not tested')
      const second = all.find((c) => c.ref === s.run.second)
      if (second && second.writable === false)
        t.refused(
          await s.A.call('calendar_create_event', {
            calendar: s.run.second,
            title: `${s.token} 012`,
            start: '2027-01-19T10:00:00Z',
            end: '2027-01-19T11:00:00Z',
          }),
          'permission-denied',
          'a creation in a calendar shared with A to read'
        )
      else t.note('the second calendar is writable for A, or not in its list: the refusal of a creation is not tested')
    },
  },
  {
    id: 'FEAT-CAL-013',
    capability: null,
    async run(t: TestContext, s) {
      const w = await weekly(t, s, '013 weekly', '2027-02-01T10:00:00+01:00')
      const series = await get(t, s, w.series)
      t.ok(typeof series.rule === 'string', 'a series read by its reference has no rule')
      const occ = (await list(t, s.A, s.run.first, w.from, w.to)).filter((e) => e.series === w.series)
      t.ok(occ.length >= 2, 'the series lists fewer than two occurrences')
      t.equal(series.start, occ[0]?.start, 'the start of the series and of its first occurrence')
      const second = occ[1] as Json
      const r = await get(t, s, String(second.ref))
      t.equal([r.ref, r.start], [second.ref, second.start], 'an occurrence read by its reference')
    },
  },
  {
    id: 'FEAT-CAL-014',
    capability: null,
    async run(t: TestContext, s) {
      const e = await add(t, s, { title: `${s.token} 014`, start: '2027-01-20T10:00:00Z', end: '2027-01-20T11:00:00Z' })
      const r = await get(t, s, String(e.ref))
      t.equal([r.allDay, r.busy, r.status], [false, true, 'confirmed'], 'the members a creation takes when absent')
      t.refused(
        await s.A.call('calendar_create_event', {
          calendar: s.run.first,
          title: 'x',
          start: '2027-01-20T10:00:00Z',
          end: '2027-01-20T10:00:00Z',
        }),
        'invalid-argument',
        'end equal to start',
        'end'
      )
      t.refused(
        await s.A.call('calendar_create_event', {
          calendar: s.run.first,
          title: 'x',
          start: '2027-01-20T10:00:00Z',
          end: '2027-01-20T11:00:00Z',
          timeZone: 'Mars/Olympus',
        }),
        'invalid-argument',
        'an unknown time zone',
        'timeZone'
      )
      t.refused(
        await s.A.call('calendar_create_event', {
          calendar: s.run.first,
          title: 'x'.repeat(1025),
          start: '2027-01-20T10:00:00Z',
          end: '2027-01-20T11:00:00Z',
        }),
        'invalid-argument',
        'a title of 1025 characters',
        'title'
      )
    },
  },
  {
    id: 'FEAT-CAL-015',
    capability: null,
    async run(t: TestContext, s) {
      const e = await add(t, s, {
        title: `${s.token} 015`,
        start: '2026-11-23T10:00:00+01:00',
        end: '2026-11-23T11:00:00+01:00',
      })
      const r = await get(t, s, String(e.ref))
      t.equal(
        Date.parse(String(r.start)),
        Date.parse('2026-11-23T10:00:00+01:00'),
        'the instant of an event created with no zone'
      )
      t.ok(r.timeZone === undefined, 'an event created with no zone reads a timeZone')
      const f = s.calendar.fixtures?.floating
      if (!f) {
        t.note('no fixture floating: a floating time is not tested')
        return
      }
      t.equal((await get(t, s, f.ref)).start, f.start, "a floating time, read in the calendar's zone")
    },
  },
  {
    id: 'FEAT-CAL-016',
    capability: null,
    async run(t: TestContext, s) {
      const e = await add(t, s, { title: `${s.token} 016`, start: '2027-01-21T10:00:00Z', end: '2027-01-21T11:00:00Z' })
      t.success(
        await s.A.call('calendar_update_event', {
          calendar: s.run.first,
          ref: e.ref,
          ifVersion: e.version,
          title: `${s.token} 016 first`,
        }),
        'a change'
      )
      t.refused(
        await s.A.call('calendar_update_event', {
          calendar: s.run.first,
          ref: e.ref,
          ifVersion: e.version,
          title: `${s.token} 016 second`,
        }),
        'version-mismatch',
        'a change with the version read before another'
      )
      t.equal((await get(t, s, String(e.ref))).title, `${s.token} 016 first`, 'the title after')
      const done = t.success(
        await s.A.call('calendar_cancel_event', { calendar: s.run.first, ref: e.ref }),
        'a cancellation'
      )
      t.equal([done.cancelled, done.ref], [true, e.ref], 'the answer of a cancellation')
    },
  },
  {
    id: 'FEAT-CAL-017',
    capability: null,
    async run(t: TestContext, s) {
      const { inA } = await invitation(t, s, '017')
      const attendees = (inA.attendees as Json[]) ?? []
      t.ok(
        attendees.some((a) => a.self === true),
        "A's line of B's invitation carries no self: true"
      )
      const b = s.options.accounts.B.address
      if (b)
        t.equal(
          String((inA.organizer as Json | undefined)?.address ?? '').toLowerCase(),
          b.toLowerCase(),
          "B's address as the organizer"
        )
      const tally = s.observer.result(CALENDAR_PROFILE.id, 'FEAT-CAL-017')
      t.ok(tally.violations.length === 0, tally.violations.join(' | '))
    },
  },
  // free-busy
  {
    id: 'FEAT-CAL-020',
    capability: 'free-busy',
    async run(t: TestContext, s) {
      await add(t, s, { title: `${s.token} 020 one`, start: '2027-02-02T10:00:00Z', end: '2027-02-02T11:00:00Z' })
      await add(t, s, { title: `${s.token} 020 two`, start: '2027-02-02T10:30:00Z', end: '2027-02-02T12:00:00Z' })
      const nobody = `nobody-${s.token}@example.org`
      const out = t.success(
        await s.A.call('calendar_free_busy', {
          calendar: s.run.first,
          from: '2027-02-02T09:00:00Z',
          to: '2027-02-02T13:00:00Z',
          people: [nobody],
        }),
        'calendar_free_busy'
      )
      const busy = ((out.calendar as Json).busy as Json[]) ?? []
      t.equal(busy.length, 1, 'two events that overlap')
      t.equal(
        [Date.parse(String(busy[0]?.start)), Date.parse(String(busy[0]?.end))],
        [Date.parse('2027-02-02T10:00:00Z'), Date.parse('2027-02-02T12:00:00Z')],
        'the time taken'
      )
      t.ok(
        !JSON.stringify(out).includes('020 one') && !JSON.stringify(out).includes('020 two'),
        'the answer holds the title of an event'
      )
      t.equal(((out.people as Json[]) ?? [])[0]?.known, false, 'an address the service does not know')
    },
  },
  {
    id: 'FEAT-CAL-021',
    capability: 'free-busy',
    async run(t: TestContext, s) {
      t.refused(
        await s.A.call('calendar_free_busy', {
          calendar: s.run.first,
          from: '2027-01-01T00:00:00Z',
          to: '2027-03-05T00:00:00Z',
        }),
        'invalid-argument',
        '63 days',
        'to'
      )
      const people = Array.from({ length: 21 }, (_, i) => `person${i}@example.org`)
      t.refused(
        await s.A.call('calendar_free_busy', {
          calendar: s.run.first,
          from: '2027-01-01T00:00:00Z',
          to: '2027-01-02T00:00:00Z',
          people,
        }),
        'invalid-argument',
        '21 addresses',
        'people'
      )
    },
  },
  // recurrence
  {
    id: 'FEAT-CAL-030',
    capability: 'recurrence',
    async run(t: TestContext, s) {
      const e = await add(t, s, {
        title: `${s.token} 030`,
        start: '2027-03-01T10:00:00+01:00',
        end: '2027-03-01T11:00:00+01:00',
        timeZone: PARIS,
        rule: 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6',
      })
      const occ = (
        await list(t, s.A, s.run.first, '2027-02-28T00:00:00Z', '2027-04-01T00:00:00Z', `${s.token} 030`)
      ).filter((x) => x.series === e.ref)
      t.equal(occ.length, 6, 'the occurrences of FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6')
      for (const o of occ) {
        const day = new Date(Date.parse(String(o.start))).getUTCDay()
        t.ok(day === 1 || day === 3, `an occurrence on day ${day}`)
      }
      t.refused(
        await s.A.call('calendar_create_event', {
          calendar: s.run.first,
          title: 'x',
          start: '2027-03-01T10:00:00+01:00',
          end: '2027-03-01T11:00:00+01:00',
          timeZone: PARIS,
          rule: 'FREQ=SECONDLY',
        }),
        'not-supported',
        'FREQ=SECONDLY',
        'rule'
      )
      t.refused(
        await s.A.call('calendar_create_event', {
          calendar: s.run.first,
          title: 'x',
          start: '2027-03-01T10:00:00+01:00',
          end: '2027-03-01T11:00:00+01:00',
          rule: 'FREQ=WEEKLY',
        }),
        'invalid-argument',
        'a rule with no timeZone'
      )
    },
  },
  {
    id: 'FEAT-CAL-031',
    capability: 'recurrence',
    async run(t: TestContext, s) {
      const w = await weekly(t, s, '031 weekly', '2027-04-05T10:00:00+02:00')
      const before = (await list(t, s.A, s.run.first, w.from, w.to)).filter((e) => e.series === w.series)
      const moved = before[1] as Json
      const start = new Date(Date.parse(String(moved.start)) + 3_600_000).toISOString().replace('.000Z', 'Z')
      const end = new Date(Date.parse(String(moved.end)) + 3_600_000).toISOString().replace('.000Z', 'Z')
      t.success(
        await s.A.call('calendar_update_event', { calendar: s.run.first, ref: moved.ref, start, end }),
        'one occurrence moved by an hour'
      )
      const after = (await list(t, s.A, s.run.first, w.from, w.to)).filter((e) => e.series === w.series)
      t.equal(after.length, before.length, 'the occurrences after one moved')
      for (let i = 0; i < before.length; i++)
        if (i !== 1)
          t.equal(
            Date.parse(String(after[i]?.start)),
            Date.parse(String(before[i]?.start)),
            `occurrence ${i + 1} after another moved`
          )
      t.equal(Date.parse(String(after[1]?.start)), Date.parse(start), 'the moved occurrence')
      t.success(
        await s.A.call('calendar_cancel_event', {
          calendar: s.run.first,
          ref: (after[0] as Json).ref,
          scope: 'series',
        }),
        'a cancellation of the series'
      )
      t.equal(
        (await list(t, s.A, s.run.first, w.from, w.to)).filter((e) => e.series === w.series).length,
        0,
        'the occurrences after the series was cancelled'
      )
    },
  },
  {
    id: 'FEAT-CAL-032',
    capability: 'recurrence',
    async run(t: TestContext, s) {
      const e = await add(t, s, {
        title: `${s.token} 032`,
        start: '2027-03-15T10:00:00+01:00',
        end: '2027-03-15T11:00:00+01:00',
        timeZone: PARIS,
        rule: 'FREQ=WEEKLY;COUNT=4',
      })
      const occ = (
        await list(t, s.A, s.run.first, '2027-03-14T00:00:00Z', '2027-04-10T00:00:00Z', `${s.token} 032`)
      ).filter((x) => x.series === e.ref)
      t.equal(
        occ.map((o) => String(o.start).slice(10)),
        ['T10:00:00+01:00', 'T10:00:00+01:00', 'T10:00:00+02:00', 'T10:00:00+02:00'],
        'a weekly 10:00 of Europe/Paris across the last Sunday of March'
      )
    },
  },
  {
    id: 'FEAT-CAL-033',
    capability: 'recurrence',
    async run(t: TestContext, s) {
      const w = await weekly(t, s, '033 weekly', '2027-05-03T10:00:00+02:00')
      const occ = (await list(t, s.A, s.run.first, w.from, w.to)).filter((e) => e.series === w.series)
      t.refused(
        await s.A.call('calendar_update_event', {
          calendar: s.run.first,
          ref: (occ[0] as Json).ref,
          rule: 'FREQ=WEEKLY;COUNT=2',
        }),
        'invalid-argument',
        'a change of the rule by an occurrence',
        'rule'
      )
      t.success(
        await s.A.call('calendar_update_event', {
          calendar: s.run.first,
          ref: w.series,
          title: `${s.token} 033 renamed`,
        }),
        'a change of the title by the series'
      )
      const renamed = (await list(t, s.A, s.run.first, w.from, w.to)).filter((e) => e.series === w.series)
      t.ok(renamed.length > 0 && renamed.every((e) => e.title === `${s.token} 033 renamed`), 'every occurrence renamed')
      t.success(
        await s.A.call('calendar_update_event', { calendar: s.run.first, ref: w.series, rule: 'FREQ=WEEKLY;COUNT=2' }),
        'a change of the rule by the series'
      )
      t.equal(
        (await list(t, s.A, s.run.first, w.from, w.to)).filter((e) => e.series === w.series).length,
        2,
        'the occurrences after COUNT=2'
      )
    },
  },
  // attendees
  {
    id: 'FEAT-CAL-040',
    capability: 'attendees',
    async run(t: TestContext, s) {
      const b = s.options.accounts.B.address
      if (!b) t.skip("needs B's address at the service")
      const messages = s.options.hooks?.messages
      const before = messages ? (await messages(b)).length : 0
      const e = await add(t, s, {
        title: `${s.token} 040`,
        start: '2027-02-08T10:00:00Z',
        end: '2027-02-08T11:00:00Z',
        attendees: [{ address: b }],
        notify: true,
      })
      await add(t, s, {
        title: `${s.token} 040 quiet`,
        start: '2027-02-08T12:00:00Z',
        end: '2027-02-08T13:00:00Z',
        attendees: [{ address: b }],
        notify: false,
      })
      if (messages) {
        const got = (await messages(b)).slice(before)
        t.ok(
          got.some((m) => (m.subject ?? m.text).includes(`${s.token} 040`)),
          'B received no invitation of an event created with notify true'
        )
        t.ok(
          !got.some((m) => (m.subject ?? m.text).includes(`${s.token} 040 quiet`)),
          'B received an invitation of an event created with notify false'
        )
      } else t.note('no hook messages: what B receives is not tested')
      const emptied = (t.success(
        await s.A.call('calendar_update_event', { calendar: s.run.first, ref: e.ref, attendees: [], notify: false }),
        'a change with an empty list'
      ).event ?? {}) as Json
      t.ok(
        !emptied.attendees || (emptied.attendees as Json[]).length === 0,
        'attendees after a change with an empty list'
      )
    },
  },
  {
    id: 'FEAT-CAL-041',
    capability: 'attendees',
    async run(t: TestContext, s) {
      const a = s.options.accounts.A.address
      const b = s.options.accounts.B.address
      if (!b) t.skip("needs B's address at the service")
      const e = await add(t, s, {
        title: `${s.token} 041`,
        start: '2027-02-09T10:00:00Z',
        end: '2027-02-09T11:00:00Z',
        attendees: [{ address: b }],
        notify: false,
      })
      const addresses = (((await get(t, s, String(e.ref))).attendees as Json[]) ?? []).map((x) =>
        String(x.address).toLowerCase()
      )
      const allowed = new Set([b.toLowerCase(), ...(a ? [a.toLowerCase()] : [])])
      t.ok(addresses.includes(b.toLowerCase()), 'B is not among the attendees')
      t.ok(
        addresses.every((x) => allowed.has(x)),
        `the attendees are ${addresses.join(', ')}`
      )
    },
  },
  {
    id: 'FEAT-CAL-042',
    capability: 'attendees',
    async run(t: TestContext, s) {
      const b = s.options.accounts.B.address
      if (!b) t.skip("needs B's address at the service")
      const e = await add(t, s, {
        title: `${s.token} 042`,
        start: '2027-02-10T10:00:00Z',
        end: '2027-02-10T11:00:00Z',
        attendees: [{ address: b, optional: true }],
        notify: false,
      })
      const line = (((await get(t, s, String(e.ref))).attendees as Json[]) ?? []).find(
        (x) => String(x.address).toLowerCase() === b.toLowerCase()
      )
      t.equal(line?.optional, true, 'optional of B, invited as optional')
      const many = Array.from({ length: 101 }, (_, i) => ({ address: `person${i}@example.org` }))
      t.refused(
        await s.A.call('calendar_create_event', {
          calendar: s.run.first,
          title: 'x',
          start: '2027-02-10T12:00:00Z',
          end: '2027-02-10T13:00:00Z',
          attendees: many,
        }),
        'invalid-argument',
        '101 attendees',
        'attendees'
      )
      const messages = s.options.hooks?.messages
      if (!messages) {
        t.note('no hook messages: the comment of a cancellation is not tested')
        return
      }
      const before = (await messages(b)).length
      t.success(
        await s.A.call('calendar_cancel_event', {
          calendar: s.run.first,
          ref: e.ref,
          notify: true,
          comment: `Moved to next week ${s.token}`,
        }),
        'a cancellation with a comment'
      )
      t.ok(
        (await messages(b)).slice(before).some((m) => m.text.includes(`Moved to next week ${s.token}`)),
        "B's cancellation message does not hold the comment"
      )
    },
  },
  // respond, meeting
  {
    id: 'FEAT-CAL-050',
    capability: 'respond',
    async run(t: TestContext, s) {
      const { inA } = await invitation(t, s, '050')
      const messages = s.options.hooks?.messages
      const b = s.options.accounts.B.address
      const before = messages && b ? (await messages(b)).length : 0
      const out = (t.success(
        await s.A.call('calendar_respond', { calendar: s.run.first, ref: inA.ref, response: 'declined', notify: true }),
        "A's answer"
      ).event ?? {}) as Json
      t.equal(
        ((out.attendees as Json[]) ?? []).find((x) => x.self === true)?.response,
        'declined',
        "A's line after A declined"
      )
      if (messages && b) t.ok((await messages(b)).length > before, "A's answer did not reach B")
      const own = await add(t, s, {
        title: `${s.token} 050 own`,
        start: '2027-02-11T10:00:00Z',
        end: '2027-02-11T11:00:00Z',
      })
      t.refused(
        await s.A.call('calendar_respond', { calendar: s.run.first, ref: own.ref, response: 'accepted' }),
        'not-supported',
        "an answer to A's own event"
      )
    },
  },
  {
    id: 'FEAT-CAL-051',
    capability: 'respond',
    async run(t: TestContext, s) {
      const { inA } = await invitation(t, s, '051')
      const messages = s.options.hooks?.messages
      const b = s.options.accounts.B.address
      const before = messages && b ? (await messages(b)).length : 0
      const out = (t.success(
        await s.A.call('calendar_respond', {
          calendar: s.run.first,
          ref: inA.ref,
          response: 'accepted',
          notify: false,
        }),
        "A's answer with notify false"
      ).event ?? {}) as Json
      t.equal(((out.attendees as Json[]) ?? []).find((x) => x.self === true)?.response, 'accepted', "A's line")
      if (messages && b)
        t.equal((await messages(b)).length, before, 'the messages B received after an answer with notify false')
      else t.note('no hook messages: that B receives nothing is not tested')
      if (!has(s, 'recurrence') || !has(s, 'attendees') || !s.options.accounts.A.address) {
        t.note('no recurrence or attendees: the answer to one occurrence is not tested')
        return
      }
      const bCal = await bCalendar(t, s)
      const title = `${s.token} 051 weekly`
      await add(
        t,
        s,
        {
          title,
          start: '2027-02-15T10:00:00+01:00',
          end: '2027-02-15T11:00:00+01:00',
          timeZone: PARIS,
          rule: 'FREQ=WEEKLY;COUNT=3',
          attendees: [{ address: s.options.accounts.A.address }],
        },
        s.B,
        bCal
      )
      const occ = await list(t, s.A, s.run.first, '2027-02-14T00:00:00Z', '2027-03-08T00:00:00Z', title)
      t.equal(occ.length, 3, "the occurrences of B's weekly invitation in A's calendar")
      t.success(
        await s.A.call('calendar_respond', {
          calendar: s.run.first,
          ref: (occ[1] as Json).ref,
          response: 'declined',
          notify: false,
        }),
        "A's answer to one occurrence"
      )
      const after = await list(t, s.A, s.run.first, '2027-02-14T00:00:00Z', '2027-03-08T00:00:00Z', title)
      const mineOf = (e: Json | undefined) => ((e?.attendees as Json[]) ?? []).find((x) => x.self === true)?.response
      t.equal(after.map(mineOf), [mineOf(occ[0]), 'declined', mineOf(occ[2])], "A's answers to the occurrences after")
    },
  },
  {
    id: 'FEAT-CAL-060',
    capability: 'meeting',
    async run(t: TestContext, s) {
      const e = await add(t, s, {
        title: `${s.token} 060`,
        start: '2027-02-12T10:00:00Z',
        end: '2027-02-12T11:00:00Z',
        meeting: true,
      })
      const url = String((e.meeting as Json | undefined)?.url ?? '')
      t.ok(url.startsWith('https://'), `the meeting of a creation with meeting true: ${url}`)
      const changed = (t.success(
        await s.A.call('calendar_update_event', { calendar: s.run.first, ref: e.ref, meeting: false }),
        'a change with meeting false'
      ).event ?? {}) as Json
      t.ok(changed.meeting === undefined, 'a meeting after a change with meeting false')
    },
  },
  {
    id: 'FEAT-CAL-061',
    capability: null,
    async run(t: TestContext, s) {
      if (has(s, 'meeting'))
        t.ok(
          typeof (s.run.declaration.meeting as Json | undefined)?.label === 'string',
          'meeting declared without its label'
        )
      const ref = s.calendar.fixtures?.conference
      if (!ref) {
        if (!has(s, 'meeting'))
          t.skip('needs the fixture conference: an event with a CONFERENCE put in the calendar by other means')
        t.note('no fixture conference: the meeting of an event put by other means is not tested')
        return
      }
      t.ok((await get(t, s, ref)).meeting, 'an event with a CONFERENCE reads no meeting')
    },
  },
]
