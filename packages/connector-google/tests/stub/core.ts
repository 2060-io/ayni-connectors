/**
 * What the stub's Drive and Calendar share: its accounts and their tokens with their scopes, Google's error bodies,
 * the scopes each method takes, the messages Google would send, and ids. Every account is fictional (`example.org`,
 * `partner.example`); a token is random and known to the stub alone.
 */
import { randomBytes } from 'node:crypto'

export interface StubUser {
  id: string
  name: string
  email: string
  /** Drive's permission id of the user, the same on every file (Drive: "a unique identifier for the grantee") */
  permissionId: string
  /** whether the account may create shared drives (Drive's `about.canCreateDrives`) */
  canCreateDrives: boolean
}

export interface SentMessage {
  to: string
  kind: 'share' | 'invitation' | 'update' | 'cancellation' | 'reply'
  subject: string
  text: string
}

export interface Caller {
  user: StubUser
  scopes: Set<string>
}

/** A request as a handler of the stub reads it. */
export interface StubRequest {
  method: string
  url: URL
  /** the path below the API's base, split */
  parts: string[]
  headers: Headers
  body: Buffer
  caller: Caller
}

export const SCOPE = (s: string) => `https://www.googleapis.com/auth/${s}`

/** The scopes of the agent's table (its architecture §10.10), and `drive` for the tools it does not list. */
export const ALL_SCOPES = [
  SCOPE('drive.readonly'),
  SCOPE('drive'),
  SCOPE('calendar.calendarlist.readonly'),
  SCOPE('calendar.events.readonly'),
  SCOPE('calendar.events.freebusy'),
  SCOPE('calendar.events'),
]

const STATUS: Record<number, string> = {
  400: 'INVALID_ARGUMENT',
  401: 'UNAUTHENTICATED',
  403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND',
  409: 'ALREADY_EXISTS',
  410: 'NOT_FOUND',
  412: 'FAILED_PRECONDITION',
  429: 'RESOURCE_EXHAUSTED',
  500: 'INTERNAL',
  503: 'UNAVAILABLE',
}

/** Google's error body (Drive's and Calendar's guides to errors): `{ error: { code, message, errors, status } }`. */
export function gerror(
  status: number,
  reason: string,
  message: string,
  headers: Record<string, string> = {}
): Response {
  return Response.json(
    {
      error: {
        code: status,
        message,
        errors: [{ message, domain: reason.endsWith('LimitExceeded') ? 'usageLimits' : 'global', reason }],
        status: STATUS[status] ?? 'UNKNOWN',
      },
    },
    { status, headers }
  )
}

/** A failure a handler throws, answered as Google's error body. */
export class StubError extends Error {
  public constructor(
    public readonly status: number,
    public readonly reason: string,
    message: string
  ) {
    super(message)
  }
}

export const fail = (status: number, reason: string, message: string): never => {
  throw new StubError(status, reason, message)
}

export const notFound = (what = 'File'): never => fail(404, 'notFound', `${what} not found.`)

/** Google's answer to a token without the scopes of a method (an `ErrorInfo` of `ACCESS_TOKEN_SCOPE_INSUFFICIENT`). */
export function insufficientScope(service: string, scopes: string[]): Response {
  return Response.json(
    {
      error: {
        code: 403,
        message: 'Request had insufficient authentication scopes.',
        errors: [{ message: 'Insufficient Permission', domain: 'global', reason: 'insufficientPermissions' }],
        status: 'PERMISSION_DENIED',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
            domain: 'googleapis.com',
            metadata: { service },
          },
        ],
      },
    },
    {
      status: 403,
      headers: {
        'www-authenticate': `Bearer realm="https://accounts.google.com/", error="insufficient_scope", scope="${scopes.join(' ')}"`,
      },
    }
  )
}

export function unauthenticated(): Response {
  return Response.json(
    {
      error: {
        code: 401,
        message: 'Request had invalid authentication credentials. Expected OAuth 2 access token.',
        errors: [{ message: 'Invalid Credentials', domain: 'global', reason: 'authError' }],
        status: 'UNAUTHENTICATED',
      },
    },
    {
      status: 401,
      headers: { 'www-authenticate': 'Bearer realm="https://accounts.google.com/", error="invalid_token"' },
    }
  )
}

let counter = 0
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** An id in the alphabet of Drive's ids. */
export function driveId(prefix = '1', length = 33): string {
  const bytes = randomBytes(length)
  let out = prefix
  for (let i = out.length; i < length; i++) out += ALPHABET[(bytes[i] as number) % 64]
  return out
}

/** A digit string, as Drive's permission ids of users are. */
export function digits(length = 20): string {
  const bytes = randomBytes(length)
  return Array.from(bytes, (b) => String(b % 10)).join('')
}

/** An id in base32hex, as Calendar's event ids are. */
export function eventId(): string {
  const bytes = randomBytes(26)
  return Array.from(bytes, (b) => '0123456789abcdefghijklmnopqrstuv'[b % 32]).join('')
}

export function nextCount(): number {
  counter++
  return counter
}

/** Google's page tokens: opaque, bound to the query they were given for. */
export function pageToken(offset: number, binding: string): string {
  return Buffer.from(JSON.stringify({ o: offset, b: binding })).toString('base64url')
}

export function openPageToken(token: string | null, binding: string): number {
  if (!token) return 0
  try {
    const p = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as { o: number; b: string }
    if (p.b !== binding || !Number.isInteger(p.o) || p.o < 0) throw new Error('binding')
    return p.o
  } catch {
    return fail(400, 'invalid', 'Invalid Value')
  }
}

/** A page of a list, Google's way: `pageSize` items from the token's offset, and the next token while more remain. */
export function pageOf<T>(
  items: T[],
  url: URL,
  binding: string,
  defaults: { size: number; max: number },
  sizeParam = 'pageSize'
): { items: T[]; next?: string } {
  const sizeText = url.searchParams.get(sizeParam)
  const size = sizeText === null ? defaults.size : Number(sizeText)
  if (!Number.isInteger(size) || size < 1 || size > defaults.max) fail(400, 'invalid', `Invalid ${sizeParam}`)
  const from = openPageToken(url.searchParams.get('pageToken'), binding)
  const slice = items.slice(from, from + size)
  return { items: slice, ...(from + size < items.length ? { next: pageToken(from + size, binding) } : {}) }
}

export const iso = (ms: number) => new Date(ms).toISOString()

export function domainOf(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase()
}

export function jsonBody<T = Record<string, unknown>>(r: StubRequest): T {
  try {
    return (r.body.length ? JSON.parse(r.body.toString('utf8')) : {}) as T
  } catch {
    return fail(400, 'parseError', 'Parse Error')
  }
}

/** A boolean query parameter, Google's way (`true`, `false`). */
export function flag(url: URL, name: string, fallback: boolean): boolean {
  const v = url.searchParams.get(name)
  return v === null ? fallback : v === 'true'
}
