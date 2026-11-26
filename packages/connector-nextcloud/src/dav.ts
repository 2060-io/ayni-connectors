/**
 * WebDAV (RFC 4918) as the connector speaks it: `PROPFIND` of depth 0 or 1 only (never `infinity`, FEAT-WEBDAV-003),
 * the multistatus it answers, and the statuses of providers §3 mapped to the profiles' errors.
 */
import { errors, type ProfileError } from '@ayni.org/ayni-provider-kit'
import type { DavResponse, HttpClient } from './http.js'
import { childOf, childrenOf, escapeXml, parseXml, textOf, type XmlElement } from './xml.js'

export const NS = {
  D: 'DAV:',
  OC: 'http://owncloud.org/ns',
  NC: 'http://nextcloud.org/ns',
  C: 'urn:ietf:params:xml:ns:caldav',
  CS: 'http://calendarserver.org/ns/',
} as const

const PREFIX: Record<string, string> = { [NS.D]: 'd', [NS.OC]: 'oc', [NS.NC]: 'nc', [NS.C]: 'c', [NS.CS]: 'cs' }

export type PropName = readonly [ns: string, name: string]

const declarations = () =>
  Object.entries(PREFIX)
    .map(([ns, p]) => `xmlns:${p}="${escapeXml(ns)}"`)
    .join(' ')

export function qname([ns, name]: PropName): string {
  const p = PREFIX[ns]
  if (!p) throw new Error(`no prefix for ${ns}`)
  return `${p}:${name}`
}

/** The body of a `PROPFIND` asking these properties. */
export function propfindBody(props: readonly PropName[]): string {
  return `<?xml version="1.0" encoding="utf-8"?><d:propfind ${declarations()}><d:prop>${props.map((p) => `<${qname(p)}/>`).join('')}</d:prop></d:propfind>`
}

/** The namespace declarations of the connector's documents, for a body built elsewhere. */
export function xmlns(): string {
  return declarations()
}

/** One resource of a multistatus: its `href` as the server wrote it, and the properties it found. */
export interface DavResource {
  href: string
  /** the status of the response itself, when it gives one instead of properties */
  status?: number
  props: Map<string, XmlElement>
}

const key = (ns: string, name: string) => `${ns} ${name}`

function statusOf(text: string): number | undefined {
  const m = /^\s*HTTP\/[\d.]+\s+(\d{3})/.exec(text)
  return m ? Number(m[1]) : undefined
}

/** The resources of a `207 Multi-Status`; a body that is no multistatus answers `unavailable`. */
export function parseMultistatus(body: Buffer | string): DavResource[] {
  let root: XmlElement
  try {
    root = parseXml(typeof body === 'string' ? body : body.toString('utf8'))
  } catch {
    throw errors.unavailable('The server answered a listing that cannot be read.')
  }
  if (root.ns !== NS.D || root.name !== 'multistatus')
    throw errors.unavailable('The server answered a listing that cannot be read.')
  const out: DavResource[] = []
  for (const r of childrenOf(root, NS.D, 'response')) {
    const href = textOf(childOf(r, NS.D, 'href')).trim()
    if (!href) continue
    const props = new Map<string, XmlElement>()
    for (const ps of childrenOf(r, NS.D, 'propstat')) {
      const status = statusOf(textOf(childOf(ps, NS.D, 'status')))
      if (status === undefined || status < 200 || status >= 300) continue
      for (const p of childrenOf(childOf(ps, NS.D, 'prop'))) props.set(key(p.ns, p.name), p)
    }
    const own = childOf(r, NS.D, 'status')
    out.push({ href, props, ...(own ? { status: statusOf(textOf(own)) ?? 0 } : {}) })
  }
  return out
}

export function prop(res: DavResource, ns: string, name: string): XmlElement | undefined {
  return res.props.get(key(ns, name))
}

/** A property's text, trimmed; `undefined` when the server did not find it, or found it empty. */
export function propText(res: DavResource, ns: string, name: string): string | undefined {
  const p = prop(res, ns, name)
  if (!p) return undefined
  const t = textOf(p).trim()
  return t === '' ? undefined : t
}

export function isCollection(res: DavResource): boolean {
  return !!childOf(prop(res, NS.D, 'resourcetype'), NS.D, 'collection')
}

/** The `href`s a property holds (`current-user-principal`, `calendar-home-set`). */
export function hrefsOf(res: DavResource, ns: string, name: string): string[] {
  return childrenOf(prop(res, ns, name), NS.D, 'href')
    .map((h) => textOf(h).trim())
    .filter(Boolean)
}

/** The seconds a `Retry-After` asks to wait. */
function retryAfter(res: DavResponse): number | undefined {
  const v = res.headers['retry-after']
  if (!v) return undefined
  if (/^\d+$/.test(v)) return Number(v)
  const at = Date.parse(v)
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - Date.now()) / 1000))
}

/**
 * The error of a status the call does not expect (providers §3): `401` `account-refused`; `403` `permission-denied`;
 * `404` `not-found`; `423` and `5xx` `unavailable`; `507` `too-large`; `429` `rate-limited`; a redirection, which is
 * never followed, and anything else `unavailable`.
 */
export function statusError(res: DavResponse, opts: { limitBytes?: number } = {}): ProfileError {
  const s = res.status
  if (s === 401) return errors.accountRefused('The server refuses the account of the request.')
  if (s === 403) return errors.permissionDenied('The server does not let the account do this.')
  if (s === 404 || s === 410) return errors.notFound()
  if (s === 429) return errors.rateLimited(retryAfter(res))
  if (s === 507 && opts.limitBytes !== undefined)
    return errors.tooLarge(opts.limitBytes, undefined, 'The server has no room for this content.')
  return errors.unavailable('The server cannot do this now.')
}

export type Depth = '0' | '1'

/** `PROPFIND` of depth 0 or 1; any status but 207 is the error of the table. */
export async function propfind(
  http: HttpClient,
  url: URL,
  depth: Depth,
  props: readonly PropName[],
  signal?: AbortSignal
): Promise<DavResource[]> {
  const res = await http.send(
    {
      method: 'PROPFIND',
      url,
      headers: { depth, 'content-type': 'application/xml; charset=utf-8' },
      body: propfindBody(props),
    },
    signal
  )
  if (res.status !== 207 || res.truncated) throw res.truncated ? errors.unavailable() : statusError(res)
  return parseMultistatus(res.body)
}

/** The HTTP date or RFC 3339 instant of a property, in milliseconds. */
export function timeOf(text: string | undefined): number | undefined {
  if (!text) return undefined
  const t = Date.parse(text)
  return Number.isNaN(t) ? undefined : t
}
