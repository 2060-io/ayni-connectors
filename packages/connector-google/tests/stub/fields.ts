/**
 * Google's partial responses: the `fields` parameter (`nextPageToken,files(id,name,lastModifyingUser(displayName))`,
 * `user/emailAddress`, `*`) selects the members of an answer, so that a connector that forgets to ask for a member does
 * not get it from the stub either.
 */

type Selection = Map<string, Selection | true>

/** Parses a `fields` value. */
export function parseFields(spec: string): Selection {
  let i = 0
  const list = (): Selection => {
    const out: Selection = new Map()
    for (;;) {
      item(out)
      if (spec[i] === ',') {
        i++
        continue
      }
      return out
    }
  }
  const name = (): string => {
    const m = /^[A-Za-z0-9_*@.$-]+/.exec(spec.slice(i))
    if (!m) throw new Error(`invalid fields at ${i}: ${spec}`)
    i += m[0].length
    return m[0]
  }
  const item = (into: Selection) => {
    const path = [name()]
    while (spec[i] === '/') {
      i++
      path.push(name())
    }
    let leaf: Selection | true = true
    if (spec[i] === '(') {
      i++
      leaf = list()
      if (spec[i] !== ')') throw new Error(`invalid fields: ${spec}`)
      i++
    }
    let at = into
    for (const [k, p] of path.entries()) {
      if (k === path.length - 1) {
        const existing = at.get(p)
        if (existing instanceof Map && leaf instanceof Map) for (const [a, b] of leaf) existing.set(a, b)
        else at.set(p, leaf)
      } else {
        let next = at.get(p)
        if (!(next instanceof Map)) {
          next = new Map()
          at.set(p, next)
        }
        at = next
      }
    }
  }
  const out = list()
  if (i !== spec.length) throw new Error(`invalid fields: ${spec}`)
  return out
}

/** The members of a value that a selection names. */
export function select(value: unknown, selection: Selection | true): unknown {
  if (selection === true || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => select(v, selection))
  if (selection.has('*')) return value
  const out: Record<string, unknown> = {}
  for (const [k, sub] of selection) {
    const v = (value as Record<string, unknown>)[k]
    if (v !== undefined) out[k] = select(v, sub)
  }
  return out
}

/** An answer with the `fields` a request names, or the default members of the method when it names none. */
export function partial(value: unknown, fields: string | null, defaults?: string): unknown {
  const spec = fields ?? defaults
  return spec ? select(value, parseFields(spec)) : value
}
