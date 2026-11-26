/**
 * The checks that hold for every answer of a run, made on each as it arrives and reported once at the end: both forms
 * of a result or an error (FEAT-CORE-006, 007), the location of every item (013), instants in UTC (017), no credential
 * in an answer (019), and the members every item and event carries (FEAT-FILES-002, 015, 063, FEAT-CAL-002, 017).
 */
import {
  CALENDAR_PROFILE,
  FILES_PROFILE,
  foreignItems,
  INSTANT_PATTERN,
  itemsOfResult,
  type ProfileDefinition,
  validateErrorContent,
  validateResult,
} from '@ayni.org/ayni-feature-profiles'
import type { Json, Outcome } from './session.js'

const INSTANT = new RegExp(INSTANT_PATTERN)

export interface Tally {
  seen: number
  violations: string[]
}

function canonical(v: unknown): string {
  const sort = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sort)
    if (x && typeof x === 'object')
      return Object.fromEntries(
        Object.keys(x)
          .sort()
          .map((k) => [k, sort((x as Json)[k])])
      )
    return x
  }
  return JSON.stringify(sort(v))
}

export class Observer {
  private readonly tallies = new Map<string, Tally>()
  /** the declarations of the run, by profile, for checks that depend on a capability */
  public declarations: Record<string, { capabilities?: string[] }> = {}

  public constructor(private readonly secrets: string[]) {}

  private tally(key: string): Tally {
    let t = this.tallies.get(key)
    if (!t) {
      t = { seen: 0, violations: [] }
      this.tallies.set(key, t)
    }
    return t
  }

  /** One observation of a rule, held or broken. */
  public check(profile: string, id: string, held: boolean, what: () => string): void {
    const t = this.tally(`${profile} ${id}`)
    t.seen++
    if (!held && t.violations.length < 5) t.violations.push(what())
  }

  public result(profile: string, id: string): Tally {
    return this.tally(`${profile} ${id}`)
  }

  private profileOf(tool: string): ProfileDefinition | undefined {
    if (tool.startsWith(FILES_PROFILE.prefix)) return FILES_PROFILE
    if (tool.startsWith(CALENDAR_PROFILE.prefix)) return CALENDAR_PROFILE
    return undefined
  }

  public thrown(session: string, tool: string, message: string): void {
    const p = this.profileOf(tool)
    if (p) this.check(p.id, 'FEAT-CORE-006', false, () => `${session} ${tool}: no tool result (${message})`)
  }

  /** Records an answer and makes it an outcome. */
  public answer(session: string, tool: string, args: Json, raw: Json): Outcome {
    const p = this.profileOf(tool)
    const id = p?.id ?? 'unknown'
    const structured = raw.structuredContent as Json | undefined
    const blocks = (raw.content as { type: string; text?: string }[] | undefined) ?? []
    const text = blocks.find((b) => b.type === 'text')?.text
    let parsed: unknown
    try {
      parsed = text === undefined ? undefined : JSON.parse(text)
    } catch {
      parsed = undefined
    }
    const isError = raw.isError === true
    const rule = isError ? 'FEAT-CORE-007' : 'FEAT-CORE-006'
    this.check(id, rule, structured !== undefined && canonical(parsed) === canonical(structured), () =>
      structured === undefined
        ? `${session} ${tool}: no structuredContent`
        : `${session} ${tool}: the text block is not the structured content as JSON`
    )
    const json = JSON.stringify(raw)
    for (const s of this.secrets)
      this.check(
        id,
        'FEAT-CORE-019',
        !json.includes(s),
        () => `${session} ${tool}: an answer holds a credential of the run`
      )
    if (isError) {
      if (p) {
        const problems = validateErrorContent(p, structured)
        this.check(id, 'FEAT-CORE-007', problems.length === 0, () => `${session} ${tool}: ${problems.join('; ')}`)
      }
      const error = (structured?.error ?? { code: 'unavailable', message: '' }) as {
        code: string
        message: string
        field?: string
      }
      this.check(
        id,
        'FEAT-CORE-007',
        !/https?:\/\//i.test(String(error.message ?? '')),
        () => `${session} ${tool}: the message holds an address`
      )
      return { ok: false, error, raw }
    }
    const content = structured ?? {}
    if (p) {
      const problems = validateResult(p, tool, content)
      this.check(
        id,
        'FEAT-CORE-006',
        problems.length === 0,
        () => `${session} ${tool}: ${problems.slice(0, 3).join('; ')}`
      )
      const tool_ = p.tools.find((t) => t.name === tool)
      if (tool_?.located) {
        const foreign = foreignItems(p, tool, args, content)
        this.check(
          id,
          'FEAT-CORE-013',
          foreign.length === 0,
          () => `${session} ${tool}: ${foreign.length} items do not carry the location of the call`
        )
      }
      for (const item of itemsOfResult(p, tool, content)) this.item(p, session, tool, args, item)
    }
    return { ok: true, content, raw }
  }

  private item(p: ProfileDefinition, session: string, tool: string, args: Json, item: Json): void {
    for (const k of ['createdAt', 'modifiedAt'])
      if (item[k] !== undefined)
        this.check(
          p.id,
          'FEAT-CORE-017',
          INSTANT.test(String(item[k])),
          () => `${session} ${tool}: ${k} ${String(item[k])}`
        )
    if (p === FILES_PROFILE) {
      const missing = ['ref', 'root', 'kind', 'name', 'path'].filter((k) => item[k] === undefined)
      if (item.kind === 'file') for (const k of ['mediaType', 'version']) if (item[k] === undefined) missing.push(k)
      const isRoot = item.ref === args.root
      if (!isRoot && item.parent === undefined && tool !== 'files_list_trash') missing.push('parent')
      this.check(
        p.id,
        'FEAT-FILES-002',
        missing.length === 0,
        () => `${session} ${tool}: an item lacks ${missing.join(', ')}`
      )
      if (isRoot)
        this.check(
          p.id,
          'FEAT-FILES-002',
          item.path === '/',
          () => `${session} ${tool}: the root's path is ${String(item.path)}`
        )
      this.check(
        p.id,
        'FEAT-FILES-015',
        item.native === undefined || item.native === true,
        () => `${session} ${tool}: native ${String(item.native)}`
      )
      this.check(
        p.id,
        'FEAT-FILES-015',
        !String(item.modifiedBy ?? '').includes('@'),
        () => `${session} ${tool}: modifiedBy holds an address`
      )
      if (item.native === true && this.declarations[p.id]?.capabilities?.includes('export'))
        this.check(
          p.id,
          'FEAT-FILES-063',
          Array.isArray(item.exportTypes),
          () => `${session} ${tool}: a native document without exportTypes`
        )
    }
    if (p === CALENDAR_PROFILE) {
      const required = [
        'ref',
        'calendar',
        'title',
        'allDay',
        'start',
        'end',
        'status',
        'busy',
        'mine',
        'recurring',
        'version',
      ]
      const missing = required.filter((k) => item[k] === undefined)
      this.check(
        p.id,
        'FEAT-CAL-002',
        missing.length === 0,
        () => `${session} ${tool}: an event lacks ${missing.join(', ')}`
      )
      for (const a of (item.attendees as Json[] | undefined) ?? []) {
        const ok =
          typeof a.address === 'string' &&
          !/^mailto:/i.test(a.address) &&
          ['needs-action', 'accepted', 'tentative', 'declined'].includes(String(a.response)) &&
          (a.self === undefined || a.self === true) &&
          (a.optional === undefined || a.optional === true)
        this.check(p.id, 'FEAT-CAL-017', ok, () => `${session} ${tool}: attendee ${JSON.stringify(a)}`)
      }
    }
  }
}
