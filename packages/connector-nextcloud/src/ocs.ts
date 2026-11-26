/**
 * Nextcloud's OCS interfaces (providers §5): `OCS-APIRequest: true`, JSON, HTTP Basic. Version 2 answers its status in
 * HTTP; version 1, and the Team folders app, answer `200` with a `statuscode` of their own (100 for success).
 */
import { errors, type ProfileError } from '@ayni.org/ayni-provider-kit'
import { statusError } from './dav.js'
import type { DavResponse, HttpClient } from './http.js'

export interface OcsAnswer<T = unknown> {
  /** the HTTP status */
  status: number
  /** the OCS status code (100 or 200 for success), or the HTTP status when the body holds none */
  statuscode: number
  message: string
  data: T
}

export type Form = Record<string, string | string[]>

function encodeForm(form: Form): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(form)) {
    if (Array.isArray(v)) for (const x of v) p.append(`${k}[]`, x)
    else p.append(k, v)
  }
  return p.toString()
}

/** One OCS call; the body is read as JSON, and a body that is not answers `unavailable`. */
export async function ocs<T = unknown>(
  http: HttpClient,
  url: URL,
  method = 'GET',
  form?: Form,
  signal?: AbortSignal
): Promise<OcsAnswer<T>> {
  const u = new URL(url.toString())
  if (method === 'GET' && form) for (const [k, v] of new URLSearchParams(encodeForm(form))) u.searchParams.append(k, v)
  if (!u.searchParams.has('format')) u.searchParams.set('format', 'json')
  const res: DavResponse = await http.send(
    {
      method,
      url: u,
      headers: {
        'ocs-apirequest': 'true',
        accept: 'application/json',
        ...(method !== 'GET' && form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(method !== 'GET' && form ? { body: encodeForm(form) } : {}),
      maxBytes: 8 * 1024 * 1024,
    },
    signal
  )
  if (res.status === 401) throw errors.accountRefused('The server refuses the account of the request.')
  if (res.status >= 500 || res.truncated) throw errors.unavailable('The server cannot do this now.')
  if (res.status === 429) throw statusError(res)
  let json: { ocs?: { meta?: { statuscode?: number; message?: string }; data?: unknown }; message?: string }
  try {
    json = JSON.parse(res.body.toString('utf8') || '{}')
  } catch {
    if (res.status >= 300) throw statusError(res)
    throw errors.unavailable('The server answered what cannot be read.')
  }
  const meta = json.ocs?.meta
  return {
    status: res.status,
    statuscode: meta?.statuscode ?? res.status,
    message: meta?.message ?? json.message ?? '',
    data: (json.ocs?.data ?? json) as T,
  }
}

export function ocsOk(a: OcsAnswer): boolean {
  return a.status >= 200 && a.status < 300 && (a.statuscode === 100 || a.statuscode === 200)
}

/** The error of an OCS answer that is not a success, as the profiles name it. */
export function ocsError(a: OcsAnswer): ProfileError {
  const code = a.status >= 300 ? a.status : a.statuscode
  if (code === 401 || code === 997) return errors.accountRefused('The server refuses the account of the request.')
  if (code === 403 || code === 104) return errors.permissionDenied('The server does not let the account do this.')
  if (code === 404 || code === 998) return errors.notFound()
  return errors.unavailable('The server cannot do this now.')
}

/** The address of an OCS endpoint of a Nextcloud: `{base}/ocs/v2.php/…`. */
export function ocsUrl(base: URL, path: string, version: 1 | 2 = 2): URL {
  const u = new URL(base.toString())
  u.pathname = `${base.pathname.replace(/\/+$/, '')}/ocs/v${version}.php/${path.replace(/^\/+/, '')}`
  return u
}

/** The address of an app's route of a Nextcloud, through `index.php` (with or without pretty addresses). */
export function appUrl(base: URL, path: string): URL {
  const u = new URL(base.toString())
  u.pathname = `${base.pathname.replace(/\/+$/, '')}/index.php/${path.replace(/^\/+/, '')}`
  return u
}
