/**
 * Cursors (common §7): good for the same arguments only, and for at least ten minutes; a cursor the server no longer
 * knows is `bad-cursor`. The kit wraps the provider's own cursor (an offset, a page token of the service) in a sealed
 * token bound to the tool, the arguments other than `limit` and `cursor`, and the account, so that a stateless server
 * can check it and nobody can read or forge it. The provider sees its own cursor only.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { PAGE } from '@ayni.org/ayni-feature-profiles'
import { errors } from './errors.js'

/** How long a cursor is good for, by default: an hour, beyond the ten minutes of common §7. */
export const DEFAULT_CURSOR_LIFETIME_SECONDS = 3600

interface Sealed {
  /** the tool, the arguments and the account the cursor is good for, digested */
  b: string
  /** the provider's own cursor */
  c: string
  /** expiry, seconds since the epoch */
  e: number
}

/** A canonical JSON of the arguments that bind a cursor: every argument but `limit` and `cursor`, keys in order. */
export function bindingOf(tool: string, args: Record<string, unknown>, accountId: string): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical)
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.keys(v as object)
          .sort()
          .map((k) => [k, canonical((v as Record<string, unknown>)[k])])
      )
    return v
  }
  const { limit: _l, cursor: _c, ...rest } = args
  return createHash('sha256')
    .update(JSON.stringify([tool, canonical(rest), accountId]))
    .digest('base64url')
}

export class CursorCodec {
  private readonly key: Buffer

  public constructor(
    secret: string | Uint8Array = randomBytes(32),
    private readonly lifetimeSeconds = DEFAULT_CURSOR_LIFETIME_SECONDS,
    private readonly now: () => number = () => Date.now()
  ) {
    if (lifetimeSeconds < PAGE.cursorLifetimeSeconds) throw new Error('a cursor must be good for ten minutes at least')
    this.key = createHash('sha256').update(secret).digest()
  }

  /** The cursor a client is given for a provider's own. */
  public seal(binding: string, providerCursor: string): string {
    const payload: Sealed = { b: binding, c: providerCursor, e: Math.floor(this.now() / 1000) + this.lifetimeSeconds }
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
    return Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url')
  }

  /** The provider's own cursor of a client's, or `bad-cursor` (unknown, expired, or given for other arguments). */
  public open(binding: string, cursor: string): string {
    let payload: Sealed
    try {
      const raw = Buffer.from(cursor, 'base64url')
      if (raw.length < 12 + 16 + 1) throw new Error('short')
      const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12))
      decipher.setAuthTag(raw.subarray(raw.length - 16))
      const text = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString(
        'utf8'
      )
      payload = JSON.parse(text) as Sealed
    } catch {
      throw errors.badCursor()
    }
    if (payload.b !== binding) throw errors.badCursor('The cursor was given for other arguments.')
    if (payload.e * 1000 < this.now()) throw errors.badCursor('The cursor has expired.')
    return payload.c
  }
}

/** A page of a list the provider holds whole, after the key its cursor names: each item once while none is added or removed before it. */
export function pageByKey<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  page: { limit: number; cursor?: string }
): { items: T[]; nextCursor?: string } {
  const sorted = [...items].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0))
  const start = page.cursor === undefined ? 0 : sorted.findIndex((i) => keyOf(i) > (page.cursor as string))
  const from = start < 0 ? sorted.length : start
  const slice = sorted.slice(from, from + page.limit)
  const last = slice[slice.length - 1]
  const more = from + page.limit < sorted.length
  return { items: slice, ...(more && last !== undefined ? { nextCursor: keyOf(last) } : {}) }
}

/** A page of a list in an order of its own (by start, newest first), by position: for a list that does not change between pages. */
export function pageByOffset<T>(
  items: readonly T[],
  page: { limit: number; cursor?: string }
): { items: T[]; nextCursor?: string } {
  const from = page.cursor === undefined ? 0 : Number(page.cursor)
  if (!Number.isInteger(from) || from < 0) throw errors.badCursor()
  const slice = items.slice(from, from + page.limit)
  return { items: slice, ...(from + page.limit < items.length ? { nextCursor: String(from + page.limit) } : {}) }
}
