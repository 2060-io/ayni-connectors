/**
 * The connector's one way to Google: plain `fetch` against the Drive API v3 and the Calendar API v3, with the person's
 * access token of the request in `Authorization` (TOOL-OAUTH-018). The token is held by the client of one call and by
 * nothing else; it goes to the endpoints of `endpoints.ts` only, no redirection is followed to another place, and
 * nothing of it, of an address or of a content is logged: a log line carries the API, the method, the status, Google's
 * reason and the time taken.
 */
import { errors, type Logger, ProfileError } from '@ayni.org/ayni-provider-kit'
import { type GoogleEndpoints, isUnder } from './endpoints.js'

export type Api = keyof GoogleEndpoints

/** An answer of Google that is not a success, as Google's error body gives it. */
export class GoogleError extends Error {
  public constructor(
    public readonly status: number,
    /** the first `errors[].reason`, or the `reason` of an `ErrorInfo` detail */
    public readonly reason: string | undefined,
    message: string,
    /** a token whose scopes do not cover the method (`insufficient_scope`, `ACCESS_TOKEN_SCOPE_INSUFFICIENT`) */
    public readonly insufficientScope: boolean,
    /** `Retry-After`, in seconds, when Google sends it */
    public readonly retryAfterSeconds: number | undefined
  ) {
    super(message)
    this.name = 'GoogleError'
  }
}

export function isGoogleError(e: unknown): e is GoogleError {
  return e instanceof GoogleError
}

/** The reasons Google gives for a limit of rate or quota (Drive's and Calendar's guides to errors). */
const RATE_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'dailyLimitExceeded',
  'sharingRateLimitExceeded',
  'quotaExceeded',
  'RATE_LIMIT_EXCEEDED',
])

function retryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined
  if (/^\d+$/.test(header.trim())) return Number(header.trim())
  const at = Date.parse(header)
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now) / 1000))
}

/** Reads Google's error body (`{ "error": { "code", "message", "errors": [{ "reason" }], "status", "details" } }`). */
export async function googleErrorOf(res: Response): Promise<GoogleError> {
  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = undefined
  }
  const error = ((body as { error?: unknown } | undefined)?.error ?? {}) as {
    message?: string
    status?: string
    errors?: { reason?: string; message?: string }[]
    details?: { '@type'?: string; reason?: string }[]
  }
  const info = (error.details ?? []).find((d) => String(d['@type'] ?? '').endsWith('google.rpc.ErrorInfo'))
  const reason = error.errors?.[0]?.reason ?? info?.reason
  const challenge = res.headers.get('www-authenticate') ?? ''
  const insufficientScope =
    res.status === 403 &&
    (/error="?insufficient_scope/i.test(challenge) ||
      info?.reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' ||
      reason === 'insufficientPermissions' ||
      /insufficient authentication scopes/i.test(error.message ?? ''))
  return new GoogleError(
    res.status,
    reason,
    error.message ?? `HTTP ${res.status}`,
    insufficientScope,
    retryAfter(res.headers.get('retry-after'))
  )
}

/**
 * The profile's error for an answer of Google, where the call gives it no meaning of its own (common §9): `401`
 * `account-refused`, and a missing scope `permission-denied`, each marked for the HTTP layer; a limit `rate-limited`; another `403` `permission-denied`;
 * `404` and `410` `not-found`; `5xx`, a failed connection or anything else `unavailable`. No message holds Google's
 * text, an address or a name.
 */
export function profileErrorOf(e: unknown): ProfileError {
  if (e instanceof ProfileError) return e
  if (!(e instanceof GoogleError)) return errors.unavailable()
  // both marked for the HTTP layer, which answers them 401 and 403 with their challenge (challenge.ts)
  if (e.status === 401)
    return new ProfileError('account-refused', 'Google refuses the access token of the request.', {
      x_tokenRefused: true,
    })
  if (e.insufficientScope)
    return new ProfileError(
      'permission-denied',
      'The Google access token of the request does not grant the access this tool needs.',
      { x_insufficientScope: true }
    )
  if (e.status === 429 || (e.status === 403 && e.reason && RATE_REASONS.has(e.reason)))
    return errors.rateLimited(e.retryAfterSeconds, 'Google asks to wait before the next request.')
  if (e.status === 403) return errors.permissionDenied('Google does not let the account do this.')
  if (e.status === 404 || e.status === 410) return errors.notFound()
  if (e.status === 400) return errors.notSupported('Google does not take this request.')
  return errors.unavailable('Google cannot be reached, or failed.')
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>
  /** a JSON body */
  json?: unknown
  /** a body of its own, with its type */
  body?: Uint8Array
  contentType?: string
  headers?: Record<string, string>
  /** what the answer is read as: JSON (the default), bytes, or nothing */
  read?: 'json' | 'bytes' | 'none'
}

/** The client of one call: the token, the endpoints, the fetch, and a memory of the files read during the call. */
export class GoogleClient {
  public constructor(
    private readonly token: string,
    private readonly endpoints: GoogleEndpoints,
    private readonly fetchFn: typeof fetch,
    private readonly signal: AbortSignal | undefined,
    private readonly logger: Logger
  ) {}

  /** An address of an API, from a path below its base. */
  public url(api: Api, path: string, query?: RequestOptions['query']): string {
    const base = this.endpoints[api]
    const url = new URL(`${base}${path}`)
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v))
    if (!isUnder(url.toString(), base)) throw new Error('an address outside the endpoint')
    return url.toString()
  }

  /** One request; a status other than 2xx is thrown as `GoogleError`, a failed connection as `unavailable`. */
  public async request<T = unknown>(
    api: Api,
    method: string,
    path: string,
    opts: RequestOptions = {}
  ): Promise<{ status: number; headers: Headers; data: T }> {
    const url = this.url(api, path, opts.query)
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, ...(opts.headers ?? {}) }
    let body: RequestInit['body']
    if (opts.json !== undefined) {
      headers['content-type'] = 'application/json; charset=UTF-8'
      body = JSON.stringify(opts.json)
    } else if (opts.body !== undefined) {
      headers['content-type'] = opts.contentType ?? 'application/octet-stream'
      body = opts.body as RequestInit['body']
    }
    const started = Date.now()
    let res: Response
    try {
      // a redirection is never followed: the token goes to the endpoint asked and nowhere else
      res = await this.fetchFn(url, { method, headers, body, redirect: 'manual', signal: this.signal })
    } catch (error) {
      this.logger.warn(
        { api, method, outcome: 'no-connection', error: error instanceof Error ? error.name : 'error' },
        'google request failed'
      )
      throw errors.unavailable('Google cannot be reached.')
    }
    const ms = Date.now() - started
    if (res.status >= 300 && res.status < 400) {
      this.logger.warn({ api, method, status: res.status, ms }, 'google answered a redirection, not followed')
      await res.body?.cancel().catch(() => undefined)
      throw errors.unavailable('Google answered a redirection, which the connector does not follow.')
    }
    if (res.status < 200 || res.status >= 300) {
      const e = await googleErrorOf(res)
      this.logger.debug({ api, method, status: res.status, reason: e.reason, ms }, 'google request')
      throw e
    }
    this.logger.debug({ api, method, status: res.status, ms }, 'google request')
    const read = opts.read ?? 'json'
    if (read === 'none' || res.status === 204) {
      await res.body?.cancel().catch(() => undefined)
      return { status: res.status, headers: res.headers, data: undefined as T }
    }
    if (read === 'bytes') {
      const data = Buffer.from(await res.arrayBuffer())
      return { status: res.status, headers: res.headers, data: data as T }
    }
    const text = await res.text()
    let data: T
    try {
      data = (text ? JSON.parse(text) : {}) as T
    } catch {
      throw errors.unavailable('Google answered something that is not JSON.')
    }
    return { status: res.status, headers: res.headers, data }
  }

  public async json<T>(api: Api, method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    return (await this.request<T>(api, method, path, opts)).data
  }

  public async bytes(api: Api, path: string, opts: RequestOptions = {}): Promise<Buffer> {
    return (await this.request<Buffer>(api, 'GET', path, { ...opts, read: 'bytes' })).data
  }
}

/** A segment of a path, encoded: references are Google's identifiers, given back as they are. */
export const seg = (value: string) => encodeURIComponent(value)
