/**
 * The mappings on their own: recurrence rules beyond the part the profile writes (FEAT-CALDAV-003), iCalendar kept and
 * folded (FEAT-CALDAV-004), zones read and written (FEAT-CALDAV-005), events and their occurrences, the XML of a
 * server (no document type read), paths (FEAT-WEBDAV-002, 003).
 */
import { describe, expect, it } from 'vitest'
import { customZone, findOccurrence, occurrencesOf, parseRidText, ridText } from '../src/events.js'
import { fold, parseICalendar, parseTime, serializeICalendar, unescapeText } from '../src/ical.js'
import { refParts, within } from '../src/paths.js'
import { expandRule, parseRRule } from '../src/rrule.js'
import { formatInstant, ianaNameOf, ianaZone, toInstant, UTC_ZONE, vtimezoneLines } from '../src/tz.js'
import { parseXml, XmlError } from '../src/xml.js'

const local = (y: number, m: number, d: number, h = 0, mi = 0) => ({ y, m, d, h, mi, s: 0 })
const days = (r: string, start = local(2027, 1, 1, 9), until = local(2027, 12, 31)) =>
  expandRule(
    parseRRule(r) as NonNullable<ReturnType<typeof parseRRule>>,
    start,
    false,
    () => true,
    (l) => Date.UTC(l.y, l.m - 1, l.d) > Date.UTC(until.y, until.m - 1, until.d)
  ).map((l) => `${l.y}-${String(l.m).padStart(2, '0')}-${String(l.d).padStart(2, '0')}`)

describe('recurrence rules', () => {
  it('the rules the profile writes', () => {
    expect(days('FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6', local(2027, 1, 4, 10))).toEqual([
      '2027-01-04',
      '2027-01-06',
      '2027-01-11',
      '2027-01-13',
      '2027-01-18',
      '2027-01-20',
    ])
    expect(days('FREQ=MONTHLY;BYDAY=-1FR;COUNT=3', local(2027, 1, 29))).toEqual([
      '2027-01-29',
      '2027-02-26',
      '2027-03-26',
    ])
    expect(days('FREQ=YEARLY;BYMONTH=3;BYDAY=2TU;COUNT=2', local(2027, 3, 9), local(2029, 1, 1))).toEqual([
      '2027-03-09',
      '2028-03-14',
    ])
    expect(days('FREQ=DAILY;INTERVAL=3;COUNT=3', local(2027, 1, 30))).toEqual([
      '2027-01-30',
      '2027-02-02',
      '2027-02-05',
    ])
  })

  it('rules other calendars write: BYSETPOS, a negative BYMONTHDAY, BYYEARDAY, BYWEEKNO, UNTIL', () => {
    // the last weekday of each month
    expect(days('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3', local(2027, 1, 29))).toEqual([
      '2027-01-29',
      '2027-02-26',
      '2027-03-31',
    ])
    expect(days('FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3', local(2027, 1, 31))).toEqual([
      '2027-01-31',
      '2027-02-28',
      '2027-03-31',
    ])
    expect(days('FREQ=YEARLY;BYYEARDAY=100;COUNT=2', local(2027, 4, 10), local(2029, 1, 1))).toEqual([
      '2027-04-10',
      '2028-04-09',
    ])
    expect(days('FREQ=YEARLY;BYWEEKNO=1;BYDAY=MO;COUNT=2', local(2027, 1, 4), local(2029, 1, 1))).toEqual([
      '2027-01-04',
      '2028-01-03',
    ])
    const r = parseRRule('FREQ=WEEKLY;UNTIL=20270118T000000Z') as NonNullable<ReturnType<typeof parseRRule>>
    expect(r.until).toBe('20270118T000000Z')
    expect(parseRRule('FREQ=WEEKLY;X-NAME=1')).toBeUndefined()
    expect(parseRRule('FREQ=WEEKLY;COUNT=2;UNTIL=20270101')).toBeUndefined()
  })

  it('a rule that never matches ends at the window', () => {
    expect(days('FREQ=MONTHLY;BYMONTHDAY=31;BYMONTH=2', local(2027, 1, 31))).toEqual(['2027-01-31'])
  })
})

describe('events and occurrences', () => {
  const series = parseICalendar(
    [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:s',
      'DTSTART;TZID=Europe/Paris:20270322T100000',
      'DTEND;TZID=Europe/Paris:20270322T110000',
      'RRULE:FREQ=WEEKLY;COUNT=3',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n')
  )
  it('keeps the wall clock across a change of offset (FEAT-CAL-032)', () => {
    const occ = occurrencesOf(series, UTC_ZONE, Date.parse('2027-03-01T00:00:00Z'), Date.parse('2027-04-30T00:00:00Z'))
    expect(occ.map((o) => formatInstant(o.times.start, o.times.zone))).toEqual([
      '2027-03-22T10:00:00+01:00',
      '2027-03-29T10:00:00+02:00',
      '2027-04-05T10:00:00+02:00',
    ])
  })
  it('finds one occurrence by its original start, and none that the rule does not make', () => {
    const rid = Date.parse('2027-03-29T08:00:00Z')
    expect(findOccurrence(series, UTC_ZONE, rid)?.rid).toBe(rid)
    expect(findOccurrence(series, UTC_ZONE, rid + 3_600_000)).toBeUndefined()
    expect(ridText(false, rid)).toBe('20270329T080000Z')
    expect(parseRidText('20270329T080000Z')).toEqual({ allDay: false, ms: rid })
    expect(parseRidText('20270329')).toEqual({ allDay: true, ms: Date.UTC(2027, 2, 29) })
  })
  it('reads a floating time in the calendar’s zone (FEAT-CAL-015)', () => {
    const v = parseICalendar(
      'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:f\r\nDTSTART:20270112T090000\r\nDTEND:20270112T100000\r\nEND:VEVENT\r\nEND:VCALENDAR'
    )
    const paris = ianaZone('Europe/Paris')
    const [o] = occurrencesOf(v, paris, Date.parse('2027-01-12T00:00:00Z'), Date.parse('2027-01-13T00:00:00Z'))
    expect(formatInstant(o?.times.start ?? 0, o?.times.zone)).toBe('2027-01-12T09:00:00+01:00')
  })
  it('reads a zone the object defines under a name of no database', () => {
    const v = parseICalendar(
      [
        'BEGIN:VCALENDAR',
        'BEGIN:VTIMEZONE',
        'TZID:W. Europe Standard Time',
        'BEGIN:STANDARD',
        'DTSTART:16010101T030000',
        'TZOFFSETFROM:+0200',
        'TZOFFSETTO:+0100',
        'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10',
        'END:STANDARD',
        'BEGIN:DAYLIGHT',
        'DTSTART:16010101T020000',
        'TZOFFSETFROM:+0100',
        'TZOFFSETTO:+0200',
        'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3',
        'END:DAYLIGHT',
        'END:VTIMEZONE',
        'END:VCALENDAR',
      ].join('\r\n')
    )
    const zone = customZone(v.components[0] as never)
    expect(zone.offsetAt(Date.parse('2027-01-15T12:00:00Z'))).toBe(60)
    expect(zone.offsetAt(Date.parse('2027-07-15T12:00:00Z'))).toBe(120)
    expect(toInstant(local(2027, 7, 15, 10), zone)).toBe(Date.parse('2027-07-15T08:00:00Z'))
  })
})

describe('iCalendar and zones', () => {
  it('keeps what it does not know, and folds at 75 octets, never inside a character', () => {
    const text = [
      'BEGIN:VCALENDAR',
      'X-ANY;X-P="a:b";Y=1,2:value\\, with a comma',
      'BEGIN:VEVENT',
      `DESCRIPTION:${'é'.repeat(60)}`,
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n')
    const out = serializeICalendar(parseICalendar(text))
    expect(out).toContain('X-ANY;X-P="a:b";Y=1,2:value\\, with a comma')
    for (const line of out.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75)
    expect(parseICalendar(out).components[0]?.props[0]?.value).toBe('é'.repeat(60))
    expect(unescapeText('a\\nb\\;c\\,d\\\\e')).toBe('a\nb;c,d\\e')
    expect(fold('x'.repeat(80)).split('\r\n ')).toHaveLength(2)
  })
  it('reads dates, UTC times and wall clocks', () => {
    expect(parseTime('20270104')).toEqual({ kind: 'date', y: 2027, m: 1, d: 4 })
    expect(parseTime('20270104T100000Z')).toEqual({ kind: 'utc', ms: Date.parse('2027-01-04T10:00:00Z') })
    expect(parseTime('20270104T100000', 'Europe/Paris')).toEqual({
      kind: 'local',
      l: local(2027, 1, 4, 10),
      tzid: 'Europe/Paris',
    })
  })
  it('writes a VTIMEZONE of yearly rules for Europe/Paris, and one observance for a zone of no change', () => {
    const lines = vtimezoneLines('Europe/Paris', Date.parse('2027-01-04T10:00:00Z'))
    expect(lines).toContain('RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU')
    expect(lines).toContain('RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU')
    expect(lines).toContain('TZOFFSETTO:+0200')
    const tokyo = vtimezoneLines('Asia/Tokyo', Date.now())
    expect(tokyo.filter((l) => l.startsWith('BEGIN:STANDARD'))).toHaveLength(1)
    expect(tokyo).toContain('TZOFFSETTO:+0900')
    expect(ianaNameOf('/mozilla.org/20070129_1/Europe/Paris')).toBe('Europe/Paris')
    expect(ianaNameOf('W. Europe Standard Time')).toBeUndefined()
  })
})

describe('XML and paths', () => {
  it('reads namespaces and refuses a document type, so that no entity of a server is expanded', () => {
    const root = parseXml('<?xml version="1.0"?><a:x xmlns:a="DAV:" xmlns="urn:b"><y a:z="1">&lt;&#65;</y></a:x>')
    expect([root.ns, root.name]).toEqual(['DAV:', 'x'])
    const y = root.children[0] as { ns: string; attrs: Record<string, string>; children: string[] }
    expect([y.ns, y.attrs['{DAV:}z'], y.children[0]]).toEqual(['urn:b', '1', '<A'])
    expect(() => parseXml('<!DOCTYPE x [<!ENTITY e "boom">]><x>&e;</x>')).toThrow(XmlError)
    expect(() => parseXml('<x>&e;</x>')).toThrow(XmlError)
  })
  it('compares paths part by part (FEAT-WEBDAV-003), and refuses dot parts (002)', () => {
    expect(within(['Projects', 'Alpha'], ['Projects', 'Alphabet', 'x.md'])).toBe(false)
    expect(within(['Projects', 'Alpha'], ['Projects', 'Alpha', 'x.md'])).toBe(true)
    expect(refParts('/', 'root')).toEqual([])
    for (const bad of ['/a/../b', '/a//b', '/./a', '/a/'])
      expect(() => refParts(bad, 'ref')).toThrow(expect.objectContaining({ code: 'invalid-argument' }))
    expect(() => refParts('no-slash', 'ref')).toThrow(expect.objectContaining({ code: 'not-found' }))
  })
})
