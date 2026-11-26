/**
 * The connector as a resource server and a connector (TOOL-OAUTH-018, FEAT-CORE-021, common §11): its Protected
 * Resource Metadata names Google's authorization server and a request without a token gets the 401 that points to it;
 * the token of a call goes to Google's interfaces alone (or, in a test, to the stub alone), is never logged, and never
 * follows a redirection; no configuration points it at another host.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createGoogleConnector,
  GOOGLE_AUTHORIZATION_SERVER,
  GOOGLE_ENDPOINTS,
  isGoogleEndpoint,
  isLoopbackEndpoint,
  startGoogleConnector,
} from '../src/index.js'
import { connect } from './client.js'
import { capture, type Started, startRun } from './setup.js'

describe('Protected Resource Metadata and the 401', () => {
  let s: Started
  beforeAll(async () => {
    s = await startRun()
  })
  afterAll(async () => s.close())

  it('names Google’s authorization server and the MCP address as the resource', async () => {
    const meta = await (await fetch(new URL('/.well-known/oauth-protected-resource/mcp', s.connector.url))).json()
    expect(meta).toEqual({
      resource: s.connector.url,
      authorization_servers: [GOOGLE_AUTHORIZATION_SERVER],
      bearer_methods_supported: ['header'],
      resource_name: 'Ayni connector for Google Drive and Google Calendar',
    })
    expect(GOOGLE_AUTHORIZATION_SERVER).toBe('https://accounts.google.com')
  })

  it('answers a request without a token 401, with the pointer to the metadata, and reaches no Google', async () => {
    const before = s.stub.requests.length
    const res = await fetch(s.connector.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${new URL('/.well-known/oauth-protected-resource/mcp', s.connector.url)}"`
    )
    expect(s.stub.requests.length).toBe(before)
    expect((await fetch(new URL('/healthz', s.connector.url))).status).toBe(200)
  })

  it('answers account-refused when Google refuses the token, and never names it', async () => {
    const c = await connect(s.connector.url, 'ya29.not-a-token-of-the-stub')
    const e = await c.err('files_roots', {})
    expect(e.code).toBe('account-refused')
    expect(JSON.stringify(e)).not.toContain('not-a-token-of-the-stub')
    await c.close()
  })

  it('sends each token to the stub alone, for its own account, and logs none of them', async () => {
    const a = await connect(s.connector.url, s.tokens.A)
    const b = await connect(s.connector.url, s.tokens.B)
    const rootsA = await a.ok('files_roots', {})
    const rootsB = await b.ok('files_roots', {})
    expect(JSON.stringify(rootsA)).not.toBe(JSON.stringify(rootsB))
    await a.ok('calendar_calendars', {})
    await a.close()
    await b.close()
    expect(s.sent.length).toBeGreaterThan(0)
    const base = new URL(s.stub.base).origin
    for (const r of s.sent) {
      expect(new URL(r.url).origin).toBe(base)
      // each request carries the token of the call that made it, and nothing else of an account
      expect([`Bearer ${s.tokens.A}`, `Bearer ${s.tokens.B}`, 'Bearer ya29.not-a-token-of-the-stub']).toContain(
        r.authorization
      )
    }
    const log = s.logs.join('\n')
    for (const t of Object.values(s.tokens)) expect(log).not.toContain(t)
    expect(log).toContain('google request')
  })
})

describe('where a token may go', () => {
  it('takes Google’s interfaces, and a test’s stub on a loopback address only', () => {
    for (const api of ['drive', 'upload', 'calendar'] as const)
      expect(isGoogleEndpoint(api, GOOGLE_ENDPOINTS[api])).toBe(true)
    expect(isGoogleEndpoint('drive', 'http://www.googleapis.com/drive/v3')).toBe(false)
    expect(isGoogleEndpoint('drive', 'https://www.googleapis.com.example.org/drive/v3')).toBe(false)
    expect(isGoogleEndpoint('drive', 'https://www.googleapis.com:8443/drive/v3')).toBe(false)
    expect(isGoogleEndpoint('drive', 'https://www.googleapis.com/calendar/v3')).toBe(false)
    expect(isGoogleEndpoint('drive', 'https://user@www.googleapis.com/drive/v3')).toBe(false)
    expect(isLoopbackEndpoint('http://127.0.0.1:9000/drive/v3')).toBe(true)
    expect(isLoopbackEndpoint('http://10.0.0.5/drive/v3')).toBe(false)
    expect(() => createGoogleConnector({ testEndpoints: { drive: 'https://drive.example.org/drive/v3' } })).toThrow(
      /sends tokens to Google only/
    )
    expect(() => createGoogleConnector({ testEndpoints: { calendar: 'http://10.0.0.5/calendar/v3' } })).toThrow()
    expect(
      createGoogleConnector({ testEndpoints: { drive: 'https://www.googleapis.com/drive/v3' } }).endpoints
    ).toEqual(GOOGLE_ENDPOINTS)
    expect(createGoogleConnector().endpoints).toEqual(GOOGLE_ENDPOINTS)
  })

  it('reaches https://www.googleapis.com when no test gives a stub, and follows no redirection', async () => {
    const seen: { url: string; redirect?: RequestInit['redirect'] }[] = []
    const fake: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      seen.push({ url, ...(init?.redirect ? { redirect: init.redirect } : {}) })
      // Google moves the request elsewhere: the connector does not follow
      return new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.org/capture' } })
    }
    const lines: string[] = []
    const connector = await startGoogleConnector({ fetch: fake, logger: capture(lines) })
    try {
      const c = await connect(connector.url, 'ya29.token-of-a-test')
      const e = await c.err('files_roots', {})
      expect(e.code).toBe('unavailable')
      const cal = await c.err('calendar_calendars', {})
      expect(cal.code).toBe('unavailable')
      await c.close()
    } finally {
      await connector.running.close()
    }
    expect(seen.map((x) => new URL(x.url).origin)).toEqual(['https://www.googleapis.com', 'https://www.googleapis.com'])
    expect(seen[0]?.url.startsWith(`${GOOGLE_ENDPOINTS.drive}/files/root?`)).toBe(true)
    expect(seen[1]?.url.startsWith(`${GOOGLE_ENDPOINTS.calendar}/users/me/calendarList?`)).toBe(true)
    expect(seen.every((x) => x.redirect === 'manual')).toBe(true)
    expect(lines.join('\n')).not.toContain('token-of-a-test')
  })
})
