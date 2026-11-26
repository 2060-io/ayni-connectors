/**
 * The XML of WebDAV (RFC 4918), read with its namespaces and written with escaping. A server's answer is untrusted:
 * a document type declaration is refused (no entity of a server's is expanded), and only the five predefined entities
 * and character references are read.
 */

export interface XmlElement {
  /** the namespace URI, `''` for none */
  ns: string
  name: string
  /** attributes by local name (those of a namespace by `{ns}name`) */
  attrs: Record<string, string>
  children: (XmlElement | string)[]
}

export class XmlError extends Error {}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

function decodeEntities(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (_, ref: string) => {
    if (ref.startsWith('#x')) return String.fromCodePoint(Number.parseInt(ref.slice(2), 16))
    if (ref.startsWith('#')) return String.fromCodePoint(Number.parseInt(ref.slice(1), 10))
    const v = ENTITIES[ref]
    if (v === undefined) throw new XmlError(`an unknown entity &${ref};`)
    return v
  })
}

const NAME = /^[A-Za-z_][\w.\-:]*/

/** Reads a document and answers its root element. */
export function parseXml(text: string, maxDepth = 64): XmlElement {
  let i = 0
  const n = text.length
  const stack: { el: XmlElement; raw: string; scope: Map<string, string> }[] = []
  let root: XmlElement | undefined
  const baseScope = new Map<string, string>([
    ['xml', 'http://www.w3.org/XML/1998/namespace'],
    ['', ''],
  ])
  const resolve = (qname: string, scope: Map<string, string>, attr: boolean): { ns: string; name: string } => {
    const colon = qname.indexOf(':')
    if (colon < 0) return { ns: attr ? '' : (scope.get('') ?? ''), name: qname }
    const prefix = qname.slice(0, colon)
    const ns = scope.get(prefix)
    if (ns === undefined) throw new XmlError(`an undeclared prefix ${prefix}`)
    return { ns, name: qname.slice(colon + 1) }
  }
  while (i < n) {
    const lt = text.indexOf('<', i)
    const chunk = lt < 0 ? text.slice(i) : text.slice(i, lt)
    if (chunk.length) {
      const top = stack[stack.length - 1]
      if (top) top.el.children.push(decodeEntities(chunk))
      else if (chunk.trim()) throw new XmlError('text outside the root element')
    }
    if (lt < 0) break
    i = lt
    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i)
      if (end < 0) throw new XmlError('an unclosed processing instruction')
      i = end + 2
      continue
    }
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i)
      if (end < 0) throw new XmlError('an unclosed comment')
      i = end + 3
      continue
    }
    if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i)
      if (end < 0) throw new XmlError('an unclosed CDATA section')
      const top = stack[stack.length - 1]
      if (!top) throw new XmlError('CDATA outside the root element')
      top.el.children.push(text.slice(i + 9, end))
      i = end + 3
      continue
    }
    if (text.startsWith('<!', i)) throw new XmlError('a document type declaration is not read')
    if (text.startsWith('</', i)) {
      const end = text.indexOf('>', i)
      if (end < 0) throw new XmlError('an unclosed end tag')
      const raw = text.slice(i + 2, end).trim()
      const top = stack.pop()
      if (!top || top.raw !== raw) throw new XmlError(`an end tag ${raw} that closes nothing open`)
      i = end + 1
      continue
    }
    // a start tag
    i++
    const m = NAME.exec(text.slice(i, i + 256))
    if (!m) throw new XmlError('a tag with no name')
    const raw = m[0]
    i += raw.length
    const attrsRaw: [string, string][] = []
    for (;;) {
      while (i < n && /\s/.test(text[i] as string)) i++
      if (text.startsWith('/>', i) || text[i] === '>') break
      const am = NAME.exec(text.slice(i, i + 256))
      if (!am) throw new XmlError('an attribute with no name')
      i += am[0].length
      while (i < n && /\s/.test(text[i] as string)) i++
      if (text[i] !== '=') throw new XmlError('an attribute with no value')
      i++
      while (i < n && /\s/.test(text[i] as string)) i++
      const q = text[i]
      if (q !== '"' && q !== "'") throw new XmlError('an attribute value without quotes')
      const end = text.indexOf(q, i + 1)
      if (end < 0) throw new XmlError('an unclosed attribute value')
      attrsRaw.push([am[0], decodeEntities(text.slice(i + 1, end))])
      i = end + 1
    }
    const selfClosing = text.startsWith('/>', i)
    i += selfClosing ? 2 : 1
    const parentScope = stack[stack.length - 1]?.scope ?? baseScope
    let scope = parentScope
    for (const [k, v] of attrsRaw) {
      if (k === 'xmlns' || k.startsWith('xmlns:')) {
        if (scope === parentScope) scope = new Map(parentScope)
        scope.set(k === 'xmlns' ? '' : k.slice(6), v)
      }
    }
    const { ns, name } = resolve(raw, scope, false)
    const attrs: Record<string, string> = {}
    for (const [k, v] of attrsRaw) {
      if (k === 'xmlns' || k.startsWith('xmlns:')) continue
      const a = resolve(k, scope, true)
      attrs[a.ns ? `{${a.ns}}${a.name}` : a.name] = v
    }
    const el: XmlElement = { ns, name, attrs, children: [] }
    const top = stack[stack.length - 1]
    if (top) top.el.children.push(el)
    else if (root) throw new XmlError('a second root element')
    else root = el
    if (!selfClosing) {
      if (stack.length >= maxDepth) throw new XmlError('the document is nested too deep')
      stack.push({ el, raw, scope })
    }
  }
  if (stack.length) throw new XmlError('an element left open')
  if (!root) throw new XmlError('no root element')
  return root
}

export function isElement(x: XmlElement | string | undefined): x is XmlElement {
  return typeof x === 'object' && x !== null
}

/** The child elements of an element, of one name when given. */
export function childrenOf(el: XmlElement | undefined, ns?: string, name?: string): XmlElement[] {
  if (!el) return []
  return el.children.filter(
    (c): c is XmlElement => isElement(c) && (ns === undefined || c.ns === ns) && (name === undefined || c.name === name)
  )
}

export function childOf(el: XmlElement | undefined, ns: string, name: string): XmlElement | undefined {
  return childrenOf(el, ns, name)[0]
}

/** The text an element holds, its descendants' included. */
export function textOf(el: XmlElement | undefined): string {
  if (!el) return ''
  return el.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('')
}

/** Text escaped for an element's content or an attribute's value. */
export function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (c) => `&${{ '<': 'lt', '>': 'gt', '&': 'amp', '"': 'quot', "'": 'apos' }[c]};`)
}
