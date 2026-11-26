/**
 * The connector's one way out (FEAT-DAV-002, 003, FEAT-CORE-021): HTTPS with the server's certificate checked, HTTP
 * Basic with the account of the request, to the hosts of the request's addresses alone, each at the address checked
 * for it, following no redirection. Nothing is pooled or kept between requests: a connection serves one exchange.
 */
import { request as httpsRequest } from 'node:https'
import type { LookupFunction } from 'node:net'
import { isIP } from 'node:net'
import { rootCertificates } from 'node:tls'
import { errors, type Logger } from '@ayni.org/ayni-provider-kit'
import type { AddressHeader, Pins } from './net.js'

export interface DavRequest {
  method: string
  url: URL
  headers?: Record<string, string>
  body?: string | Uint8Array
  /** the most bytes of the answer read; a longer answer is cut and marked `truncated` */
  maxBytes?: number
}

export interface DavResponse {
  status: number
  headers: Record<string, string>
  body: Buffer
  truncated: boolean
}

/** The account's credentials at the server, for HTTP Basic (RFC 7617). */
export interface Credentials {
  username: string
  password: string
}

/** 32 MiB: the largest answer read when a call gives no bound (a listing of a large folder). */
export const DEFAULT_MAX_ANSWER_BYTES = 32 * 1024 * 1024

export interface HttpOptions {
  credentials: Credentials
  /** the origins of the request's addresses, each with the header that named it */
  origins: { origin: string; header: AddressHeader }[]
  pins: Pins
  /** further certificate authorities to trust (PEM), beside the runtime's */
  ca?: string[]
  timeoutMs: number
  logger: Logger
  signal?: AbortSignal
}

/** The client of one request to the connector. */
export class HttpClient {
  private readonly authorization: string
  private readonly ca?: string[]

  public constructor(private readonly options: HttpOptions) {
    const { username, password } = options.credentials
    this.authorization = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
    if (options.ca?.length) this.ca = [...rootCertificates, ...options.ca]
  }

  /** The origins this client may reach. */
  public allows(url: URL): boolean {
    return url.protocol === 'https:' && this.options.origins.some((o) => o.origin === url.origin)
  }

  public async send(req: DavRequest, signal?: AbortSignal): Promise<DavResponse> {
    const origin = this.options.origins.find((o) => o.origin === req.url.origin)
    // a guard of the code itself: an address built from a server's answer that leaves the request's hosts is refused
    if (req.url.protocol !== 'https:' || !origin) throw errors.unavailable('The server answered an address elsewhere.')
    const pinned = await this.options.pins.addressOf(req.url.hostname, origin.header)
    const headers: Record<string, string> = {
      'user-agent': 'ayni-connector-nextcloud',
      ...(req.headers ?? {}),
      authorization: this.authorization,
    }
    const body = req.body === undefined ? undefined : typeof req.body === 'string' ? Buffer.from(req.body) : req.body
    if (body) headers['content-length'] = String(body.byteLength)
    const lookupPinned: LookupFunction = (_host, opts, callback) => {
      const cb = callback as (e: Error | null, a: string | { address: string; family: number }[], f?: number) => void
      if ((opts as { all?: boolean }).all) cb(null, [{ address: pinned.address, family: pinned.family }])
      else cb(null, pinned.address, pinned.family)
    }
    const max = req.maxBytes ?? DEFAULT_MAX_ANSWER_BYTES
    const started = Date.now()
    const hostname = req.url.hostname.startsWith('[') ? req.url.hostname.slice(1, -1) : req.url.hostname
    const signals = [signal, this.options.signal].filter((s): s is AbortSignal => !!s)
    const abort = signals.length ? AbortSignal.any(signals) : undefined
    try {
      const res = await new Promise<DavResponse>((resolve, reject) => {
        const r = httpsRequest(
          {
            protocol: 'https:',
            hostname,
            port: req.url.port || 443,
            path: `${req.url.pathname}${req.url.search}`,
            method: req.method,
            headers,
            lookup: lookupPinned,
            ...(isIP(hostname) ? {} : { servername: hostname }),
            ...(this.ca ? { ca: this.ca } : {}),
            rejectUnauthorized: true,
            agent: false,
            timeout: this.options.timeoutMs,
            ...(abort ? { signal: abort } : {}),
          },
          (response) => {
            const chunks: Buffer[] = []
            let size = 0
            let truncated = false
            response.on('data', (chunk: Buffer) => {
              if (truncated) return
              if (size + chunk.length > max) {
                chunks.push(chunk.subarray(0, max - size))
                size = max
                truncated = true
                response.destroy()
                finish()
                return
              }
              chunks.push(chunk)
              size += chunk.length
            })
            let done = false
            const finish = () => {
              if (done) return
              done = true
              const out: Record<string, string> = {}
              for (const [k, v] of Object.entries(response.headers))
                if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v
              resolve({ status: response.statusCode ?? 0, headers: out, body: Buffer.concat(chunks), truncated })
            }
            response.on('end', finish)
            response.on('error', (e) => (truncated ? finish() : reject(e)))
          }
        )
        r.on('timeout', () => r.destroy(new Error('timeout')))
        r.on('error', reject)
        if (body) r.end(body)
        else r.end()
      })
      this.options.logger.debug(
        { method: req.method, status: res.status, ms: Date.now() - started },
        'a request to the server'
      )
      return res
    } catch (error) {
      if ((error as { code?: string } | undefined)?.code === 'invalid-argument') throw error
      this.options.logger.warn(
        { method: req.method, error: (error as { code?: string })?.code ?? (error as Error)?.name ?? 'error' },
        'the server could not be reached'
      )
      throw errors.unavailable('The server of the account cannot be reached.')
    }
  }
}
