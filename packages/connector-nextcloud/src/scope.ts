/**
 * One request to the connector, the unit of everything it holds (common §11, FEAT-DAV-004): the account read from the
 * headers, one client whose hosts are pinned to the addresses checked for them, and what the server said of the
 * account, read once for both profiles. Nothing outlives the request: the scope is kept by the request object alone.
 */
import { type Account, errors, isProfileError, type Logger, type ProfileError } from '@ayni.org/ayni-provider-kit'
import { type DavAccountData, type Target, targetOf } from './account.js'
import { HttpClient } from './http.js'
import { type HostPolicy, Pins, type Resolve } from './net.js'
import { discoverNextcloud, type NextcloudInfo } from './nextcloud.js'

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

  /** What the Nextcloud of the request says of the account, asked once per request. */
  public nextcloud(base: URL): Promise<NextcloudInfo> {
    this.nc ??= discoverNextcloud(this.http as HttpClient, base)
    return this.nc
  }
}

const scopes = new WeakMap<Request, RequestScope>()

/** The scope of a request, made at its first use and dropped with the request. */
export function scopeOf(request: Request, account: Account<DavAccountData> | undefined, config: ConnectorConfig) {
  let s = scopes.get(request)
  if (!s) {
    s = new RequestScope(account, config)
    scopes.set(request, s)
  }
  return s
}

/** A failure of discovery as the calls answer it. */
export function asProfileError(error: unknown): ProfileError {
  return isProfileError(error) ? error : errors.unavailable('The server of the account cannot be reached.')
}
