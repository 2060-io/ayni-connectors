/**
 * Where the connector sends a person's token: Google's generally available interfaces, and no other host
 * (TOOL-OAUTH-018, FEAT-CORE-021). The three base addresses are fixed. A test may give others, a stub of its own, only
 * through `testEndpoints` of `createGoogleConnector`, which the command line and the image never set, and only on a
 * loopback address (`127.0.0.1`, `::1`, `localhost`): a base address that is neither Google's nor a local stub's is
 * refused when the connector is made, so that no configuration can point a token at another host.
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

/** Whether a base address is a stub's of a test: `http` or `https` on a loopback address of this machine. */
export function isLoopbackEndpoint(base: string): boolean {
  let url: URL
  try {
    url = new URL(base)
  } catch {
    return false
  }
  return (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) &&
    url.username === '' &&
    url.password === ''
  )
}

/**
 * The base addresses the connector uses: Google's, unless a test gives a stub's (`forTest`), which must then be on a
 * loopback address. Throws for any other, so that a misconfigured connector does not start.
 */
export function resolveEndpoints(given: Partial<GoogleEndpoints> | undefined, forTest: boolean): GoogleEndpoints {
  const out: GoogleEndpoints = { ...GOOGLE_ENDPOINTS }
  for (const api of ['drive', 'upload', 'calendar'] as const) {
    const base = given?.[api]
    if (base === undefined) continue
    if (!isGoogleEndpoint(api, base) && !(forTest && isLoopbackEndpoint(base)))
      throw new Error(
        `the ${api} endpoint must be ${GOOGLE_ENDPOINTS[api]}, or a test's stub on a loopback address: the connector sends tokens to Google only`
      )
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
