/**
 * iCalendar (RFC 5545) as the connector reads and changes it: content lines unfolded and folded again, components,
 * properties and parameters kept as they were, those the connector does not know included (providers §4,
 * FEAT-CALDAV-004), and the values it reads: texts, dates, date-times and durations.
 */
import { type Local, localAsUtc, type Zone } from './tz.js'

export interface Param {
  name: string
  /** the values, unquoted */
  values: string[]
}

export interface Property {
  name: string
  params: Param[]
  /** the value as written, escapes included */
  value: string
}

export interface Component {
  name: string
  props: Property[]
  components: Component[]
}

export class ICalError extends Error {}

function parseLine(line: string): Property {
  let i = 0
  const n = line.length
  const nameEnd = line.search(/[;:]/)
  if (nameEnd <= 0) throw new ICalError('a content line with no name')
  const name = line.slice(0, nameEnd).toUpperCase()
  i = nameEnd
  const params: Param[] = []
  while (i < n && line[i] === ';') {
    i++
    const eq = line.indexOf('=', i)
    if (eq < 0) throw new ICalError('a parameter with no value')
    const pname = line.slice(i, eq).toUpperCase()
    i = eq + 1
    const values: string[] = []
    for (;;) {
      if (line[i] === '"') {
        const end = line.indexOf('"', i + 1)
        if (end < 0) throw new ICalError('an unclosed quoted parameter value')
        values.push(line.slice(i + 1, end))
        i = end + 1
      } else {
        let j = i
        while (j < n && line[j] !== ',' && line[j] !== ';' && line[j] !== ':') j++
        values.push(line.slice(i, j))
        i = j
      }
      if (line[i] === ',') {
        i++
        continue
      }
      break
    }
    params.push({ name: pname, values })
  }
  if (line[i] !== ':') throw new ICalError('a content line with no value')
  return { name, params, value: line.slice(i + 1) }
}

/** Reads an iCalendar object: its outermost component (a `VCALENDAR`). */
export function parseICalendar(text: string): Component {
  const lines = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n')
  const stack: Component[] = []
  let root: Component | undefined
  for (const raw of lines) {
    if (!raw.trim()) continue
    const p = parseLine(raw)
    if (p.name === 'BEGIN') {
      const c: Component = { name: p.value.toUpperCase(), props: [], components: [] }
      const top = stack[stack.length - 1]
      if (top) top.components.push(c)
      else if (root) throw new ICalError('a second object')
      else root = c
      stack.push(c)
      if (stack.length > 16) throw new ICalError('components nested too deep')
    } else if (p.name === 'END') {
      const top = stack.pop()
      if (!top || top.name !== p.value.toUpperCase()) throw new ICalError('an END that closes nothing open')
    } else {
      const top = stack[stack.length - 1]
      if (!top) throw new ICalError('a property outside any component')
      top.props.push(p)
    }
  }
  if (stack.length || !root) throw new ICalError('an object left open')
  return root
}

function quoteParam(v: string): string {
  return /[:;,]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, "'")}"` : v
}

function propLine(p: Property): string {
  const params = p.params.map((x) => `;${x.name}=${x.values.map(quoteParam).join(',')}`).join('')
  return `${p.name}${params}:${p.value}`
}

/** A content line folded at 75 octets (RFC 5545 §3.1), never inside a character. */
export function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8')
  if (bytes.length <= 75) return line
  const out: string[] = []
  let start = 0
  let limit = 75
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length)
    while (end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--
    out.push(bytes.subarray(start, end).toString('utf8'))
    start = end
    limit = 74
  }
  return out.join('\r\n ')
}

export function serializeComponent(c: Component): string[] {
  return [
    `BEGIN:${c.name}`,
    ...c.props.map((p) => fold(propLine(p))),
    ...c.components.flatMap(serializeComponent),
    `END:${c.name}`,
  ]
}

export function serializeICalendar(c: Component): string {
  return `${serializeComponent(c).join('\r\n')}\r\n`
}

export function getProp(c: Component, name: string): Property | undefined {
  return c.props.find((p) => p.name === name)
}

export function getProps(c: Component, name: string): Property[] {
  return c.props.filter((p) => p.name === name)
}

export function removeProps(c: Component, name: string): void {
  c.props = c.props.filter((p) => p.name !== name)
}

/** Sets a property: the first of its name replaced where it is, the others removed; added at the end otherwise. */
export function setProp(c: Component, name: string, value: string, params: Param[] = []): Property {
  const p: Property = { name, params, value }
  const at = c.props.findIndex((x) => x.name === name)
  if (at < 0) c.props.push(p)
  else {
    c.props[at] = p
    c.props = c.props.filter((x, i) => x.name !== name || i === at)
  }
  return p
}

export function paramOf(p: Property | undefined, name: string): string | undefined {
  return p?.params.find((x) => x.name === name)?.values[0]
}

export function setParam(p: Property, name: string, value: string | undefined): void {
  p.params = p.params.filter((x) => x.name !== name)
  if (value !== undefined) p.params.push({ name, values: [value] })
}

/** A TEXT value read (RFC 5545 §3.3.11). */
export function unescapeText(v: string): string {
  return v.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c))
}

export function escapeText(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
}

export function textOf(c: Component, name: string): string | undefined {
  const p = getProp(c, name)
  return p ? unescapeText(p.value) : undefined
}

// ---- times ---------------------------------------------------------------------------------------------------

/** A DATE or DATE-TIME value: a day, an instant in UTC, or a wall clock (in a `TZID`, or floating). */
export type ICalTime =
  | { kind: 'date'; y: number; m: number; d: number }
  | { kind: 'utc'; ms: number }
  | { kind: 'local'; l: Local; tzid?: string }

const DATE = /^(\d{4})(\d\d)(\d\d)$/
const DATE_TIME = /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)(Z?)$/

export function parseTime(value: string, tzid?: string, valueType?: string): ICalTime | undefined {
  const v = value.trim()
  const d = DATE.exec(v)
  if (d && valueType !== 'DATE-TIME') return { kind: 'date', y: Number(d[1]), m: Number(d[2]), d: Number(d[3]) }
  const t = DATE_TIME.exec(v)
  if (!t) return undefined
  const l: Local = {
    y: Number(t[1]),
    m: Number(t[2]),
    d: Number(t[3]),
    h: Number(t[4]),
    mi: Number(t[5]),
    s: Math.min(59, Number(t[6])),
  }
  if (t[7] === 'Z') return { kind: 'utc', ms: localAsUtc(l) }
  return { kind: 'local', l, ...(tzid ? { tzid } : {}) }
}

/** A property's time values (`DTSTART`, or each value of an `EXDATE` or `RDATE`). */
export function timesOf(p: Property): ICalTime[] {
  const tzid = paramOf(p, 'TZID')
  const type = paramOf(p, 'VALUE')
  if (type === 'PERIOD')
    return p.value
      .split(',')
      .map((x) => parseTime(x.split('/')[0] ?? '', tzid))
      .filter((x): x is ICalTime => !!x)
  return p.value
    .split(',')
    .map((x) => parseTime(x, tzid, type))
    .filter((x): x is ICalTime => !!x)
}

export function timeOf(c: Component, name: string): ICalTime | undefined {
  const p = getProp(c, name)
  return p ? timesOf(p)[0] : undefined
}

/** A DURATION value in seconds, and its days and weeks apart for a wall clock (RFC 5545 §3.3.6). */
export function parseDuration(v: string): { days: number; seconds: number } | undefined {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim())
  if (!m) return undefined
  const sign = m[1] === '-' ? -1 : 1
  const days = (Number(m[2] ?? 0) * 7 + Number(m[3] ?? 0)) * sign
  const seconds = (Number(m[4] ?? 0) * 3600 + Number(m[5] ?? 0) * 60 + Number(m[6] ?? 0)) * sign
  return { days, seconds }
}

/** The zone a time is read in: its `TZID`'s, or the floating time's own. */
export type ZoneOf = (tzid: string | undefined) => Zone
