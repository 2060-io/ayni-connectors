/**
 * A run of the conformance kit against the connector over a stub (common §13): three accounts of one organization
 * (`example.org`), people of the spec's examples (Ana, Jonas) and the managing account (agent D150), each with a
 * password made for the run; the two locations of each profile; the items a profile cannot make, put at the stub by
 * other means (a floating event, an event with a CONFERENCE); and the hooks that stop the stub, read its messages and
 * read what the connector logged. The stub is a Nextcloud or a plain WebDAV and CalDAV server.
 */
import { randomBytes } from 'node:crypto'
import type { ConformanceOptions } from '@ayni.org/ayni-conformance'
import type { Logger } from '@ayni.org/ayni-provider-kit'
import { hostPolicy, type NextcloudConnector, type Resolve, startNextcloudConnector } from '../src/index.js'
import { DavStub, type StubOptions } from './stub/index.js'

export const PEOPLE = [
  { id: 'ana', name: 'Ana Example', email: 'ana@example.org' },
  { id: 'jonas', name: 'Jonas Example', email: 'jonas@example.org' },
  { id: 'ayni-manager', name: 'Ayni Manager', email: 'ayni-manager@example.org', groups: ['admin'] },
] as const

export const OUTSIDE = 'piet@partner.example'
export const NO_ACCOUNT = 'nobody@example.org'

/** A logger that keeps every line, at its most verbose, to look for credentials in (FEAT-CORE-021). */
export function capture(lines: string[]): Logger {
  const write = (level: string) => (fields: Record<string, unknown>, message: string) =>
    lines.push(JSON.stringify({ level, message, ...fields }))
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') }
}

/** The test's resolver: every name of the stubs is 127.0.0.1, which the operator lists (FEAT-DAV-003). */
export const loopback =
  (names: string[]): Resolve =>
  async (host) => {
    if (names.includes(host)) return [{ address: '127.0.0.1', family: 4 }]
    throw new Error(`no such host ${host}`)
  }

export interface Started {
  stub: DavStub
  connector: NextcloudConnector & { running: { close(): Promise<void> }; url: string }
  logs: string[]
  passwords: Record<string, string>
  close(): Promise<void>
}

export const password = () => randomBytes(18).toString('base64url')

/** The stub and the connector, each on a free port of 127.0.0.1. */
export async function startRun(options: StubOptions = {}, connectorNames?: string[]): Promise<Started> {
  const stub = new DavStub(options)
  const passwords: Record<string, string> = {}
  for (const p of PEOPLE) {
    passwords[p.id] = password()
    stub.addUser({ ...p, groups: [...('groups' in p ? p.groups : [])], password: passwords[p.id] as string })
  }
  await stub.start()
  const logs: string[] = []
  const names = connectorNames ?? [...stub.o.names, 'other.test']
  const connector = await startNextcloudConnector({
    logger: capture(logs),
    policy: hostPolicy(names),
    resolve: loopback(names),
    ca: [stub.pki.ca],
    port: 0,
    host: '127.0.0.1',
  })
  return {
    stub,
    connector,
    logs,
    passwords,
    close: async () => {
      await connector.running.close()
      await stub.stop()
    },
  }
}

/** The headers of an account at the stub: a Nextcloud's address, or the plain server's two addresses. */
export function headersOf(s: Started, id: string, plainCalendars?: string): Record<string, string> {
  const creds = { 'Ayni-Dav-Username': id, 'Ayni-Dav-Password': s.passwords[id] as string }
  if (s.stub.o.nextcloud) return { 'Ayni-Nextcloud': s.stub.origin(), ...creds }
  return {
    'Ayni-Dav-Files': `${s.stub.origin()}/dav/files/${id}/`,
    'Ayni-Dav-Calendars': plainCalendars ?? `${s.stub.origin()}/dav/calendars/${id}/`,
    ...creds,
  }
}

const FLOATING =
  'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Ayni//stub//EN\r\nBEGIN:VEVENT\r\nUID:floating-1\r\nDTSTAMP:20261101T000000Z\r\nDTSTART:20270112T090000\r\nDTEND:20270112T100000\r\nSUMMARY:A floating morning\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'
const CONFERENCE =
  'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Ayni//stub//EN\r\nBEGIN:VEVENT\r\nUID:conference-1\r\nDTSTAMP:20261101T000000Z\r\nDTSTART:20270114T150000Z\r\nDTEND:20270114T160000Z\r\nSUMMARY:A call\r\nCONFERENCE;VALUE=URI;FEATURE=VIDEO;LABEL=Talk:https://cloud.example.org/call/abc123\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'

/** What the kit needs of a run: accounts, locations, fixtures, hooks. */
export function conformanceOptions(
  s: Started,
  opts: {
    era?: ConformanceOptions['era']
    messages?: boolean
    profiles?: ('files' | 'calendar')[]
    plainCalendars?: string
  } = {}
): ConformanceOptions {
  const { stub } = s
  const nc = stub.o.nextcloud
  const profiles = opts.profiles ?? ['files', 'calendar']
  const account = (id: string, email: string) => ({
    headers: headersOf(s, id, opts.plainCalendars?.replace('{origin}', s.stub.origin()).replace('{id}', id)),
    address: email,
    secrets: [s.passwords[id] as string],
  })

  let files: ConformanceOptions['files']
  if (profiles.includes('files')) {
    const first = stub.folder('ana', ['Conformance'])
    let second: { ref: string; path: string }
    if (nc) {
      // a folder of Jonas's shared with Ana to read, mounted in her tree (providers §5)
      const id = stub.folder('jonas', ['Shared with Ana'])
      stub.file('jonas', ['Shared with Ana', 'Budget plan.md'], '# Budget plan\n')
      stub.shareWith('jonas', ['Shared with Ana'], 'ana', 1)
      second = { ref: String(id), path: '/Shared with Ana' }
    } else {
      // a plain server knows no other account's folder: a second folder of Ana's own
      stub.folder('ana', ['Second'])
      stub.file('ana', ['Second', 'Budget plan.md'], '# Budget plan\n')
      second = { ref: '/Second', path: '/Second' }
    }
    files = {
      expect: nc
        ? ['search', 'folders', 'trash', 'share', 'versions']
        : ['folders', ...(stub.o.dasl ? (['search'] as const) : [])],
      first: { ref: nc ? String(first) : '/Conformance', path: '/Conformance' },
      second,
    }
  }

  let calendar: ConformanceOptions['calendar']
  if (profiles.includes('calendar')) {
    const st = stub.store
    const personal = st.calendarOf('ana', 'personal')
    if (personal) personal.timezone = 'Europe/Paris'
    const team = st.calendar('jonas', 'team-alpha', 'Team Alpha')
    team.sharedWith.set('ana', false)
    st.calendar('ana', 'tasks', 'Tasks').components = ['VTODO']
    const dav = nc ? '/remote.php/dav/' : '/dav/'
    personal?.objects.set('floating-1.ics', { ...st.object(FLOATING), name: 'floating-1.ics' })
    personal?.objects.set('conference-1.ics', { ...st.object(CONFERENCE), name: 'conference-1.ics' })
    const first = `${dav}calendars/ana/personal/`
    calendar = {
      expect: stub.o.scheduling ? ['free-busy', 'recurrence', 'attendees', 'respond'] : ['free-busy', 'recurrence'],
      first: { ref: first },
      second: { ref: `${dav}calendars/ana/team-alpha_shared_by_jonas/` },
      bCalendar: `${dav}calendars/jonas/personal/`,
      fixtures: {
        floating: { ref: `${first}floating-1.ics`, start: '2027-01-12T09:00:00+01:00' },
        conference: `${first}conference-1.ics`,
      },
    }
  }

  return {
    url: s.connector.url,
    accounts: {
      A: account('ana', 'ana@example.org'),
      B: account('jonas', 'jonas@example.org'),
      ...(nc ? { M: account('ayni-manager', 'ayni-manager@example.org') } : {}),
    },
    ...(files ? { files } : {}),
    ...(calendar ? { calendar } : {}),
    // an address outside: no account of a Nextcloud, which answers no-account for it (FEAT-NC-010), never not-allowed
    organization: { noAccount: NO_ACCOUNT },
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
