/**
 * The machine-readable shape of a feature profile (common §2 and §4): for each tool its name, title, description,
 * arguments with their titles, result, effect, capability, errors and mark of content written by others, and what
 * follows from them: the tools of a set of capabilities, their MCP definitions, and the effect of one call.
 */
import {
  annotationsOf,
  CURSOR_ARGUMENT_SCHEMA,
  type Effect,
  type ErrorDefinition,
  type JsonSchema,
  LIMIT_ARGUMENT_SCHEMA,
  type UntrustedMark,
} from './common.js'

/** One argument of a tool. */
export interface ArgumentDefinition {
  name: string
  /** what a client shows people, on a card and in the record of a call (common §4) */
  title: string
  /** the argument's schema, without its title */
  schema: JsonSchema
  required: boolean
  /** the optional capability the argument belongs to; absent for an argument of the tool's own capability or core */
  capability?: string
  /** values of the argument that belong to a capability: refused with `not-supported` without it (common §4) */
  capabilityValues?: { value: unknown; capability: string }[]
  /** where the argument holds people's addresses, as a path below it (`*` an element of a list): common §10 */
  addresses?: string[]
}

/** A rule between arguments that a schema of plain properties does not carry, checked by code. */
export type ArgumentConstraint =
  | { kind: 'exactly-one'; arguments: string[]; field: string }
  | { kind: 'at-least-one'; arguments: string[]; field: string }
  | { kind: 'together'; arguments: string[] }

export interface ToolDefinition {
  name: string
  title: string
  /** the words a client gives the model, word for word (common §4) */
  description: string
  /** the optional capability of the tool, `null` for a core tool */
  capability: string | null
  effect: Effect
  /** a call becomes `external` when an argument holds an address outside the organization, or for these values */
  externalWhen?: { addresses: boolean; values?: { argument: string; value: unknown }[] }
  /** what of its result people other than the account's holder may have written (common §10) */
  untrusted: UntrustedMark
  /** the arguments, in the order of the profile's table */
  arguments: ArgumentDefinition[]
  constraints?: ArgumentConstraint[]
  /** the structured content of a result */
  result: JsonSchema
  /** the members of the result that hold an item, or a list of items, each carrying the location (FEAT-CORE-013) */
  itemMembers: string[]
  /** the error codes the profile names for this tool (it may also answer any other of the tables) */
  errors: string[]
  /** whether the tool lists: it takes `limit` and `cursor` and answers `nextCursor` (common §7) */
  pages: boolean
  /** whether the tool takes the profile's location argument (all but the one that lists locations, and the one that makes one) */
  located: boolean
}

export interface CapabilityDefinition {
  name: string
  /** the tools the capability adds, in the profile's order */
  tools: string[]
  /** what it adds to the core tools, in the profile's words */
  adds: string
  /** capabilities a server must also declare with it */
  requires: string[]
}

/** The three labels of a profile's location (common §6). */
export interface LocationLabels {
  one: string
  list: string
  any: string
}

export interface ProfileDefinition {
  /** the extension identifier (common §2) */
  id: string
  version: string
  /** the prefix of every tool's name */
  prefix: string
  /** the feature's name, in the words people use */
  title: string
  location: {
    /** the argument that names the location, and the member of every item that carries it (FEAT-CORE-013) */
    argument: string
    labels: LocationLabels
    /** the core tool that lists the locations the account reaches */
    listTool: string
  }
  capabilities: CapabilityDefinition[]
  /** every tool, the core first, then those of each capability in the profile's order */
  tools: ToolDefinition[]
  /** the error codes the profile adds to the common ones */
  errors: ErrorDefinition[]
  /** the members of the declaration the profile adds (common §3) */
  declarationMembers: Record<string, JsonSchema>
}

/** The limit and cursor arguments of a tool that lists (common §7). */
export function pageArguments(): ArgumentDefinition[] {
  const { title: limitTitle, ...limit } = LIMIT_ARGUMENT_SCHEMA
  const { title: cursorTitle, ...cursor } = CURSOR_ARGUMENT_SCHEMA
  return [
    { name: 'limit', title: limitTitle as string, schema: limit, required: false },
    { name: 'cursor', title: cursorTitle as string, schema: cursor, required: false },
  ]
}

export function toolOf(profile: ProfileDefinition, name: string): ToolDefinition | undefined {
  return profile.tools.find((t) => t.name === name)
}

export function coreTools(profile: ProfileDefinition): ToolDefinition[] {
  return profile.tools.filter((t) => t.capability === null)
}

/** The names of the capabilities of a profile's version. */
export function capabilityNames(profile: ProfileDefinition): string[] {
  return profile.capabilities.map((c) => c.name)
}

/** Whether an argument, or a value of it, is in use with a set of capabilities. */
function argumentInUse(arg: ArgumentDefinition, capabilities: ReadonlySet<string>): boolean {
  return arg.capability === undefined || capabilities.has(arg.capability)
}

/**
 * The tools of a profile for a set of capabilities in use, in the profile's order: the core tools, all of them, then
 * the tools of each capability (common §2, the Ayni Agent's TOOL-FEAT-010).
 */
export function toolsFor(profile: ProfileDefinition, capabilities: Iterable<string>): ToolDefinition[] {
  const inUse = new Set(capabilities)
  return profile.tools.filter((t) => t.capability === null || inUse.has(t.capability))
}

/** The arguments of a tool in use with a set of capabilities; those of the others are absent (TOOL-FEAT-010). */
export function argumentsFor(tool: ToolDefinition, capabilities: Iterable<string>): ArgumentDefinition[] {
  const inUse = new Set(capabilities)
  return tool.arguments.filter((a) => argumentInUse(a, inUse))
}

/** One argument's schema with its title and with the values of capabilities not in use left out of an `enum`. */
function argumentSchema(arg: ArgumentDefinition, capabilities: ReadonlySet<string>): JsonSchema {
  let schema: JsonSchema = { title: arg.title, ...arg.schema }
  if (arg.capabilityValues && Array.isArray(schema.enum)) {
    const out = new Set(arg.capabilityValues.filter((v) => !capabilities.has(v.capability)).map((v) => v.value))
    schema = { ...schema, enum: (schema.enum as unknown[]).filter((v) => !out.has(v)) }
  }
  return schema
}

/**
 * The input schema of a tool for a set of capabilities in use: an object of the arguments in use, each with its
 * title, refusing any other (common §4). The same bytes for every provider with the same capabilities in use.
 */
export function inputSchemaFor(tool: ToolDefinition, capabilities: Iterable<string>): JsonSchema {
  const inUse = new Set(capabilities)
  const args = argumentsFor(tool, inUse)
  const properties: Record<string, JsonSchema> = {}
  for (const a of args) properties[a.name] = argumentSchema(a, inUse)
  const required = args.filter((a) => a.required).map((a) => a.name)
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  }
}

/** The definition of a tool as MCP lists it (`tools/list`), for a set of capabilities in use. */
export interface McpToolDefinition {
  name: string
  title: string
  description: string
  inputSchema: JsonSchema
  outputSchema: JsonSchema
  annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean }
}

export function mcpToolFor(tool: ToolDefinition, capabilities: Iterable<string>): McpToolDefinition {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: inputSchemaFor(tool, capabilities),
    outputSchema: tool.result,
    annotations: { title: tool.title, ...annotationsOf(tool.effect) },
  }
}

/** The MCP definitions of every tool of a profile for a set of capabilities, in the profile's order. */
export function mcpToolsFor(profile: ProfileDefinition, capabilities: Iterable<string>): McpToolDefinition[] {
  const inUse = [...capabilities]
  return toolsFor(profile, inUse).map((t) => mcpToolFor(t, inUse))
}

/** The values found at a path below a value (`*` an element of a list). */
function valuesAt(value: unknown, path: string[]): unknown[] {
  if (path.length === 0) return [value]
  const [head, ...rest] = path
  if (head === '*') return Array.isArray(value) ? value.flatMap((v) => valuesAt(v, rest)) : []
  if (value && typeof value === 'object' && head !== undefined && head in value)
    return valuesAt((value as Record<string, unknown>)[head], rest)
  return []
}

/** The addresses of people a call names, from the arguments the profile marks (common §10). */
export function addressesOf(tool: ToolDefinition, args: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const a of tool.arguments) {
    if (!a.addresses || !(a.name in args)) continue
    for (const p of a.addresses) {
      const path = p === '' ? [] : p.split('/')
      for (const v of valuesAt(args[a.name], path)) if (typeof v === 'string') out.push(v)
    }
  }
  return out
}

/**
 * The effect of one call (common §10): the tool's, or `external` when one of the addresses it names is outside the
 * organization, or for a value the profile says is external (`audience: "anyone"`). The provider does not decide this:
 * the client does, from its own list of the organization's domains.
 */
export function effectOfCall(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  isInsideOrganization: (address: string) => boolean
): { effect: Effect; outsideOrganization: string[] } {
  const outside = tool.externalWhen?.addresses ? addressesOf(tool, args).filter((a) => !isInsideOrganization(a)) : []
  const byValue = (tool.externalWhen?.values ?? []).some((v) => args[v.argument] === v.value)
  return { effect: outside.length > 0 || byValue ? 'external' : tool.effect, outsideOrganization: outside }
}

/**
 * The organization's test of an address, by its domains: inside when the part after its last `@`, compared without
 * regard to case, is one of them (the Ayni Agent's TOOL-FEAT-013); with no list, every address is outside.
 */
export function insideDomains(domains: readonly string[] | undefined): (address: string) => boolean {
  const set = new Set((domains ?? []).map((d) => d.toLowerCase()))
  return (address) => {
    const at = address.lastIndexOf('@')
    return at >= 0 && set.has(address.slice(at + 1).toLowerCase())
  }
}
