/**
 * How an account reaches a provider (common §11): from the HTTP request that carries it, never from an argument. A
 * provider that is its service's own takes a bearer token in `Authorization` (MCP authorization); a connector takes the
 * account's credentials at the service in `Authorization` or in headers its documentation names (for the Nextcloud
 * connector, the `Ayni-*` headers of providers §1). One request, one account.
 */
import { createHash } from 'node:crypto'

/** The account of one request. */
export interface Account<D = unknown> {
  /**
   * A stable key of the account, the same for every request with the same credentials and different for others: it
   * binds cursors to their account. Never a credential itself: a digest of it.
   */
  id: string
  /** every value of the request that is a secret, so that none reaches a result, an error or a log (FEAT-CORE-019) */
  secrets: string[]
  /** what the provider needs of the account to reach its service */
  data: D
}

/** Reads the account of a request; `undefined` when the request carries none. */
export type AccountReader<D = unknown> = (request: Request) => Account<D> | undefined | Promise<Account<D> | undefined>

/** A digest of values, to key an account without keeping its credentials. */
export function accountKey(...values: string[]): string {
  return createHash('sha256').update(JSON.stringify(values)).digest('base64url')
}

/** The bearer token of a request (`Authorization: Bearer …`, RFC 6750), as `data.token`. */
export function bearerAccount(): AccountReader<{ token: string }> {
  return (request) => {
    const header = request.headers.get('authorization')
    const m = header ? /^Bearer\s+([A-Za-z0-9\-._~+/]+=*)$/i.exec(header.trim()) : null
    if (!m?.[1]) return undefined
    const token = m[1]
    return { id: accountKey('bearer', token), secrets: [token], data: { token } }
  }
}

/**
 * The values of named headers, as `data[name]` by the lower-case header name; `undefined` when none is present. The
 * names in `secret` are kept as secrets; the others (an address) are part of the account's key only.
 */
export function headerAccount(
  names: readonly string[],
  secret: readonly string[]
): AccountReader<Record<string, string>> {
  const lower = names.map((n) => n.toLowerCase())
  const secretSet = new Set(secret.map((n) => n.toLowerCase()))
  return (request) => {
    const data: Record<string, string> = {}
    for (const n of lower) {
      const v = request.headers.get(n)
      if (v !== null) data[n] = v
    }
    if (Object.keys(data).length === 0) return undefined
    const secrets = Object.entries(data)
      .filter(([k]) => secretSet.has(k))
      .map(([, v]) => v)
    return { id: accountKey('headers', ...lower.map((n) => `${n}=${data[n] ?? ''}`)), secrets, data }
  }
}
