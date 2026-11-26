/**
 * What every handler of the stub shares: a request read whole, its user from HTTP Basic (a user id or an email, as
 * Nextcloud lets one sign in), and the answers of WebDAV: a multistatus with a 200 and a 404 `propstat` per resource,
 * as Sabre writes them, and the bodies of its errors.
 */
import { escapeXml } from '../../src/xml.js'
import type { Store, User } from './store.js'

export interface StubRequest {
  method: string
  url: URL
  /** the decoded parts of the path */
  parts: string[]
  headers: Record<string, string>
  body: Buffer
  user?: User
  /** signed in with an app password, which confirms no password */
  appPassword?: boolean
}

export interface StubResponse {
  status: number
  headers?: Record<string, string>
  body?: string | Buffer
}

export const NS = {
  D: 'DAV:',
  OC: 'http://owncloud.org/ns',
  NC: 'http://nextcloud.org/ns',
  CAL: 'urn:ietf:params:xml:ns:caldav',
  CS: 'http://calendarserver.org/ns/',
  S: 'http://sabredav.org/ns',
} as const

const PREFIX: Record<string, string> = {
  [NS.D]: 'd',
  [NS.OC]: 'oc',
  [NS.NC]: 'nc',
  [NS.CAL]: 'cal',
  [NS.CS]: 'cs',
  [NS.S]: 's',
}

export type Prop = readonly [string, string]

export const key = (ns: string, name: string) => `${ns} ${name}`

/** A resource of a multistatus: its href, and the value of each property it has (inner XML). */
export interface PropResource {
  href: string
  values: Map<string, string>
}

function tag(ns: string, name: string, inner?: string): string {
  const p = PREFIX[ns]
  if (p) return inner === undefined || inner === '' ? `<${p}:${name}/>` : `<${p}:${name}>${inner}</${p}:${name}>`
  return inner === undefined || inner === ''
    ? `<x1:${name} xmlns:x1="${escapeXml(ns)}"/>`
    : `<x1:${name} xmlns:x1="${escapeXml(ns)}">${inner}</x1:${name}>`
}

const header = `<?xml version="1.0"?>\n<d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">`

/** A multistatus answering the properties asked of each resource: found in a 200 `propstat`, the others in a 404. */
export function multistatus(resources: PropResource[], asked: readonly Prop[] | 'all'): StubResponse {
  const out: string[] = [header]
  for (const r of resources) {
    const props: Prop[] =
      asked === 'all' ? [...r.values.keys()].map((k) => k.split(' ') as unknown as Prop) : [...asked]
    const found: string[] = []
    const missing: string[] = []
    for (const [ns, name] of props) {
      const v = r.values.get(key(ns, name))
      if (v === undefined) missing.push(tag(ns, name))
      else found.push(tag(ns, name, v))
    }
    out.push(`<d:response><d:href>${escapeXml(r.href)}</d:href>`)
    if (found.length || !missing.length)
      out.push(`<d:propstat><d:prop>${found.join('')}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>`)
    if (missing.length)
      out.push(
        `<d:propstat><d:prop>${missing.join('')}</d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>`
      )
    out.push('</d:response>')
  }
  out.push('</d:multistatus>')
  return { status: 207, headers: { 'content-type': 'application/xml; charset=utf-8' }, body: out.join('') }
}

/** Sabre's error body. */
export function davError(status: number, exception: string, message = ''): StubResponse {
  return {
    status,
    headers: { 'content-type': 'application/xml; charset=utf-8' },
    body: `<?xml version="1.0" encoding="utf-8"?>\n<d:error xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns">\n  <s:exception>Sabre\\DAV\\Exception\\${exception}</s:exception>\n  <s:message>${escapeXml(message)}</s:message>\n</d:error>`,
  }
}

/** The user of a request's HTTP Basic credentials, by user id or email, and whether it is an app password. */
export function authenticate(
  store: Store,
  authorization: string | undefined
): { user: User; appPassword: boolean } | undefined {
  const m = authorization ? /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(authorization.trim()) : null
  if (!m?.[1]) return undefined
  const text = Buffer.from(m[1], 'base64').toString('utf8')
  const colon = text.indexOf(':')
  if (colon < 0) return undefined
  const u = store.userByLogin(text.slice(0, colon))
  const pw = text.slice(colon + 1)
  if (!u) return undefined
  if (u.password === pw) return { user: u, appPassword: false }
  return u.appPasswords.has(pw) ? { user: u, appPassword: true } : undefined
}

/** A path segment encoded as Sabre encodes an href. */
export function enc(part: string): string {
  return encodeURIComponent(part).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

export function hrefOf(base: string, parts: readonly string[], folder: boolean): string {
  return `${base}${parts.map(enc).join('/')}${folder && parts.length ? '/' : ''}`
}

export function httpDate(ms: number): string {
  return new Date(ms).toUTCString()
}
