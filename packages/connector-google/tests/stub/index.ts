/**
 * A stub of Google's interfaces for the connector's tests: the Drive API v3 at `/drive/v3`, its uploads at
 * `/upload/drive/v3` and the Calendar API v3 at `/calendar/v3`, served on `127.0.0.1` over HTTP. It checks each
 * request's bearer token and the scopes of the method (Google's references give the scopes each method takes), keeps
 * every request it received (to check that a token went nowhere else), the messages Google would send (shares,
 * invitations, changes, cancellations, answers), and can stop, or ask to wait, as Google does. No test of this package
 * reaches Google or any other service.
 */
import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { GoogleEndpoints } from '../../src/endpoints.js'
import { StubCalendar } from './calendar.js'
import {
  ALL_SCOPES,
  type Caller,
  digits,
  gerror,
  insufficientScope,
  SCOPE,
  type SentMessage,
  StubError,
  type StubRequest,
  type StubUser,
  unauthenticated,
} from './core.js'
import { StubDrive } from './drive.js'

export { ALL_SCOPES, SCOPE, type SentMessage, type StubUser } from './core.js'

/** The scopes each method takes, any one of them (the "Authorization scopes" of each method's reference). */
const READ_DRIVE = ['drive', 'drive.readonly']
const WRITE_DRIVE = ['drive']
const READ_CALENDAR_LIST = ['calendar', 'calendar.readonly', 'calendar.calendarlist', 'calendar.calendarlist.readonly']
const READ_EVENTS = [
  'calendar',
  'calendar.readonly',
  'calendar.events',
  'calendar.events.readonly',
  'calendar.events.owned',
  'calendar.events.owned.readonly',
]
const WRITE_EVENTS = ['calendar', 'calendar.events', 'calendar.events.owned']
const FREE_BUSY = ['calendar', 'calendar.readonly', 'calendar.events.freebusy', 'calendar.freebusy']

function scopesOf(api: string, method: string, parts: string[]): string[] {
  if (api === 'upload') return WRITE_DRIVE
  if (api === 'drive') return method === 'GET' ? READ_DRIVE : WRITE_DRIVE
  if (parts[0] === 'users') return READ_CALENDAR_LIST
  if (parts[0] === 'freeBusy') return FREE_BUSY
  return method === 'GET' ? READ_EVENTS : WRITE_EVENTS
}

export interface RecordedRequest {
  method: string
  host: string
  path: string
  authorization?: string
}

export interface StubOptions {
  /** the domain of the organization at Google: its people share drives with each other */
  organization?: string
  /** the zone the stub's calendars are in, and in which it writes `dateTime` */
  calendarZone?: string
}

export class GoogleStub {
  public readonly users: StubUser[] = []
  public readonly drive: StubDrive
  public readonly calendar: StubCalendar
  public readonly outbox: SentMessage[] = []
  public readonly requests: RecordedRequest[] = []
  /** false: every request answers 503, as Google does when it fails */
  public available = true
  private readonly tokens = new Map<string, Caller>()
  private rateLimited: { count: number; retryAfter?: number } = { count: 0 }
  private server?: Server
  public base = ''

  public constructor(people: { name: string; email: string; canCreateDrives?: boolean }[], options: StubOptions = {}) {
    for (const p of people)
      this.users.push({
        id: p.email.split('@')[0] as string,
        name: p.name,
        email: p.email,
        permissionId: digits(),
        canCreateDrives: p.canCreateDrives ?? true,
      })
    const send = (m: SentMessage) => this.outbox.push(m)
    this.drive = new StubDrive(this.users, options.organization ?? 'example.org', send)
    this.calendar = new StubCalendar(this.users, send, options.calendarZone)
  }

  public user(id: string): StubUser {
    const u = this.users.find((x) => x.id === id)
    if (!u) throw new Error(`no user ${id}`)
    return u
  }

  /** A new access token of a user, with its scopes (every scope the connector's tools need when absent). */
  public token(userId: string, scopes: string[] = ALL_SCOPES): string {
    const token = `ya29.${randomBytes(24).toString('base64url')}`
    this.tokens.set(token, { user: this.user(userId), scopes: new Set(scopes) })
    return token
  }

  /** Whether the stub issued a token. */
  public issued(token: string): boolean {
    return this.tokens.has(token)
  }

  /** The next `count` requests answer 429, with `Retry-After` when given. */
  public limitNext(count: number, retryAfter?: number): void {
    this.rateLimited = { count, ...(retryAfter !== undefined ? { retryAfter } : {}) }
  }

  public messagesTo(address: string): SentMessage[] {
    return this.outbox.filter((m) => m.to.toLowerCase() === address.toLowerCase())
  }

  public endpoints(): GoogleEndpoints {
    return {
      drive: `${this.base}/drive/v3`,
      upload: `${this.base}/upload/drive/v3`,
      calendar: `${this.base}/calendar/v3`,
    }
  }

  /** One request, web-standard. */
  public async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const authorization = request.headers.get('authorization') ?? undefined
    this.requests.push({
      method: request.method,
      host: url.host,
      path: url.pathname,
      ...(authorization ? { authorization } : {}),
    })
    const m = /^\/(drive\/v3|upload\/drive\/v3|calendar\/v3)(\/.*)?$/.exec(url.pathname)
    if (!m) return gerror(404, 'notFound', 'Not Found')
    const api = m[1] === 'drive/v3' ? 'drive' : m[1] === 'upload/drive/v3' ? 'upload' : 'calendar'
    const parts = (m[2] ?? '')
      .split('/')
      .filter(Boolean)
      .map((p) => decodeURIComponent(p))
    if (!this.available) return gerror(503, 'backendError', 'The service is currently unavailable.')
    if (this.rateLimited.count > 0) {
      this.rateLimited.count--
      return gerror(429, 'rateLimitExceeded', 'Rate Limit Exceeded', {
        ...(this.rateLimited.retryAfter !== undefined ? { 'retry-after': String(this.rateLimited.retryAfter) } : {}),
      })
    }
    const token = /^Bearer (\S+)$/.exec(authorization ?? '')?.[1]
    const caller = token ? this.tokens.get(token) : undefined
    if (!caller) return unauthenticated()
    const accepted = scopesOf(api, request.method, parts).map(SCOPE)
    if (!accepted.some((s) => caller.scopes.has(s)))
      return insufficientScope(api === 'calendar' ? 'calendar-json.googleapis.com' : 'drive.googleapis.com', accepted)
    const body = Buffer.from(await request.arrayBuffer())
    const r: StubRequest = { method: request.method, url, parts, headers: request.headers, body, caller }
    try {
      return api === 'calendar' ? this.calendar.handle(r) : this.drive.handle(r, api)
    } catch (e) {
      if (e instanceof StubError) return gerror(e.status, e.reason, e.message)
      return gerror(500, 'backendError', 'Backend Error')
    }
  }

  /** Serves the stub on a free port of 127.0.0.1. */
  public async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const request = new Request(`http://${req.headers.host}${req.url}`, {
          method: req.method ?? 'GET',
          headers: Object.entries(req.headers).flatMap(([k, v]) =>
            v === undefined
              ? []
              : Array.isArray(v)
                ? v.map((x) => [k, x] as [string, string])
                : [[k, v] as [string, string]]
          ),
          ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body: Buffer.concat(chunks) }),
        })
        void this.fetch(request).then(async (response) => {
          res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
          res.end(Buffer.from(await response.arrayBuffer()))
        })
      })
    })
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', () => resolve()))
    const address = this.server.address() as AddressInfo
    this.base = `http://127.0.0.1:${address.port}`
    return this.base
  }

  public async stop(): Promise<void> {
    this.server?.closeAllConnections()
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()))
  }
}
