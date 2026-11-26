/**
 * One request to the connector, the unit of everything it holds (common §11, FEAT-DAV-004): the account read from the
 * headers, one client whose hosts are pinned to the addresses checked for them, and what the server said of the
 * account, read once for both profiles. Nothing outlives the request: the scope is kept by the request object alone.
 */
import { type Account, errors, isProfileError, type Logger, type ProfileError } from '@ayni.org/ayni-provider-kit'
import { type DavAccountData, type Target, targetOf } from './account.js'
import { type DavResponse, HttpClient } from './http.js'
import { type HostPolicy, Pins, type Resolve } from './net.js'
import { davRoot, discoverNextcloud, type NextcloudInfo, userIdOf } from './nextcloud.js'

export interface ConnectorConfig {
  policy: HostPolicy
  resolve: Resolve
  /** certificate authorities to trust beside the runtime's (PEM) */
  ca?: string[]
  timeoutMs: number
  logger: Logger
}

export class RequestScope {
  public readonly target: Target
  public readonly http?: HttpClient
  private nc?: Promise<NextcloudInfo>
  private user?: Promise<string | undefined>
  private options = new Map<string, Promise<DavResponse>>()

  public constructor(
    account: Account<DavAccountData> | undefined,
    public readonly config: ConnectorConfig
  ) {
    this.target = targetOf(account)
    if (!this.target.problem && this.target.credentials)
      this.http = new HttpClient({
        credentials: this.target.credentials,
        origins: this.target.origins,
        pins: new Pins(config.policy, config.resolve),
        ...(config.ca ? { ca: config.ca } : {}),
        timeoutMs: config.timeoutMs,
        logger: config.logger,
      })
  }

  /** The error every call of this request answers, when the request cannot reach its server. */
  public get problem(): ProfileError | undefined {
    if (this.target.problem) return this.target.problem
    if (!this.http) return errors.accountRefused()
    return undefined
  }

  /** The user id of the account at the Nextcloud of the request, asked once per request. */
  public nextcloudUser(base: URL): Promise<string | undefined> {
    this.user ??= userIdOf(this.http as HttpClient, base)
    return this.user
  }

  /** What the Nextcloud of the request says of the account, asked once per request. */
  public nextcloud(base: URL): Promise<NextcloudInfo> {
    this.nc ??= discoverNextcloud(this.http as HttpClient, base, this.nextcloudUser(base))
    return this.nc
  }

  /** The `OPTIONS` of an address of the request, asked once per request. */
  public optionsOf(url: URL): Promise<DavResponse> {
    let p = this.options.get(url.toString())
    if (!p) {
      p = (this.http as HttpClient).send({ method: 'OPTIONS', url })
      this.options.set(url.toString(), p)
    }
    return p
  }

  /**
   * What both profiles will ask, started together: the Nextcloud's account and capabilities, and the `OPTIONS` of its
   * calendars, which needs the user id alone. Each is awaited by the profile that needs it; nothing outlives the request.
   */
  public warm(): void {
    if (this.problem || !this.http) return
    const t = this.target
    const quiet = (p: Promise<unknown>) => void p.catch(() => undefined)
    if (t.files?.kind === 'nextcloud') quiet(this.nextcloud(t.files.base))
    if (t.calendar?.kind === 'nextcloud') {
      const base = t.calendar.base
      quiet(
        this.nextcloudUser(base).then((uid) =>
          uid ? this.optionsOf(new URL(`calendars/${encodeURIComponent(uid)}/`, davRoot(base))) : undefined
        )
      )
    } else if (t.calendar?.kind === 'caldav') quiet(this.optionsOf(t.calendar.address))
  }
}

const scopes = new WeakMap<Request, RequestScope>()

/** The scope of a request, made at its first use and dropped with the request. */
export function scopeOf(request: Request, account: Account<DavAccountData> | undefined, config: ConnectorConfig) {
  let s = scopes.get(request)
  if (!s) {
    s = new RequestScope(account, config)
    scopes.set(request, s)
    s.warm()
  }
  return s
}

/** A failure of discovery as the calls answer it. */
export function asProfileError(error: unknown): ProfileError {
  return isProfileError(error) ? error : errors.unavailable('The server of the account cannot be reached.')
}
