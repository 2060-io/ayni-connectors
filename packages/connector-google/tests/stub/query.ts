/**
 * Drive's query language (`q` of `files.list`), the part the stub reads: `and`, `or`, `not`, parentheses; `'x' in
 * parents`; `name` with `=`, `!=` and `contains`; `fullText contains`; `mimeType` with `=`, `!=` and `contains`;
 * `trashed` and `sharedWithMe` with `=` and `!=`. Strings are single-quoted with `\'` and `\\` escaped (Drive's "Search
 * query terms and operators"). Anything else is refused as Drive refuses a query it cannot read (`400 invalid`), so
 * that a connector cannot pass an operator of its caller through unnoticed.
 *
 * `name contains` matches a prefix of a word of the name (Drive: "prefix matching for a name term"); `fullText
 * contains` matches whole words of the name, the description and the text (Drive: "matching on entire string tokens").
 * How Drive splits a name into words is not documented: the stub splits on anything that is not a letter or a digit.
 */

export interface QueryTarget {
  name: string
  mimeType: string
  parents: string[]
  trashed: boolean
  sharedWithMe: boolean
  fullText: string
}

type Node =
  | { op: 'and' | 'or'; a: Node; b: Node }
  | { op: 'not'; a: Node }
  | { op: 'in'; value: string; field: 'parents' }
  | { op: '=' | '!=' | 'contains'; field: string; value: string | boolean }

type Token = { t: 'str'; v: string } | { t: 'word'; v: string } | { t: 'sym'; v: string }

export class QueryError extends Error {}

function lex(q: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < q.length) {
    const c = q[i] as string
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === "'") {
      let v = ''
      i++
      for (;;) {
        if (i >= q.length) throw new QueryError('unterminated string')
        const d = q[i] as string
        if (d === '\\') {
          const e = q[i + 1]
          if (e !== "'" && e !== '\\') throw new QueryError('invalid escape')
          v += e
          i += 2
          continue
        }
        if (d === "'") {
          i++
          break
        }
        v += d
        i++
      }
      out.push({ t: 'str', v })
      continue
    }
    if (c === '(' || c === ')') {
      out.push({ t: 'sym', v: c })
      i++
      continue
    }
    if (c === '!' && q[i + 1] === '=') {
      out.push({ t: 'sym', v: '!=' })
      i += 2
      continue
    }
    if (c === '=' || c === '<' || c === '>') {
      const two = q.slice(i, i + 2)
      const v = two === '<=' || two === '>=' ? two : c
      out.push({ t: 'sym', v })
      i += v.length
      continue
    }
    const m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(q.slice(i))
    if (!m) throw new QueryError(`unexpected ${c}`)
    out.push({ t: 'word', v: m[0] })
    i += m[0].length
  }
  return out
}

export function parseQuery(q: string): Node {
  const tokens = lex(q)
  let i = 0
  const peek = () => tokens[i]
  const take = () => {
    const t = tokens[i++]
    if (!t) throw new QueryError('unexpected end')
    return t
  }
  const isWord = (t: Token | undefined, v: string) => t?.t === 'word' && t.v.toLowerCase() === v
  const or = (): Node => {
    let a = and()
    while (isWord(peek(), 'or')) {
      take()
      a = { op: 'or', a, b: and() }
    }
    return a
  }
  const and = (): Node => {
    let a = unary()
    while (isWord(peek(), 'and')) {
      take()
      a = { op: 'and', a, b: unary() }
    }
    return a
  }
  const unary = (): Node => {
    if (isWord(peek(), 'not')) {
      take()
      return { op: 'not', a: unary() }
    }
    const t = peek()
    if (t?.t === 'sym' && t.v === '(') {
      take()
      const inner = or()
      const close = take()
      if (close.t !== 'sym' || close.v !== ')') throw new QueryError('expected )')
      return inner
    }
    return comparison()
  }
  const comparison = (): Node => {
    const first = take()
    if (first.t === 'str') {
      if (!isWord(take(), 'in')) throw new QueryError('expected in')
      const field = take()
      if (field.t !== 'word' || field.v !== 'parents') throw new QueryError('only parents takes in')
      return { op: 'in', value: first.v, field: 'parents' }
    }
    if (first.t !== 'word') throw new QueryError('expected a term')
    const field = first.v
    const opTok = take()
    const op = opTok.t === 'word' && opTok.v === 'contains' ? 'contains' : opTok.t === 'sym' ? opTok.v : ''
    const valueTok = take()
    const value: string | boolean =
      valueTok.t === 'str'
        ? valueTok.v
        : valueTok.t === 'word' && (valueTok.v === 'true' || valueTok.v === 'false')
          ? valueTok.v === 'true'
          : (() => {
              throw new QueryError('expected a value')
            })()
    const allowed: Record<string, string[]> = {
      name: ['=', '!=', 'contains'],
      fullText: ['contains'],
      mimeType: ['=', '!=', 'contains'],
      trashed: ['=', '!='],
      sharedWithMe: ['=', '!='],
    }
    if (!allowed[field]?.includes(op)) throw new QueryError(`the stub does not read ${field} ${op}`)
    if ((field === 'trashed' || field === 'sharedWithMe') !== (typeof value === 'boolean'))
      throw new QueryError(`${field} takes a value of another type`)
    return { op: op as '=' | '!=' | 'contains', field, value }
  }
  const node = or()
  if (i !== tokens.length) throw new QueryError('unexpected text after the query')
  return node
}

/** The words of a text, as the stub splits them. */
export function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

function namePrefix(name: string, value: string): boolean {
  const n = ` ${wordsOf(name).join(' ')}`
  const v = wordsOf(value).join(' ')
  return v.length > 0 && n.includes(` ${v}`)
}

function wholeWords(text: string, value: string): boolean {
  const n = ` ${wordsOf(text).join(' ')} `
  const v = wordsOf(value).join(' ')
  return v.length > 0 && n.includes(` ${v} `)
}

export function matches(node: Node, f: QueryTarget): boolean {
  switch (node.op) {
    case 'and':
      return matches(node.a, f) && matches(node.b, f)
    case 'or':
      return matches(node.a, f) || matches(node.b, f)
    case 'not':
      return !matches(node.a, f)
    case 'in':
      return f.parents.includes(node.value)
    default: {
      const actual =
        node.field === 'name'
          ? f.name
          : node.field === 'mimeType'
            ? f.mimeType
            : node.field === 'trashed'
              ? f.trashed
              : node.field === 'sharedWithMe'
                ? f.sharedWithMe
                : f.fullText
      if (node.op === '=') return actual === node.value
      if (node.op === '!=') return actual !== node.value
      const value = String(node.value)
      if (node.field === 'name') return namePrefix(String(actual), value)
      if (node.field === 'fullText') return wholeWords(String(actual), value)
      return String(actual).includes(value)
    }
  }
}
