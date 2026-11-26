/**
 * A run of the conformance kit against the connector over the stub of Google (common §13): four fictional accounts of
 * one Google Workspace organization (`example.org`) and one outside it, the two locations of each profile, the items a
 * profile cannot make, put at the stub by other means (a shortcut, a Google Doc, a Google Sheet, two files of one
 * name, an event with Google Meet), and the hooks that stop the stub, read its messages and read what the connector
 * logged.
 */
import type { ConformanceOptions } from '@ayni.org/ayni-conformance'
import type { Logger } from '@ayni.org/ayni-provider-kit'
import { type GoogleConnector, startGoogleConnector } from '../src/index.js'
import { GoogleStub } from './stub/index.js'

export const PEOPLE = [
  { name: 'Avery Example', email: 'avery@example.org' },
  { name: 'Blake Example', email: 'blake@example.org' },
  { name: 'Morgan Example', email: 'morgan@example.org' },
  { name: 'Riley Partner', email: 'riley@partner.example' },
]

/** A logger that keeps every line, at its most verbose, to look for tokens in (FEAT-CORE-021). */
export function capture(lines: string[]): Logger {
  const write = (level: string) => (fields: Record<string, unknown>, message: string) =>
    lines.push(JSON.stringify({ level, message, ...fields }))
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') }
}

export interface Started {
  stub: GoogleStub
  connector: GoogleConnector & { running: { close(): Promise<void> }; url: string }
  logs: string[]
  /** every request the connector sent, by its fetch */
  sent: { url: string; authorization?: string }[]
  tokens: Record<'A' | 'B' | 'M' | 'R', string>
  close(): Promise<void>
}

/** The stub and the connector, each on a free port of 127.0.0.1. */
export async function startRun(): Promise<Started> {
  const stub = new GoogleStub(PEOPLE)
  await stub.start()
  const logs: string[] = []
  const sent: Started['sent'] = []
  const recording: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const headers = new Headers(init?.headers)
    sent.push({
      url,
      ...(headers.get('authorization') ? { authorization: headers.get('authorization') as string } : {}),
    })
    return fetch(input, init)
  }
  const connector = await startGoogleConnector({
    logger: capture(logs),
    testEndpoints: stub.endpoints(),
    fetch: recording,
  })
  const tokens = { A: stub.token('avery'), B: stub.token('blake'), M: stub.token('morgan'), R: stub.token('riley') }
  return {
    stub,
    connector,
    logs,
    sent,
    tokens,
    close: async () => {
      await connector.running.close()
      await stub.stop()
    },
  }
}

/** What the kit needs of a run: accounts, locations, fixtures, hooks. */
export function conformanceOptions(
  s: Started,
  opts: { era?: ConformanceOptions['era']; messages?: boolean; profiles?: ('files' | 'calendar')[] } = {}
): ConformanceOptions {
  const { stub, tokens } = s
  const profiles = opts.profiles ?? ['files', 'calendar']
  const [a, b, m] = ['avery', 'blake', 'morgan'].map((id) => stub.user(id)) as [
    ReturnType<GoogleStub['user']>,
    ReturnType<GoogleStub['user']>,
    ReturnType<GoogleStub['user']>,
  ]
  const account = (token: string, address: string) => ({ headers: { authorization: `Bearer ${token}` }, address })
  const d = stub.drive

  let files: ConformanceOptions['files']
  if (profiles.includes('files')) {
    const first = d.seedFolder(d.myDriveOf(a.id), 'Conformance', a.id)
    const second = d.seedFolder(d.myDriveOf(b.id), 'Shared with Avery', b.id)
    const plan = d.seedFile(second, 'Budget plan.md', '# Budget plan\n', b.id, 'text/markdown')
    d.seedShare(second, a.id, 'reader')
    const duplicates = d.seedFolder(first, 'Duplicates', a.id)
    d.seedFile(duplicates, 'a.txt', 'one', a.id)
    d.seedFile(duplicates, 'a.txt', 'two', a.id)
    files = {
      expect: ['search', 'folders', 'trash', 'share', 'versions', 'export', 'team-roots'],
      first: { ref: first, path: '/Conformance' },
      second: { ref: second, path: '/Shared with Avery' },
      fixtures: {
        link: d.seedShortcut(first, 'Shortcut to the plan', plan, a.id),
        native: d.seedDocument(first, 'Meeting notes', '# Meeting notes\n\nThree points.', a.id),
        nativeNotConvertible: d.seedDocument(
          first,
          'Locked figures',
          'a,b\n1,2\n',
          a.id,
          'application/vnd.google-apps.spreadsheet'
        ),
        duplicates,
      },
    }
  }

  let calendar: ConformanceOptions['calendar']
  if (profiles.includes('calendar')) {
    const c = stub.calendar
    const first = c.primaryOf(a)
    const second = c.seedCalendar(b, 'Team Alpha', [{ userId: a.id, role: 'reader' }])
    calendar = {
      expect: ['free-busy', 'recurrence', 'attendees', 'respond', 'meeting'],
      first: { ref: first },
      second: { ref: second },
      bCalendar: c.primaryOf(b),
      fixtures: {
        // Google keeps no floating time: every dateTime it answers carries an offset, so the fixture does not apply
        conference: c.seedEvent(first, {
          summary: 'A call',
          start: '2027-01-07T15:00:00Z',
          end: '2027-01-07T16:00:00Z',
          conference: true,
        }),
      },
    }
  }

  return {
    url: s.connector.url,
    accounts: { A: account(tokens.A, a.email), B: account(tokens.B, b.email), M: account(tokens.M, m.email) },
    ...(files ? { files } : {}),
    ...(calendar ? { calendar } : {}),
    organization: { noAccount: 'nobody@example.org', outside: 'riley@partner.example' },
    hooks: {
      stopService: async () => {
        stub.available = false
      },
      startService: async () => {
        stub.available = true
      },
      ...(opts.messages
        ? {
            messages: async (address: string) =>
              stub.messagesTo(address).map((x) => ({ to: x.to, subject: x.subject, text: x.text })),
          }
        : {}),
      logs: async () => s.logs.join('\n'),
    },
    ...(opts.era ? { era: opts.era } : {}),
  }
}
