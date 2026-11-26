/**
 * Pages of the profiles over Google's pages (common §7, FEAT-CORE-016, 026). Google may answer fewer items than asked,
 * even an empty page before the end, and the connector keeps some of its items only (those inside the root, those a
 * search keeps): a page of the profile is filled from as many of Google's pages as it takes, and its cursor names
 * Google's page and the position in it where the next page starts. A page of `limit` items carries `nextCursor` only
 * when one more item is known to follow, so the last page is never an empty one. Google's pages are asked with one
 * size, so that the same page token names the same items again.
 */
import { errors } from '@ayni.org/ayni-provider-kit'

export interface GooglePage<T> {
  items: T[]
  next?: string
}

interface Position {
  /** Google's page token, absent for the first page */
  t?: string
  /** the position of the next item in that page */
  o: number
}

function open(cursor: string | undefined): Position {
  if (cursor === undefined) return { o: 0 }
  try {
    const p = JSON.parse(cursor) as Position
    if (typeof p.o !== 'number' || p.o < 0 || (p.t !== undefined && typeof p.t !== 'string')) throw new Error('shape')
    return p
  } catch {
    throw errors.badCursor()
  }
}

const seal = (p: Position) => JSON.stringify(p)

/** The most of Google's pages read for one page of the profile, before a page is answered as it stands. */
export const MAX_GOOGLE_PAGES = 25

/**
 * A page of `limit` items: each item of Google's pages from the cursor's position is given to `keep`, which answers
 * the profile's item, or `undefined` to leave it out.
 */
export async function fillPage<T, R>(
  fetchPage: (token: string | undefined) => Promise<GooglePage<T>>,
  keep: (item: T) => Promise<R | undefined> | R | undefined,
  page: { limit: number; cursor?: string }
): Promise<{ items: R[]; nextCursor?: string }> {
  let { t, o } = open(page.cursor)
  const out: R[] = []
  for (let read = 0; read < MAX_GOOGLE_PAGES; read++) {
    const gp = await fetchPage(t)
    if (o > gp.items.length) throw errors.badCursor('The cursor names a place that no longer exists.')
    for (let i = o; i < gp.items.length; i++) {
      const r = await keep(gp.items[i] as T)
      if (r === undefined) continue
      if (out.length === page.limit) return { items: out, nextCursor: seal({ ...(t ? { t } : {}), o: i }) }
      out.push(r)
    }
    if (!gp.next) return { items: out }
    t = gp.next
    o = 0
  }
  // a page answered as it stands after many of Google's: the next one starts where this one stopped
  return { items: out, nextCursor: seal({ ...(t ? { t } : {}), o }) }
}

/** Every item of Google's pages, for a list the connector holds whole (to order it, or to read it newest first). */
export async function allPages<T>(
  fetchPage: (token: string | undefined) => Promise<GooglePage<T>>,
  maxPages = 50
): Promise<T[]> {
  const out: T[] = []
  let t: string | undefined
  for (let read = 0; read < maxPages; read++) {
    const gp = await fetchPage(t)
    out.push(...gp.items)
    if (!gp.next) return out
    t = gp.next
  }
  throw errors.unavailable('Google answered more pages than the connector reads for one list.')
}
