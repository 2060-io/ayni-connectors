/**
 * The checks of a call's arguments that the profiles give, in one order (common §4 and §9): an argument the profile
 * does not know is `invalid-argument`; an argument or a value of a capability the server did not declare is
 * `not-supported`; then the schema and the rules between arguments (`invalid-argument`); then a value of a part of the
 * declaration the server does not have (an audience, a search of contents, the role `manager`), `not-supported`; then
 * the rules of times and repetitions. A provider refuses with the answer; a client may run
 * the same checks before it sends a call.
 */
import { CALENDAR_ID, FREE_BUSY_MAX_DAYS, LIST_EVENTS_MAX_DAYS } from './calendar.js'
import type { DeclarationBase } from './common.js'
import { FILES_ID } from './files.js'
import { argumentsFor, inputSchemaFor, type ProfileDefinition, type ToolDefinition } from './profile.js'
import { parseRule } from './rule.js'
import { topMemberOf, validateSchema } from './validation.js'

/** Why a call is refused before it reaches the service. */
export interface CallRefusal {
  code: 'invalid-argument' | 'not-supported'
  field?: string
  message: string
}

type Declaration = DeclarationBase & Record<string, unknown>
type Args = Record<string, unknown>

function invalid(field: string, message: string): CallRefusal {
  return { code: 'invalid-argument', field, message }
}
function unsupported(field: string, message: string): CallRefusal {
  return { code: 'not-supported', field, message }
}

/** The checks of a call against a server's declaration; `undefined` when the call may go to the service. */
export function checkCall(
  profile: ProfileDefinition,
  toolName: string,
  rawArgs: unknown,
  declaration: Declaration
): CallRefusal | undefined {
  const tool = profile.tools.find((t) => t.name === toolName)
  if (!tool) throw new Error(`${toolName} is no tool of ${profile.id} ${profile.version}`)
  if (rawArgs !== undefined && (rawArgs === null || typeof rawArgs !== 'object' || Array.isArray(rawArgs)))
    return { code: 'invalid-argument', message: 'The arguments of a call are an object.' }
  const args = (rawArgs ?? {}) as Args
  const capabilities = new Set<string>(declaration.capabilities)

  // 1. arguments the profile does not know, then arguments of a capability not declared
  const known = new Map(tool.arguments.map((a) => [a.name, a]))
  for (const name of Object.keys(args)) {
    const arg = known.get(name)
    if (!arg) return invalid(name, `${toolName} takes no argument "${name}".`)
  }
  for (const name of Object.keys(args)) {
    const arg = known.get(name)
    if (arg?.capability && !capabilities.has(arg.capability))
      return unsupported(
        name,
        `"${name}" belongs to the capability ${arg.capability}, which this server does not have.`
      )
  }
  // 2. values of a capability not declared
  for (const arg of tool.arguments) {
    if (!(arg.name in args) || !arg.capabilityValues) continue
    for (const v of arg.capabilityValues)
      if (args[arg.name] === v.value && !capabilities.has(v.capability))
        return unsupported(
          arg.name,
          `${arg.name} "${String(v.value)}" belongs to the capability ${v.capability}, which this server does not have.`
        )
  }
  // 3. the schema of the arguments in use
  const problems = validateSchema(inputSchemaFor(tool, capabilities), args)
  const problem = problems[0]
  if (problem) {
    const field = topMemberOf(problem) ?? 'arguments'
    if (!problem.instancePath && problem.keyword === 'required')
      return invalid(field, `${toolName} requires "${field}".`)
    return invalid(field, `The argument "${field}" ${problem.message ?? 'is not valid'}.`)
  }

  // 4. rules between arguments
  for (const c of tool.constraints ?? []) {
    const given = c.arguments.filter((a) => args[a] !== undefined)
    if (c.kind === 'exactly-one' && given.length !== 1)
      return invalid(c.field, `Give exactly one of ${c.arguments.map((a) => `"${a}"`).join(' and ')}.`)
    if (c.kind === 'at-least-one' && given.length === 0)
      return invalid(c.field, `Give at least one of ${c.arguments.map((a) => `"${a}"`).join(' and ')}.`)
    if (c.kind === 'together' && given.length !== 0 && given.length !== c.arguments.length) {
      const field = given[0] ?? c.arguments[0] ?? 'arguments'
      return invalid(field, `Give ${c.arguments.map((a) => `"${a}"`).join(' and ')} together, or none of them.`)
    }
  }

  // 5. values of a part of the declaration the server does not have
  const declared = declaredOptions(profile.id, tool, args, declaration)
  if (declared) return declared

  // 6. the rules of the profile that a schema does not carry
  if (profile.id === CALENDAR_ID) return calendarRules(toolName, args)
  return undefined
}

/** The parts of a declaration that narrow a call: Files' audiences, its telling of recipients, contents searched, managers. */
function declaredOptions(
  profileId: string,
  tool: ToolDefinition,
  args: Args,
  declaration: Declaration
): CallRefusal | undefined {
  if (profileId !== FILES_ID) return undefined
  if (tool.name === 'files_search' && args.in === 'content') {
    const search = declaration.search as { content?: boolean } | undefined
    if (search?.content === false) return unsupported('in', 'This server does not search the content of files.')
  }
  if (tool.name === 'files_share') {
    const share = (declaration.share ?? {}) as { audiences?: string[]; notify?: boolean }
    if (args.audience !== undefined && !(share.audiences ?? []).includes(args.audience as string))
      return unsupported('audience', `This server does not share with the audience "${String(args.audience)}".`)
    for (const name of ['notify', 'message'])
      if (args[name] !== undefined && share.notify !== true)
        return unsupported(name, 'This server cannot tell recipients of a share.')
    if (args.role === 'manager') {
      const teamRoots = declaration['team-roots'] as { manager?: boolean } | undefined
      if (teamRoots?.manager !== true) return unsupported('role', 'This server has no role "manager".')
    }
  }
  return undefined
}

const DATE = /^(\d{4})-(\d\d)-(\d\d)$/
const DATE_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/i

/** Whether a string is an RFC 3339 `full-date` of a day that exists. */
export function isFullDate(value: string): boolean {
  const m = DATE.exec(value)
  if (!m) return false
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3])
}

/** Whether a string is an RFC 3339 `date-time`, with its offset. */
export function isDateTime(value: string): boolean {
  return DATE_TIME.test(value) && !Number.isNaN(Date.parse(value))
}

/** Whether a name is a zone of the IANA time zone database that this runtime knows (not an offset). */
export function isTimeZone(name: string): boolean {
  if (/^[+-]\d/.test(name) || name.length > 64) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name })
    return true
  } catch {
    return false
  }
}

const DAY_MS = 86_400_000

function span(args: Args, maxDays: number): CallRefusal | undefined {
  const from = Date.parse(args.from as string)
  const to = Date.parse(args.to as string)
  if (!(to > from)) return invalid('to', '"to" is after "from".')
  if (to - from > maxDays * DAY_MS) return invalid('to', `"to" is at most ${maxDays} days after "from".`)
  return undefined
}

function times(args: Args, allDay: boolean | undefined): CallRefusal | undefined {
  const start = args.start as string | undefined
  const end = args.end as string | undefined
  if (start === undefined || end === undefined) {
    // a change of `allDay` alone is the provider's to check against the event
    return undefined
  }
  const form = allDay ?? isFullDate(start)
  for (const [name, value] of [
    ['start', start],
    ['end', end],
  ] as const) {
    if (form && !isFullDate(value)) return invalid(name, `"${name}" of an all-day event is a date (2026-11-23).`)
    if (!form && !isDateTime(value))
      return invalid(name, `"${name}" is a date-time with its offset (2026-11-23T10:00:00+01:00).`)
  }
  const after = form ? end > start : Date.parse(end) > Date.parse(start)
  if (!after) return invalid('end', '"end" is after "start".')
  return undefined
}

function calendarRules(toolName: string, args: Args): CallRefusal | undefined {
  switch (toolName) {
    case 'calendar_list_events':
      return span(args, LIST_EVENTS_MAX_DAYS)
    case 'calendar_free_busy':
      return span(args, FREE_BUSY_MAX_DAYS)
    case 'calendar_create_event':
    case 'calendar_update_event': {
      const creation = toolName === 'calendar_create_event'
      const allDay = creation ? ((args.allDay as boolean | undefined) ?? false) : (args.allDay as boolean | undefined)
      const t = times(args, allDay)
      if (t) return t
      if (args.timeZone !== undefined && !isTimeZone(args.timeZone as string))
        return invalid('timeZone', `"${String(args.timeZone)}" is no time zone of the IANA time zone database.`)
      if (args.rule !== undefined) {
        const r = parseRule(args.rule as string)
        if ('error' in r) return { code: r.error, field: 'rule', message: r.message }
        if (creation && !allDay && args.timeZone === undefined)
          return invalid('timeZone', 'A timed event that repeats needs a time zone.')
      }
      return undefined
    }
    default:
      return undefined
  }
}

/** The arguments of a tool in use with a declaration, by name: for a client that builds a call. */
export function argumentNamesFor(tool: ToolDefinition, declaration: Declaration): string[] {
  return argumentsFor(tool, declaration.capabilities).map((a) => a.name)
}
