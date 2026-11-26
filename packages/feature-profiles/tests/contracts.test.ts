import {
  annotationsOf,
  CALENDAR_PROFILE,
  type CalendarDeclaration,
  checkCall,
  DEFAULT_RULE_OF_EFFECT,
  dropForeignItems,
  effectOfCall,
  FILES_PROFILE,
  type FilesDeclaration,
  formatRule,
  inputSchemaFor,
  insideDomains,
  isCompatibleVersion,
  mcpToolsFor,
  parseRule,
  toolOf,
  validateDeclaration,
  validateErrorContent,
  validateResult,
} from '@ayni.org/ayni-feature-profiles'
import { describe, expect, it } from 'vitest'

const files = (capabilities: FilesDeclaration['capabilities'], more: Partial<FilesDeclaration> = {}) =>
  ({ version: '1.0', capabilities, ...more }) as FilesDeclaration & Record<string, unknown>
const calendar = (capabilities: CalendarDeclaration['capabilities']) =>
  ({ version: '1.0', capabilities }) as CalendarDeclaration & Record<string, unknown>

describe('tools for a set of capabilities', () => {
  it('lists the core, then the tools of each capability in use, in the profile order', () => {
    expect(mcpToolsFor(FILES_PROFILE, []).map((t) => t.name)).toEqual([
      'files_roots',
      'files_list',
      'files_get',
      'files_read',
      'files_create',
      'files_replace',
    ])
    expect(
      mcpToolsFor(FILES_PROFILE, ['trash', 'search'])
        .map((t) => t.name)
        .slice(6)
    ).toEqual(['files_search', 'files_trash', 'files_restore', 'files_list_trash'])
  })

  it('leaves the arguments and values of a capability not in use out of the schemas', () => {
    const create = toolOf(CALENDAR_PROFILE, 'calendar_create_event')
    if (!create) throw new Error('no tool')
    const core = inputSchemaFor(create, []) as { properties: Record<string, unknown> }
    expect(Object.keys(core.properties)).not.toContain('attendees')
    expect(Object.keys(core.properties)).not.toContain('rule')
    const all = inputSchemaFor(create, ['attendees', 'recurrence', 'meeting']) as {
      properties: Record<string, unknown>
    }
    expect(Object.keys(all.properties)).toEqual(expect.arrayContaining(['attendees', 'notify', 'rule', 'meeting']))
    const share = toolOf(FILES_PROFILE, 'files_share')
    if (!share) throw new Error('no tool')
    const roles = (s: unknown) => (s as { properties: { role: { enum: string[] } } }).properties.role.enum
    expect(roles(inputSchemaFor(share, ['share']))).toEqual(['reader', 'editor'])
    expect(roles(inputSchemaFor(share, ['share', 'team-roots']))).toEqual(['reader', 'editor', 'manager'])
  })

  it('gives the same bytes for the same capabilities, whatever their order', () => {
    expect(JSON.stringify(mcpToolsFor(FILES_PROFILE, ['folders', 'search']))).toBe(
      JSON.stringify(mcpToolsFor(FILES_PROFILE, ['search', 'folders']))
    )
  })

  it('puts the title of each argument in its schema, and the hints of the effect', () => {
    const [roots] = mcpToolsFor(FILES_PROFILE, [])
    expect((roots!.inputSchema as { properties: { query: { title: string } } }).properties.query.title).toBe(
      'Path begins with'
    )
    expect(annotationsOf('delete')).toEqual({ readOnlyHint: false, destructiveHint: true })
    expect(DEFAULT_RULE_OF_EFFECT.external).toBe('approval')
  })
})

describe('checks of a call', () => {
  it('refuses an argument the profile does not know with invalid-argument naming it (FEAT-CORE-005)', () => {
    expect(checkCall(FILES_PROFILE, 'files_list', { root: 'r', colour: 'red' }, files([]))).toMatchObject({
      code: 'invalid-argument',
      field: 'colour',
    })
  })

  it('refuses an argument of a capability not declared with not-supported naming it (FEAT-CORE-005)', () => {
    const args = {
      calendar: 'c',
      title: 'x',
      start: '2026-11-23T10:00:00Z',
      end: '2026-11-23T11:00:00Z',
      rule: 'FREQ=DAILY',
    }
    expect(checkCall(CALENDAR_PROFILE, 'calendar_create_event', args, calendar([]))).toMatchObject({
      code: 'not-supported',
      field: 'rule',
    })
  })

  it('refuses a value of a capability or of a declaration part not declared with not-supported', () => {
    const base = { root: 'r', ref: 'f' }
    expect(
      checkCall(
        FILES_PROFILE,
        'files_share',
        { ...base, role: 'manager', recipients: [{ address: 'a@example.org' }] },
        files(['share'])
      )
    ).toMatchObject({ code: 'not-supported', field: 'role' })
    expect(
      checkCall(
        FILES_PROFILE,
        'files_share',
        { ...base, role: 'reader', audience: 'anyone' },
        files(['share'], { share: { audiences: ['organization'], notify: true } })
      )
    ).toMatchObject({ code: 'not-supported', field: 'audience' })
    expect(
      checkCall(
        FILES_PROFILE,
        'files_share',
        { ...base, role: 'reader', recipients: [{ address: 'a@example.org' }], notify: true },
        files(['share'], { share: { audiences: [], notify: false } })
      )
    ).toMatchObject({ code: 'not-supported', field: 'notify' })
    expect(
      checkCall(
        FILES_PROFILE,
        'files_search',
        { root: 'r', query: 'q', in: 'content' },
        files(['search'], { search: { content: false } })
      )
    ).toMatchObject({ code: 'not-supported', field: 'in' })
  })

  it('checks bounds and the rules between arguments', () => {
    expect(checkCall(FILES_PROFILE, 'files_list', { root: 'r', limit: 0 }, files([]))).toMatchObject({ field: 'limit' })
    expect(checkCall(FILES_PROFILE, 'files_list', { root: 'r', limit: 101 }, files([]))).toMatchObject({
      field: 'limit',
    })
    expect(checkCall(FILES_PROFILE, 'files_list', {}, files([]))).toMatchObject({
      code: 'invalid-argument',
      field: 'root',
    })
    expect(
      checkCall(FILES_PROFILE, 'files_create', { root: 'r', name: 'a/b.txt', content: { text: '' } }, files([]))
    ).toMatchObject({ field: 'name' })
    expect(
      checkCall(FILES_PROFILE, 'files_create', { root: 'r', name: '..', content: { text: '' } }, files([]))
    ).toMatchObject({ field: 'name' })
    expect(
      checkCall(FILES_PROFILE, 'files_replace', { root: 'r', ref: 'f', content: { text: '' } }, files([]))
    ).toMatchObject({ field: 'ifVersion' })
    expect(checkCall(FILES_PROFILE, 'files_move', { root: 'r', ref: 'f' }, files(['folders']))).toMatchObject({
      code: 'invalid-argument',
    })
    const addresses = Array.from({ length: 21 }, (_, i) => ({ address: `p${i}@example.org` }))
    expect(
      checkCall(
        FILES_PROFILE,
        'files_share',
        { root: 'r', ref: 'f', role: 'reader', recipients: addresses },
        files(['share'])
      )
    ).toMatchObject({ field: 'recipients' })
    expect(
      checkCall(FILES_PROFILE, 'files_share', { root: 'r', ref: 'f', role: 'reader' }, files(['share']))
    ).toMatchObject({ field: 'recipients' })
  })

  it('checks the times of Calendar (FEAT-CAL-004, 008, 014, 021, 030)', () => {
    const c = calendar(['recurrence', 'free-busy'])
    const list = (from: string, to: string) =>
      checkCall(CALENDAR_PROFILE, 'calendar_list_events', { calendar: 'c', from, to }, c)
    expect(list('2026-01-01T00:00:00Z', '2027-02-05T00:00:00Z')).toMatchObject({ field: 'to' })
    expect(list('2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')).toMatchObject({ field: 'to' })
    expect(list('2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z')).toBeUndefined()
    const fb = checkCall(
      CALENDAR_PROFILE,
      'calendar_free_busy',
      { calendar: 'c', from: '2026-01-01T00:00:00Z', to: '2026-03-05T00:00:00Z' },
      c
    )
    expect(fb).toMatchObject({ field: 'to' })
    const create = (more: Record<string, unknown>) =>
      checkCall(
        CALENDAR_PROFILE,
        'calendar_create_event',
        { calendar: 'c', title: 't', start: '2026-11-23T10:00:00+01:00', end: '2026-11-23T11:00:00+01:00', ...more },
        c
      )
    expect(create({})).toBeUndefined()
    expect(create({ end: '2026-11-23T10:00:00+01:00' })).toMatchObject({ field: 'end' })
    expect(create({ timeZone: 'Mars/Olympus' })).toMatchObject({ field: 'timeZone' })
    expect(create({ rule: 'FREQ=WEEKLY;BYDAY=MO' })).toMatchObject({ code: 'invalid-argument', field: 'timeZone' })
    expect(create({ rule: 'FREQ=SECONDLY', timeZone: 'Europe/Paris' })).toMatchObject({
      code: 'not-supported',
      field: 'rule',
    })
    expect(create({ allDay: true })).toMatchObject({ field: 'start' })
    expect(create({ allDay: true, start: '2026-11-23', end: '2026-11-24' })).toBeUndefined()
    expect(create({ title: 'x'.repeat(1025) })).toMatchObject({ field: 'title' })
    const update = checkCall(
      CALENDAR_PROFILE,
      'calendar_update_event',
      { calendar: 'c', ref: 'e', start: '2026-11-23T10:00:00Z' },
      c
    )
    expect(update).toMatchObject({ code: 'invalid-argument', field: 'start' })
  })
})

describe('rules of repetition (calendar §4.2)', () => {
  it('takes the part of RRULE of Calendar 1.0 and refuses the rest', () => {
    expect(parseRule('FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10')).toEqual({
      rule: { freq: 'WEEKLY', byDay: [{ day: 'MO' }, { day: 'WE' }], count: 10 },
    })
    expect(parseRule('FREQ=MONTHLY;BYDAY=-1FR')).toMatchObject({ rule: { byDay: [{ day: 'FR', rank: -1 }] } })
    expect(parseRule('FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=1')).toMatchObject({ rule: { byMonth: 3, byMonthDay: 1 } })
    for (const r of [
      'FREQ=SECONDLY',
      'FREQ=DAILY;BYHOUR=9',
      'FREQ=MONTHLY;BYDAY=MO,TU',
      'FREQ=DAILY;COUNT=2;UNTIL=20261231',
    ])
      expect(parseRule(r), r).toMatchObject({ error: 'not-supported' })
    for (const r of ['FREQ=FOO', 'BYDAY=MO', 'FREQ=DAILY;COUNT=0', 'nonsense'])
      expect(parseRule(r), r).toMatchObject({ error: 'invalid-argument' })
    const p = parseRule('freq=weekly;interval=2;byday=mo')
    expect('rule' in p && formatRule(p.rule)).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO')
  })
})

describe('effects of a call (common §10)', () => {
  const inside = insideDomains(['example.org'])
  it('is external once an address is outside the organization, or for audience anyone', () => {
    const share = toolOf(FILES_PROFILE, 'files_share')
    const create = toolOf(CALENDAR_PROFILE, 'calendar_create_event')
    if (!share || !create) throw new Error('no tool')
    expect(effectOfCall(share, { recipients: [{ address: 'b@EXAMPLE.org' }] }, inside).effect).toBe('write')
    expect(effectOfCall(share, { recipients: [{ address: 'p@partner.example' }] }, inside)).toEqual({
      effect: 'external',
      outsideOrganization: ['p@partner.example'],
    })
    expect(effectOfCall(share, { audience: 'anyone' }, inside).effect).toBe('external')
    expect(effectOfCall(share, { audience: 'organization' }, inside).effect).toBe('write')
    expect(effectOfCall(create, { attendees: [{ address: 'p@partner.example' }] }, inside).effect).toBe('external')
    expect(effectOfCall(create, { attendees: [{ address: 'a@example.org' }] }, insideDomains(undefined)).effect).toBe(
      'external'
    )
  })
})

describe('results, errors and declarations', () => {
  it('validates results against the profile, members present only when true included', () => {
    const item = {
      ref: 'f1',
      root: 'r',
      kind: 'file',
      name: 'a.md',
      path: '/a.md',
      parent: 'r',
      mediaType: 'text/markdown',
      version: 'v1',
    }
    expect(validateResult(FILES_PROFILE, 'files_get', { item })).toEqual([])
    expect(validateResult(FILES_PROFILE, 'files_get', { item: { ...item, native: false } }).length).toBeGreaterThan(0)
    expect(
      validateResult(FILES_PROFILE, 'files_get', { item: { ...item, version: undefined } }).length
    ).toBeGreaterThan(0)
    expect(validateResult(FILES_PROFILE, 'files_get', { item: { ...item, x_store: 1 } })).toEqual([])
  })

  it('validates errors with the members of their code', () => {
    expect(validateErrorContent(FILES_PROFILE, { error: { code: 'not-found', message: 'No such item.' } })).toEqual([])
    expect(
      validateErrorContent(FILES_PROFILE, { error: { code: 'version-mismatch', message: 'Changed.' } }).length
    ).toBeGreaterThan(0)
    expect(
      validateErrorContent(FILES_PROFILE, { error: { code: 'recipient-refused', message: 'No.' } }).length
    ).toBeGreaterThan(0)
  })

  it('validates declarations, their limits and the capabilities a capability requires', () => {
    expect(validateDeclaration(FILES_PROFILE, { version: '1.0', capabilities: ['folders'] })).toEqual([])
    expect(validateDeclaration(FILES_PROFILE, { version: '1.0', capabilities: ['team-roots'] })).toHaveLength(1)
    expect(validateDeclaration(FILES_PROFILE, { version: '1.0', capabilities: ['colour'] })).toHaveLength(1)
    expect(validateDeclaration(FILES_PROFILE, { version: '1.1', capabilities: ['colour'] })).toEqual([])
    expect(
      validateDeclaration(FILES_PROFILE, { version: '1.0', capabilities: [], limits: { page: 10 } }).length
    ).toBeGreaterThan(0)
    expect(validateDeclaration(CALENDAR_PROFILE, { version: '1.0', capabilities: ['meeting'] })).toHaveLength(1)
    expect(
      validateDeclaration(CALENDAR_PROFILE, { version: '1.0', capabilities: ['meeting'], meeting: { label: 'Meet' } })
    ).toEqual([])
    expect(isCompatibleVersion('1.0', '1.3')).toBe(true)
    expect(isCompatibleVersion('1.0', '2.0')).toBe(false)
  })

  it('drops the items of a result that do not carry the location of the call (TOOL-FEAT-015)', () => {
    const a = { ref: '1', root: 'r', kind: 'folder', name: 'a', path: '/a' }
    const b = { ...a, ref: '2', root: 'other' }
    expect(
      dropForeignItems(FILES_PROFILE, 'files_list', { root: 'r' }, { folder: { ...a, path: '/' }, items: [a, b] })
    ).toMatchObject({ dropped: 1 })
    expect(dropForeignItems(FILES_PROFILE, 'files_get', { root: 'r' }, { item: b })).toBeUndefined()
  })
})
