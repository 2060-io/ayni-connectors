/**
 * What a run of the conformance kit needs of the in-memory provider (common §13), set up at its service by other
 * means: the two locations of each profile, the fixtures a profile cannot make, and the hooks that stop the service,
 * make it ask, and read its messages and its logs.
 */
import type { ConformanceOptions } from '@ayni.org/ayni-conformance'
import type { MemoryProvider } from './index.js'

export interface SetupOptions {
  /** what the provider logged, for FEAT-CORE-021 */
  logs?: () => string
  era?: ConformanceOptions['era']
  fetch?: typeof fetch
}

export function conformanceSetup(provider: MemoryProvider, url: string, opts: SetupOptions = {}): ConformanceOptions {
  const { service, files, calendar } = provider
  const [a, b, m, outside] = service.users
  if (!a || !b) throw new Error('the run needs two accounts at least')
  const account = (u: typeof a) => ({ headers: { authorization: `Bearer ${u.token}` }, address: u.email })

  let filesConformance: ConformanceOptions['files']
  if (files) {
    const first = files.seedFolder(files.homeOf(a.id), 'Conformance', a.id)
    const second = files.seedFolder(files.homeOf(b.id), 'Shared with Avery', b.id)
    const plan = files.seedFile(second, 'Budget plan.md', '# Budget plan\n', { by: b.id })
    files.seedShare(second, a.id, 'reader')
    const duplicates = files.seedFolder(first, 'Duplicates', a.id)
    files.seedFile(duplicates, 'a.txt', 'one', { by: a.id })
    files.seedFile(duplicates, 'a.txt', 'two', { by: a.id })
    const caps = files.options.capabilities
    filesConformance = {
      expect: [...caps],
      first: { ref: first, path: '/Conformance' },
      second: { ref: second, path: '/Shared with Avery' },
      fixtures: {
        link: files.seedLink(first, 'Shortcut to the plan', plan),
        native: files.seedFile(first, 'Meeting notes', '# Meeting notes\n\nThree points.', { native: true, by: a.id }),
        duplicates,
        ...(files.options.nativeConvertsText
          ? {}
          : { nativeNotConvertible: files.seedFile(first, 'Locked notes', '# Locked', { native: true, by: a.id }) }),
      },
    }
  }

  let calendarConformance: ConformanceOptions['calendar']
  if (calendar) {
    const first = calendar.primaryOf(a.id)
    const second = calendar.seedCalendar(b.id, 'Team Alpha', { readers: [a.id] })
    const caps = calendar.options.capabilities
    calendarConformance = {
      expect: [...caps],
      first: { ref: first },
      second: { ref: second },
      bCalendar: calendar.primaryOf(b.id),
      fixtures: {
        floating: {
          ref: calendar.seedEvent(first, {
            title: 'Floating breakfast',
            start: '2027-01-06T09:00:00',
            end: '2027-01-06T10:00:00',
            floating: true,
          }),
          start: '2027-01-06T09:00:00+01:00',
        },
        conference: calendar.seedEvent(first, {
          title: 'A call',
          start: '2027-01-07T15:00:00Z',
          end: '2027-01-07T16:00:00Z',
          meeting: { url: 'https://meet.memory.invalid/fixture', label: 'Memory Meet' },
        }),
        ...(caps.includes('recurrence')
          ? {}
          : {
              weeklySeries: {
                ref: calendar.seedEvent(first, {
                  title: 'A weekly fixture',
                  start: '2027-03-01T10:00:00+01:00',
                  end: '2027-03-01T11:00:00+01:00',
                  timeZone: 'Europe/Paris',
                  rule: 'FREQ=WEEKLY',
                }),
                from: '2027-02-28T00:00:00Z',
                to: '2027-03-28T00:00:00Z',
              },
            }),
        ...(caps.includes('attendees')
          ? {}
          : {
              invitation: calendar.seedEvent(first, {
                title: 'An invitation of Blake',
                start: '2027-01-08T09:00:00Z',
                end: '2027-01-08T10:00:00Z',
                organizer: b.id,
                attendees: [a.email],
              }),
            }),
      },
    }
  }

  return {
    url,
    accounts: { A: account(a), B: account(b), ...(m ? { M: account(m) } : {}) },
    ...(filesConformance ? { files: filesConformance } : {}),
    ...(calendarConformance ? { calendar: calendarConformance } : {}),
    organization: { noAccount: 'nobody@example.org', ...(outside ? { outside: outside.email } : {}) },
    hooks: {
      stopService: async () => {
        service.available = false
      },
      startService: async () => {
        service.available = true
      },
      askBeforeWrite: async (on) => {
        service.askBeforeWrite = on
      },
      messages: async (address) =>
        service.messagesTo(address).map((x) => ({ to: x.to, subject: x.subject, text: x.text })),
      ...(opts.logs ? { logs: async () => (opts.logs as () => string)() } : {}),
    },
    ...(opts.era ? { era: opts.era } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  }
}
