/**
 * Where the connector sends a person's token: Google's generally available interfaces, and no other host
 * (TOOL-OAUTH-018, FEAT-CORE-021). The three base addresses are fixed; a test may give others (a stub of its own) only
 * through `testEndpoints` of `createGoogleConnector`, which the command line and the image never set. Any base address
 * that is not one of Google's is refused when the connector starts, so that no configuration of a deployment can
 * point a token elsewhere.
 */

export interface GoogleEndpoints {
  /** the Drive API v3 */
  drive: string
  /** the Drive API v3's uploads */
  upload: string
  /** the Calendar API v3 */
  calendar: string
}

/** Google's generally available interfaces, as Google's documentation gives them. */
export const GOOGLE_ENDPOINTS: Readonly<GoogleEndpoints> = Object.freeze({
  drive: 'https://www.googleapis.com/drive/v3',
  upload: 'https://www.googleapis.com/upload/drive/v3',
  calendar: 'https://www.googleapis.com/calendar/v3',
})

/** Google's authorization server, which the Protected Resource Metadata names (TOOL-OAUTH-018). */
export const GOOGLE_AUTHORIZATION_SERVER = 'https://accounts.google.com'

/** The host every base address of a deployment must have. */
export const GOOGLE_API_HOST = 'www.googleapis.com'

const PATHS: Record<keyof GoogleEndpoints, string> = {
  drive: '/drive/v3',
  upload: '/upload/drive/v3',
  calendar: '/calendar/v3',
}

/** Whether a base address is the one of Google's interfaces for its API: `https`, Google's host, its path. */
export function isGoogleEndpoint(api: keyof GoogleEndpoints, base: string): boolean {
  let url: URL
  try {
    url = new URL(base)
  } catch {
    return false
  }
  return (
    url.protocol === 'https:' &&
    url.hostname === GOOGLE_API_HOST &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    url.hash === '' &&
    url.pathname.replace(/\/$/, '') === PATHS[api]
  )
}

/**
 * The base addresses the connector uses: Google's, unless a test gives its own with `allowAny`. Throws when an address
 * given without `allowAny` is not Google's, so that a misconfigured deployment does not start.
 */
export function resolveEndpoints(given: Partial<GoogleEndpoints> | undefined, allowAny: boolean): GoogleEndpoints {
  const out: GoogleEndpoints = { ...GOOGLE_ENDPOINTS }
  for (const api of ['drive', 'upload', 'calendar'] as const) {
    const base = given?.[api]
    if (base === undefined) continue
    if (!allowAny && !isGoogleEndpoint(api, base))
      throw new Error(`the ${api} endpoint must be ${GOOGLE_ENDPOINTS[api]}: the connector sends tokens to Google only`)
    if (allowAny && !/^https?:\/\//.test(base))
      throw new Error(`the ${api} endpoint of a test is not an http(s) address`)
    out[api] = base.replace(/\/$/, '')
  }
  return out
}

/** Whether an absolute address lies under a base address: the same origin, and the base's path or below it. */
export function isUnder(address: string, base: string): boolean {
  let a: URL
  let b: URL
  try {
    a = new URL(address)
    b = new URL(base)
  } catch {
    return false
  }
  const basePath = b.pathname.replace(/\/$/, '')
  return a.origin === b.origin && (a.pathname === basePath || a.pathname.startsWith(`${basePath}/`))
}
