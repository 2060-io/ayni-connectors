/**
 * Paths under the account's folder, as the references of a WebDAV server that is not a Nextcloud are made
 * (providers §3, FEAT-WEBDAV-002, 003): `/` for the folder itself, `/Reports/Q3.md` below it, each part decoded. A
 * reference with a `.` or `..` part, an empty part or a control character is refused before any request is sent, and
 * an item is inside a root only when its parts begin with the root's, compared part by part.
 */
import { errors } from '@ayni.org/ayni-provider-kit'

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

/** The parts of a reference, or `invalid-argument` naming the argument. */
export function refParts(ref: string, field: string): string[] {
  if (typeof ref !== 'string' || !ref.startsWith('/'))
    throw errors.invalidArgument(field, `"${field}" is not a reference this server gave.`)
  if (ref === '/') return []
  const parts = ref.slice(1).split('/')
  for (const p of parts)
    if (p === '' || p === '.' || p === '..' || CONTROL.test(p))
      throw errors.invalidArgument(field, `"${field}" is not a reference this server gave.`)
  return parts
}

export function refOf(parts: readonly string[]): string {
  return `/${parts.join('/')}`
}

/** Whether the parts of an item are the root's or below them, compared part by part. */
export function within(root: readonly string[], item: readonly string[]): boolean {
  return item.length >= root.length && root.every((p, i) => p === item[i])
}

/** A path segment encoded for a URL (RFC 3986 `pchar`). */
export function encodeSegment(part: string): string {
  return encodeURIComponent(part).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

/** A URL below a collection, from parts; a folder's ends with `/`. */
export function urlBelow(base: URL, parts: readonly string[], folder = false): URL {
  const u = new URL(base.toString())
  const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`
  u.pathname = `${basePath}${parts.map(encodeSegment).join('/')}${folder && parts.length ? '/' : ''}`
  return u
}

/** The decoded parts of a URL path (`/remote.php/dav/files/ana/A%20B/` is `remote.php`, `dav`, … `A B`). */
export function pathParts(pathname: string): string[] | undefined {
  const out: string[] = []
  for (const p of pathname.split('/')) {
    if (p === '') continue
    let d: string
    try {
      d = decodeURIComponent(p)
    } catch {
      return undefined
    }
    if (d === '.' || d === '..' || d.includes('/') || CONTROL.test(d)) return undefined
    out.push(d)
  }
  return out
}

/**
 * The parts of a server's `href` below a base collection, or `undefined` when it is not below it (an `href` may be a
 * path or a whole URL; one of another origin is never below).
 */
export function partsBelow(href: string, base: URL): string[] | undefined {
  let url: URL
  try {
    url = new URL(href, base)
  } catch {
    return undefined
  }
  if (url.origin !== base.origin) return undefined
  const all = pathParts(url.pathname)
  const baseParts = pathParts(base.pathname)
  if (!all || !baseParts || !within(baseParts, all)) return undefined
  return all.slice(baseParts.length)
}
