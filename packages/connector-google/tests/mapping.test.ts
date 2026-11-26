/**
 * The mappings of the connector on their own: Drive's kinds, documents, versions, roles, query words and shares;
 * Calendar's events, times, attendees, rules and meetings; Google's errors; pages over Google's pages.
 */
import { describe, expect, it } from 'vitest'
import {
  attendeesOf,
  calendarOf,
  eventOf,
  googleTime,
  holdsText,
  isMine,
  mergeBusy,
  plainText,
  ruleOf,
} from '../src/calendar-map.js'
import {
  driveRoleOfItem,
  driveRoleOfMember,
  isNative,
  kindOf,
  mediaTypeOfName,
  quote,
  readTypeOf,
  roleOf,
  searchQuery,
  shareOf,
  snippetOf,
  versionOf,
  wordsOf,
} from '../src/drive-map.js'
import { googleErrorOf, profileErrorOf } from '../src/google.js'
import { fillPage } from '../src/pages.js'
import { formatInstant, instantOf, midnightIn } from '../src/time.js'

describe('Drive as Files 1.0', () => {
  it('reads a folder, a shortcut and every other type as their kinds', () => {
    expect(kindOf('application/vnd.google-apps.folder')).toBe('folder')
    expect(kindOf('application/vnd.google-apps.shortcut')).toBe('link')
    expect(kindOf('application/vnd.google-apps.document')).toBe('file')
    expect(kindOf('image/png')).toBe('file')
  })

  it("reads Google's documents that Drive exports as native, as Markdown where Drive gives it, else plain text", () => {
    expect(isNative('application/vnd.google-apps.document')).toBe(true)
    expect(isNative('application/vnd.google-apps.form')).toBe(false)
    expect(isNative('text/plain')).toBe(false)
    expect(readTypeOf('application/vnd.google-apps.document')).toBe('text/markdown')
    expect(readTypeOf('application/vnd.google-apps.presentation')).toBe('text/plain')
    // a spreadsheet exports to CSV only: files_read refuses it, files_export gives it
    expect(readTypeOf('application/vnd.google-apps.spreadsheet')).toBeUndefined()
  })

  it('takes headRevisionId as the version of a file of bytes, version for a document of Google', () => {
    expect(versionOf({ id: 'x', name: 'a', mimeType: 'text/plain', headRevisionId: 'r2', version: '9' })).toBe('r2')
    expect(versionOf({ id: 'x', name: 'a', mimeType: 'application/vnd.google-apps.document', version: '9' })).toBe('9')
  })

  it('maps roles to the nearest of Drive that gives no more, and back', () => {
    expect(driveRoleOfItem('reader')).toBe('reader')
    expect(driveRoleOfItem('editor')).toBe('writer')
    expect(driveRoleOfMember('reader')).toBe('reader')
    expect(driveRoleOfMember('editor')).toBe('fileOrganizer')
    expect(driveRoleOfMember('manager')).toBe('organizer')
    expect(roleOf('commenter')).toBe('reader')
    expect(roleOf('writer')).toBe('editor')
    expect(roleOf('fileOrganizer')).toBe('editor')
    expect(roleOf('organizer')).toBe('manager')
  })

  it('writes plain words into Drive’s query and reads no operator of the caller', () => {
    expect(quote("Valentine's \\ day")).toBe("'Valentine\\'s \\\\ day'")
    const words = wordsOf("budget 'x' in parents")
    expect(words).toEqual(['budget', "'x'", 'in', 'parents'])
    expect(searchQuery(words, 'name')).toBe(
      "name contains 'budget' and name contains '\\'x\\'' and name contains 'in' and name contains 'parents' and trashed = false"
    )
    expect(searchQuery(['kiwi'], 'any')).toBe("fullText contains 'kiwi' and trashed = false")
  })

  it('makes a snippet around a word of the text, and none for a text without the words', () => {
    expect(snippetOf('one two three mango four five', ['MANGO'])).toBe('one two three mango four five')
    expect(snippetOf('nothing here', ['mango'])).toBeUndefined()
  })

  it('gives a media type from a name’s extension', () => {
    expect(mediaTypeOfName('notes.md')).toBe('text/markdown')
    expect(mediaTypeOfName('pixel.PNG')).toBe('image/png')
    expect(mediaTypeOfName('notes')).toBeUndefined()
  })

  it('reads a permission as a share: inherited only when every detail is, audiences, no address as a name', () => {
    const inherited = shareOf(
      {
        id: '1',
        type: 'user',
        role: 'reader',
        emailAddress: 'blake@example.org',
        displayName: 'Blake Example',
        permissionDetails: [{ inherited: true, role: 'reader' }],
      },
      undefined
    )
    expect(inherited).toEqual({
      id: '1',
      role: 'reader',
      inherited: true,
      recipient: { address: 'blake@example.org', name: 'Blake Example' },
    })
    const both = shareOf(
      {
        id: '1',
        type: 'user',
        role: 'writer',
        emailAddress: 'b@example.org',
        displayName: 'b@example.org',
        permissionDetails: [{ inherited: true }, { inherited: false }],
      },
      undefined
    )
    expect(both).toEqual({ id: '1', role: 'editor', inherited: false, recipient: { address: 'b@example.org' } })
    expect(shareOf({ id: 'd', type: 'domain', role: 'reader', domain: 'example.org' }, undefined).audience).toBe(
      'organization'
    )
    expect(shareOf({ id: 'anyoneWithLink', type: 'anyone', role: 'reader' }, 'https://drive.example/x')).toEqual({
      id: 'anyoneWithLink',
      role: 'reader',
      inherited: false,
      audience: 'anyone',
      link: 'https://drive.example/x',
    })
    // a member of a shared drive is never inherited on the drive itself
    expect(
      shareOf({ id: '2', type: 'user', role: 'organizer', permissionDetails: [{ inherited: true }] }, undefined, true)
        .inherited
    ).toBe(false)
  })
})

describe('Google Calendar as Calendar 1.0', () => {
  const base = { id: 'e1', etag: '"3"', status: 'confirmed' }

  it('reads a timed event in the zone it was set in, whatever zone Google answers in', () => {
    const e = eventOf(
      {
        ...base,
        summary: 'Review',
        start: { dateTime: '2027-01-04T04:00:00-05:00', timeZone: 'Europe/Paris' },
        end: { dateTime: '2027-01-04T05:00:00-05:00', timeZone: 'Europe/Paris' },
      },
      'cal'
    )
    expect([e.start, e.end, e.timeZone]).toEqual([
      '2027-01-04T10:00:00+01:00',
      '2027-01-04T11:00:00+01:00',
      'Europe/Paris',
    ])
    expect([e.allDay, e.busy, e.status, e.mine, e.recurring, e.version]).toEqual([
      false,
      true,
      'confirmed',
      true,
      false,
      '"3"',
    ])
  })

  it('reads an event with no zone in UTC, an all-day event as dates, a cancelled one as cancelled', () => {
    const utc = eventOf(
      { ...base, start: { dateTime: '2026-11-23T10:00:00+01:00' }, end: { dateTime: '2026-11-23T11:00:00+01:00' } },
      'c'
    )
    expect([utc.start, utc.end, utc.timeZone]).toEqual(['2026-11-23T09:00:00Z', '2026-11-23T10:00:00Z', undefined])
    const day = eventOf({ ...base, start: { date: '2027-01-05' }, end: { date: '2027-01-06' } }, 'c')
    expect([day.allDay, day.start, day.end]).toEqual([true, '2027-01-05', '2027-01-06'])
    expect(
      eventOf({ ...base, status: 'cancelled', start: { date: '2027-01-05' }, end: { date: '2027-01-06' } }, 'c').status
    ).toBe('cancelled')
  })

  it('reads an occurrence with its series, a series with its rule, a meeting, a transparent event as free', () => {
    const occ = eventOf(
      {
        ...base,
        id: 's_20270104T090000Z',
        recurringEventId: 's',
        start: { date: '2027-01-04' },
        end: { date: '2027-01-05' },
      },
      'c'
    )
    expect([occ.recurring, occ.series, occ.rule]).toEqual([true, 's', undefined])
    const series = eventOf(
      {
        ...base,
        id: 's',
        recurrence: ['EXDATE:20270111T090000Z', 'RRULE:FREQ=WEEKLY;COUNT=4'],
        start: { date: '2027-01-04' },
        end: { date: '2027-01-05' },
      },
      'c'
    )
    expect([series.recurring, series.rule]).toEqual([true, 'FREQ=WEEKLY;COUNT=4'])
    expect(ruleOf(['RDATE:20270101'])).toBeUndefined()
    const meet = eventOf(
      {
        ...base,
        transparency: 'transparent',
        start: { date: '2027-01-04' },
        end: { date: '2027-01-05' },
        conferenceData: {
          entryPoints: [
            { entryPointType: 'phone', uri: 'tel:+1' },
            { entryPointType: 'video', uri: 'https://meet.example/abc' },
          ],
          conferenceSolution: { name: 'Google Meet' },
        },
      },
      'c'
    )
    expect([meet.busy, meet.meeting]).toEqual([false, { url: 'https://meet.example/abc', label: 'Google Meet' }])
  })

  it('reads attendees without rooms, self and optional only when true, and the organizer’s copy as mine', () => {
    expect(
      attendeesOf([
        { email: 'avery@example.org', self: true, responseStatus: 'accepted' },
        { email: 'blake@example.org', optional: true, responseStatus: 'needsAction', displayName: 'Blake' },
        { email: 'room@resource.example', resource: true, responseStatus: 'accepted' },
        { email: 'other@example.org', optional: false, self: false, responseStatus: 'declined' },
      ])
    ).toEqual([
      { address: 'avery@example.org', response: 'accepted', self: true },
      { address: 'blake@example.org', name: 'Blake', response: 'needs-action', optional: true },
      { address: 'other@example.org', response: 'declined' },
    ])
    expect(isMine({ id: 'x' })).toBe(true)
    expect(isMine({ id: 'x', organizer: { email: 'a@example.org', self: true } })).toBe(true)
    expect(isMine({ id: 'x', organizer: { email: 'b@example.org' } })).toBe(false)
  })

  it('gives a marked-up description as its text', () => {
    expect(plainText('Agenda<br>one &amp; <b>two</b>')).toBe('Agenda\none & two')
    expect(plainText('a < b and c > d')).toBe('a < b and c > d')
  })

  it('reads a calendar of the list: writable for a writer or an owner, primary only when true', () => {
    expect(
      calendarOf({
        id: 'a@example.org',
        summary: 'a@example.org',
        accessRole: 'owner',
        primary: true,
        timeZone: 'Europe/Paris',
      })
    ).toEqual({
      ref: 'a@example.org',
      title: 'a@example.org',
      timeZone: 'Europe/Paris',
      writable: true,
      portable: true,
      primary: true,
    })
    expect(calendarOf({ id: 'g', summary: 'Team', summaryOverride: 'My team', accessRole: 'reader' })).toEqual({
      ref: 'g',
      title: 'My team',
      writable: false,
      portable: true,
    })
  })

  it('matches a text whatever the case of ASCII letters only', () => {
    expect(holdsText('Budget Review', 'budget')).toBe(true)
    expect(holdsText('ÉTÉ', 'été')).toBe(false)
    expect(holdsText(undefined, 'x')).toBe(false)
  })

  it('writes a time for Google: a date, an instant with its zone, or UTC', () => {
    expect(googleTime('2027-01-05', true, undefined)).toEqual({ date: '2027-01-05', dateTime: null, timeZone: null })
    expect(googleTime('2027-01-04T10:00:00+01:00', false, 'Europe/Paris')).toEqual({
      dateTime: '2027-01-04T10:00:00+01:00',
      timeZone: 'Europe/Paris',
      date: null,
    })
    expect(googleTime('2027-01-04T10:00:00+01:00', false, undefined)).toEqual({
      dateTime: '2027-01-04T09:00:00Z',
      timeZone: null,
      date: null,
    })
  })

  it('merges busy times, in order, within the time asked', () => {
    expect(
      mergeBusy(
        [
          { start: '2027-02-02T10:30:00Z', end: '2027-02-02T12:00:00Z' },
          { start: '2027-02-02T08:00:00Z', end: '2027-02-02T11:00:00Z' },
          { start: '2027-02-02T12:00:00Z', end: '2027-02-02T12:30:00Z' },
          { start: '2027-02-02T15:00:00Z', end: '2027-02-02T16:00:00Z' },
        ],
        Date.parse('2027-02-02T09:00:00Z'),
        Date.parse('2027-02-02T13:00:00Z')
      )
    ).toEqual([{ start: '2027-02-02T09:00:00Z', end: '2027-02-02T12:30:00Z' }])
  })
})

describe('times', () => {
  it('writes an instant with the offset of its zone across a change of offset, and in UTC with Z', () => {
    expect(formatInstant(Date.parse('2027-03-22T09:00:00Z'), 'Europe/Paris')).toBe('2027-03-22T10:00:00+01:00')
    expect(formatInstant(Date.parse('2027-03-29T08:00:00Z'), 'Europe/Paris')).toBe('2027-03-29T10:00:00+02:00')
    expect(instantOf('2026-11-25T10:00:00.123Z')).toBe('2026-11-25T10:00:00Z')
    expect(midnightIn('2027-01-05', 'Europe/Paris')).toBe(Date.parse('2027-01-04T23:00:00Z'))
  })
})

describe("Google's errors", () => {
  const body = (status: number, reason: string, headers: Record<string, string> = {}, details?: unknown[]) =>
    new Response(
      JSON.stringify({ error: { code: status, message: 'm', errors: [{ reason }], ...(details ? { details } : {}) } }),
      {
        status,
        headers,
      }
    )

  it('maps each answer to the code of the profiles', async () => {
    const code = async (r: Response) => profileErrorOf(await googleErrorOf(r)).toContent().error
    expect((await code(body(401, 'authError'))).code).toBe('account-refused')
    expect((await code(body(403, 'insufficientFilePermissions'))).code).toBe('permission-denied')
    expect((await code(body(404, 'notFound'))).code).toBe('not-found')
    expect((await code(body(410, 'deleted'))).code).toBe('not-found')
    expect((await code(body(500, 'backendError'))).code).toBe('unavailable')
    expect((await code(body(503, 'backendError'))).code).toBe('unavailable')
    expect(await code(body(429, 'rateLimitExceeded', { 'retry-after': '7' }))).toMatchObject({
      code: 'rate-limited',
      retryAfterSeconds: 7,
    })
    const limited = await code(body(403, 'userRateLimitExceeded'))
    expect(limited.code).toBe('rate-limited')
    expect(limited.retryAfterSeconds).toBeUndefined()
  })

  it("answers Google's 403 of a missing scope as permission-denied, from the challenge or the ErrorInfo", async () => {
    const byHeader = await googleErrorOf(
      body(403, 'forbidden', {
        'www-authenticate': 'Bearer realm="https://accounts.google.com/", error="insufficient_scope"',
      })
    )
    const byInfo = await googleErrorOf(
      body(403, 'other', {}, [
        { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' },
      ])
    )
    for (const e of [byHeader, byInfo]) {
      expect(e.insufficientScope).toBe(true)
      const content = profileErrorOf(e).toContent().error
      expect(content.code).toBe('permission-denied')
      expect(content.message).not.toMatch(/https?:/)
    }
  })
})

describe('pages over Google’s pages', () => {
  // Google's pages, some short and one empty before the end
  const pages: Record<string, { items: number[]; next?: string }> = {
    first: { items: [0, 1, 2], next: 'b' },
    b: { items: [], next: 'c' },
    c: { items: [3, 4], next: 'd' },
    d: { items: [5] },
  }
  const fetchPage = async (t: string | undefined) => pages[t ?? 'first'] as { items: number[]; next?: string }

  it('fills each page from as many of Google’s as it takes, and answers no empty last page', async () => {
    const seen: number[][] = []
    let cursor: string | undefined
    do {
      const page = await fillPage(fetchPage, (n) => n, { limit: 2, ...(cursor ? { cursor } : {}) })
      seen.push(page.items)
      cursor = page.nextCursor
    } while (cursor)
    expect(seen).toEqual([
      [0, 1],
      [2, 3],
      [4, 5],
    ])
  })

  it('keeps only what the connector keeps, and refuses a cursor it never gave', async () => {
    const odd = await fillPage(fetchPage, (n) => (n % 2 ? n : undefined), { limit: 5 })
    expect(odd).toEqual({ items: [1, 3, 5] })
    await expect(fillPage(fetchPage, (n) => n, { limit: 2, cursor: 'garbage' })).rejects.toMatchObject({
      code: 'bad-cursor',
    })
  })
})
