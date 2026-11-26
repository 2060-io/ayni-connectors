/**
 * The connector's account and where its credentials go (providers §1): the `Ayni-*` headers alone (FEAT-DAV-001), TLS
 * with the server's certificate checked, to the hosts of the request and no redirection followed (002), the hosts
 * checked once per request against private addresses unless the operator lists them (003), and nothing of a request
 * kept once it is answered (004).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hostPolicy, isPublicAddress, parseAddress, startNextcloudConnector } from '../src/index.js'
import { connect } from './client.js'
import { capture, headersOf, loopback, type Started, startRun } from './setup.js'
import { DavStub } from './stub/index.js'

describe('FEAT-DAV-001: the account from the Ayni headers alone', () => {
  let s: Started
  let plain: Started
  beforeAll(async () => {
    s = await startRun()
    plain = await startRun({ nextcloud: false })
  })
  afterAll(async () => {
    await s.close()
    await plain.close()
  })

  it('declares Files alone to Ayni-Dav-Files, Calendar alone to Ayni-Dav-Calendars, both to Ayni-Nextcloud', async () => {
    const h = headersOf(plain, 'ana')
    const filesOnly = await connect(plain.connector.url, {
      'Ayni-Dav-Files': h['Ayni-Dav-Files'] as string,
      'Ayni-Dav-Username': 'ana',
      'Ayni-Dav-Password': plain.passwords.ana as string,
    })
    expect(Object.keys(await filesOnly.declared())).toEqual(['org.ayni/files'])
    const calendarOnly = await connect(plain.connector.url, {
      'Ayni-Dav-Calendars': h['Ayni-Dav-Calendars'] as string,
      'Ayni-Dav-Username': 'ana',
      'Ayni-Dav-Password': plain.passwords.ana as string,
    })
    expect(Object.keys(await calendarOnly.declared())).toEqual(['org.ayni/calendar'])
    const nc = await connect(s.connector.url, headersOf(s, 'ana'))
    expect(Object.keys(await nc.declared()).sort()).toEqual(['org.ayni/calendar', 'org.ayni/files'])
    const none = await connect(s.connector.url, {})
    expect(await none.declared()).toEqual({})
    for (const c of [filesOnly, calendarOnly, nc, none]) await c.close()
  })

  it('answers account-refused to a call without the password, or without the user name', async () => {
    const cases: Record<string, string>[] = [
      { 'Ayni-Nextcloud': s.stub.origin(), 'Ayni-Dav-Username': 'ana' },
      { 'Ayni-Nextcloud': s.stub.origin(), 'Ayni-Dav-Password': s.passwords.ana as string },
    ]
    for (const headers of cases) {
      const c = await connect(s.connector.url, headers)
      expect((await c.err('files_roots', {})).code).toBe('account-refused')
      expect((await c.err('calendar_calendars', {})).code).toBe('account-refused')
      await c.close()
    }
  })

  it('answers account-refused to credentials the server refuses, with nothing of them in the answer', async () => {
    const c = await connect(s.connector.url, { ...headersOf(s, 'ana'), 'Ayni-Dav-Password': 'not-the-password-of-ana' })
    const e = await c.err('files_roots', {})
    expect(e.code).toBe('account-refused')
    expect(JSON.stringify(e)).not.toContain('not-the-password-of-ana')
    await c.close()
  })

  it('takes no credential given as an argument (FEAT-CORE-019)', async () => {
    const c = await connect(s.connector.url, headersOf(s, 'ana'))
    const e = await c.err('files_roots', { password: s.passwords.ana })
    expect([e.code, e.field]).toEqual(['invalid-argument', 'password'])
    await c.close()
  })

  it('refuses Ayni-Nextcloud given with an Ayni-Dav address, as ambiguous', async () => {
    const c = await connect(s.connector.url, {
      ...headersOf(s, 'ana'),
      'Ayni-Dav-Files': `${s.stub.origin()}/remote.php/dav/files/ana/`,
    })
    const e = await c.err('files_roots', {})
    expect([e.code, e.field]).toEqual(['invalid-argument', 'Ayni-Dav-Files'])
    await c.close()
  })
})

describe('FEAT-DAV-002: TLS, the hosts of the request, no redirection', () => {
  it('refuses an http address with invalid-argument, naming its header and no address', async () => {
    const s = await startRun({ nextcloud: false })
    const c = await connect(s.connector.url, {
      'Ayni-Dav-Files': `http://dav.test:${s.stub.port}/dav/files/ana/`,
      'Ayni-Dav-Username': 'ana',
      'Ayni-Dav-Password': s.passwords.ana as string,
    })
    const e = await c.err('files_roots', {})
    expect([e.code, e.field]).toEqual(['invalid-argument', 'Ayni-Dav-Files'])
    expect(String(e.message)).not.toMatch(/https?:\/\//)
    expect(s.stub.requests).toHaveLength(0)
    for (const bad of ['https://user:pw@dav.test/', 'https://dav.test/?q=1', 'https://dav.test/#x', 'ftp://dav.test/'])
      expect(parseAddress(bad, 'Ayni-Dav-Files')).not.toBeInstanceOf(URL)
    await c.close()
    await s.close()
  })

  it('sends the credentials once to a stub that redirects to another host, and nothing to the other host', async () => {
    const s = await startRun()
    const other = new DavStub({ names: ['other.test'], pki: s.stub.pki })
    await other.start()
    s.stub.redirects.set(
      '/ocs/v2.php/cloud/capabilities',
      `https://other.test:${other.port}/ocs/v2.php/cloud/capabilities`
    )
    const c = await connect(s.connector.url, headersOf(s, 'ana'))
    const e = await c.err('files_roots', {})
    expect(e.code).toBe('unavailable')
    const sent = s.stub.requests.filter((r) => r.path === '/ocs/v2.php/cloud/capabilities')
    expect(sent.length).toBeGreaterThan(0)
    expect(sent.every((r) => r.authorization)).toBe(true)
    expect(other.requests).toHaveLength(0)
    await c.close()
    await other.stop()
    await s.close()
  })

  it('checks the server certificate: a server of an authority not trusted gets no request, the call unavailable', async () => {
    const s = await startRun()
    const logs: string[] = []
    // a connector that does not trust the stub's authority
    const strict = await startNextcloudConnector({
      logger: capture(logs),
      policy: hostPolicy(['cloud.test']),
      resolve: loopback(['cloud.test']),
      port: 0,
      host: '127.0.0.1',
    })
    const c = await connect(strict.url, headersOf(s, 'ana'))
    expect((await c.err('files_roots', {})).code).toBe('unavailable')
    expect(s.stub.requests).toHaveLength(0)
    await c.close()
    await strict.running.close()
    await s.close()
  })
})

describe('FEAT-DAV-003: no private address unless the operator lists the host', () => {
  it('refuses https://10.0.0.5/ and a name that resolves to 127.0.0.1, and reaches a listed host', async () => {
    const s = await startRun()
    const unlisted = await startNextcloudConnector({
      policy: hostPolicy([]),
      resolve: loopback(['cloud.test']),
      ca: [s.stub.pki.ca],
      port: 0,
      host: '127.0.0.1',
    })
    for (const address of ['https://10.0.0.5/', s.stub.origin()]) {
      const c = await connect(unlisted.url, { ...headersOf(s, 'ana'), 'Ayni-Nextcloud': address })
      const e = await c.err('files_roots', {})
      expect([e.code, e.field]).toEqual(['invalid-argument', 'Ayni-Nextcloud'])
      await c.close()
    }
    expect(s.stub.requests).toHaveLength(0)
    // the listed host: the call is made
    const c = await connect(s.connector.url, headersOf(s, 'ana'))
    expect(((await c.ok('files_roots', {})).roots as unknown[]).length).toBeGreaterThan(0)
    await c.close()
    await unlisted.running.close()
    await s.close()
  })

  it('with DAV_HOSTS_ONLY, reaches the listed hosts alone, public ones refused', async () => {
    const s = await startRun()
    const only = await startNextcloudConnector({
      policy: hostPolicy(['cloud.test'], true),
      resolve: async () => [{ address: '93.184.215.14', family: 4 }],
      port: 0,
      host: '127.0.0.1',
    })
    const c = await connect(only.url, { ...headersOf(s, 'ana'), 'Ayni-Nextcloud': 'https://files.example.org' })
    expect((await c.err('files_roots', {})).code).toBe('invalid-argument')
    await c.close()
    await only.running.close()
    await s.close()
  })

  it('resolves each host once per request, and connects to the address it checked', async () => {
    const s = await startRun()
    const asked: string[] = []
    const counting = await startNextcloudConnector({
      policy: hostPolicy(['cloud.test']),
      resolve: async (host) => {
        asked.push(host)
        return [{ address: '127.0.0.1', family: 4 }]
      },
      ca: [s.stub.pki.ca],
      port: 0,
      host: '127.0.0.1',
    })
    const c = await connect(counting.url, headersOf(s, 'ana'))
    asked.length = 0
    const before = s.stub.requests.length
    await c.ok('files_list', { root: String(s.stub.folder('ana', ['Once'])) })
    expect(s.stub.requests.length - before).toBeGreaterThan(2)
    expect(asked).toEqual(['cloud.test'])
    await c.close()
    await counting.running.close()
    await s.close()
  })

  it('takes as public only public unicast addresses', () => {
    for (const a of ['93.184.215.14', '2606:4700:4700::1111', '1.1.1.1']) expect(isPublicAddress(a)).toBe(true)
    for (const a of [
      '127.0.0.1',
      '10.0.0.5',
      '172.16.3.4',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      '::',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
      '::ffff:127.0.0.1',
      '::ffff:a00:5',
      '64:ff9b::a00:5',
      '2001:db8::1',
      'ff02::1',
      'not-an-address',
    ])
      expect(isPublicAddress(a), a).toBe(false)
  })
})

describe('FEAT-DAV-004: nothing of a request kept once it is answered', () => {
  let s: Started
  beforeAll(async () => {
    s = await startRun()
  })
  afterAll(async () => s.close())

  it("answers a request with B's account nothing of A's, right after A's", async () => {
    const root = String(s.stub.folder('ana', ['Private']))
    s.stub.file('ana', ['Private', 'only-ana.txt'], 'secret of Ana')
    s.stub.file('ana', ['Private', 'only-ana-2.txt'], 'another secret of Ana')
    const a = await connect(s.connector.url, headersOf(s, 'ana'))
    const b = await connect(s.connector.url, headersOf(s, 'jonas'))
    const listed = await a.ok('files_list', { root, limit: 1 })
    expect((listed.items as unknown[]).length).toBe(1)
    expect((await b.err('files_list', { root })).code).toBe('not-found')
    // a cursor A was given is bound to A's account: B is refused it
    const e = await b.err('files_list', { root, limit: 1, cursor: listed.nextCursor })
    expect(e.code).toBe('bad-cursor')
    expect(JSON.stringify(e)).not.toContain('only-ana')
    await a.close()
    await b.close()
  })

  it('logs no password, no user name and no address, at its most verbose level', async () => {
    const a = await connect(s.connector.url, headersOf(s, 'ana'))
    await a.ok('files_roots', {})
    await a.ok('calendar_calendars', {})
    const text = s.logs.join('\n')
    expect(text.length).toBeGreaterThan(0)
    for (const secret of [s.passwords.ana as string, s.stub.origin(), 'cloud.test']) expect(text).not.toContain(secret)
    await a.close()
  })
})
