/**
 * The common part of the Ayni Feature Profiles 1.0 (spec `v4/ayni-feature-profiles/common.md`): effects, the marks of
 * content written by others, errors, limits, pages, references, versions and instants, and the shape of a profile's
 * declaration (§3). Shared by every profile and by every provider and client.
 */

/** A JSON Schema (2020-12) as plain data. */
export type JsonSchema = { [keyword: string]: unknown }

/** The dialect every schema of the profiles is written in (README, External dependencies). */
export const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema'

/** The MCP revision the profiles name, and the one before it whose `initialize` also carries the declaration (§3). */
export const MCP_REVISION = '2026-07-28'

/** The effect of a tool, in the four words of the Ayni Agent (common §10, its D99). */
export type Effect = 'read' | 'write' | 'delete' | 'external'

export const EFFECTS: readonly Effect[] = ['read', 'write', 'delete', 'external']

/** What of a tool's result people other than the account's holder may have written (common §10). */
export type UntrustedMark = 'no' | 'names' | 'names and content'

/** A call rule of the Ayni Agent: what a call needs before it runs (TOOL-CAT-007). */
export type CallRule = 'none' | 'confirm' | 'approval'

/**
 * The default rule of each effect (the Ayni Agent's TOOL-CAT-007): a client that knows the profile takes the effect
 * from the profile (common §4) and this rule from the effect, unless its configuration sets another.
 */
export const DEFAULT_RULE_OF_EFFECT: Readonly<Record<Effect, CallRule>> = {
  read: 'none',
  write: 'confirm',
  delete: 'approval',
  external: 'approval',
}

/** MCP's hints of a tool, from its effect (FEAT-CORE-018): `readOnlyHint` for `read`, `destructiveHint` for `delete`. */
export function annotationsOf(effect: Effect): { readOnlyHint: boolean; destructiveHint: boolean } {
  return { readOnlyHint: effect === 'read', destructiveHint: effect === 'delete' }
}

/** The error codes of the common part (§9). A profile adds codes of its own. */
export const COMMON_ERROR_CODES = [
  'invalid-argument',
  'not-supported',
  'not-found',
  'outside-location',
  'already-exists',
  'version-mismatch',
  'too-large',
  'permission-denied',
  'account-refused',
  'rate-limited',
  'unavailable',
  'bad-cursor',
] as const

export type CommonErrorCode = (typeof COMMON_ERROR_CODES)[number]

/** An error code of the common part or of a profile; a client treats a code it does not know as `unavailable` (§9). */
export type ErrorCode = CommonErrorCode | (string & {})

/** One row of an error table: the code, when it is answered, and the members it carries beside `code` and `message`. */
export interface ErrorDefinition {
  code: string
  when: string
  /** members the error always carries */
  members: string[]
  /** members it carries when known, or when an argument is the cause */
  optionalMembers: string[]
}

/** The table of common §9. */
export const COMMON_ERRORS: readonly ErrorDefinition[] = [
  {
    code: 'invalid-argument',
    when: 'an argument is missing, unknown, of the wrong type or out of its bounds',
    members: ['field'],
    optionalMembers: [],
  },
  {
    code: 'not-supported',
    when: 'an argument or a value that the server did not declare or that the profile does not take; an item the operation cannot act on',
    members: [],
    optionalMembers: ['field'],
  },
  {
    code: 'not-found',
    when: 'the reference names no item that the location holds, for the account of the call, an item outside the location included',
    members: [],
    optionalMembers: [],
  },
  {
    code: 'outside-location',
    when: "the operation's destination, given by path, would leave the location",
    members: [],
    optionalMembers: [],
  },
  { code: 'already-exists', when: 'an item of this name is already there', members: [], optionalMembers: [] },
  {
    code: 'version-mismatch',
    when: "`ifVersion` is not the item's version",
    members: ['currentVersion'],
    optionalMembers: [],
  },
  {
    code: 'too-large',
    when: "the content is larger than the server's limit, or than the service takes",
    members: ['limitBytes'],
    optionalMembers: ['sizeBytes'],
  },
  {
    code: 'permission-denied',
    when: 'the account may not do this at the service; a question of the service was declined',
    members: [],
    optionalMembers: [],
  },
  {
    code: 'account-refused',
    when: 'the request carries no credentials, or the service refuses them',
    members: [],
    optionalMembers: [],
  },
  { code: 'rate-limited', when: 'the service asks to wait', members: [], optionalMembers: ['retryAfterSeconds'] },
  { code: 'unavailable', when: 'the service cannot be reached, or fails', members: [], optionalMembers: [] },
  {
    code: 'bad-cursor',
    when: 'the cursor is unknown, expired, or was given for other arguments',
    members: [],
    optionalMembers: [],
  },
]

/** The structured content of a tool execution error (§9). */
export interface ProfileErrorContent {
  error: {
    code: ErrorCode
    message: string
    field?: string
    currentVersion?: string
    limitBytes?: number
    sizeBytes?: number
    retryAfterSeconds?: number
    reason?: string
    [member: `x_${string}`]: unknown
  }
}

/** A server's limits (§12). */
export interface Limits {
  /** the most items in one page */
  page: number
  /** the most bytes of one content read */
  readBytes: number
  /** the most bytes of one content written */
  writeBytes: number
}

const MIB = 1024 * 1024

/** The default of each limit, for a member a server leaves out (§12). */
export const DEFAULT_LIMITS: Readonly<Limits> = { page: 100, readBytes: 10 * MIB, writeBytes: 10 * MIB }

/** The least a server may declare of each limit (§12, FEAT-CORE-026). */
export const LEAST_LIMITS: Readonly<Limits> = { page: 20, readBytes: MIB, writeBytes: MIB }

/** Pages (§7): `limit` 1 to 100, 50 when absent; a cursor good for at least ten minutes. */
export const PAGE = { minLimit: 1, maxLimit: 100, defaultLimit: 50, cursorLifetimeSeconds: 600 } as const

/** The limits a declaration gives, each absent member taken as the default. */
export function limitsOf(declaration: { limits?: Partial<Limits> } | undefined): Limits {
  return { ...DEFAULT_LIMITS, ...(declaration?.limits ?? {}) }
}

/** The most items a page holds for a call: the smaller of its `limit` (50 when absent) and the server's `page`. */
export function pageSizeOf(limit: number | undefined, limits: Limits): number {
  return Math.min(limit ?? PAGE.defaultLimit, limits.page)
}

/** An instant the provider answers about an item: RFC 3339 `date-time` in UTC, with `Z` (§8, FEAT-CORE-017). */
export const INSTANT_PATTERN = '^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d(\\.\\d+)?Z$'

/** A reference: 1 to 1024 characters (§5). */
export const REF_SCHEMA: JsonSchema = { type: 'string', minLength: 1, maxLength: 1024 }

/** A version: 1 to 255 characters, compared for equality only (§5). */
export const VERSION_SCHEMA: JsonSchema = { type: 'string', minLength: 1, maxLength: 255 }

export const INSTANT_SCHEMA: JsonSchema = { type: 'string', pattern: INSTANT_PATTERN }

/** The arguments of a tool that lists (§7). */
export const LIMIT_ARGUMENT_SCHEMA: JsonSchema = {
  title: 'Most results',
  type: 'integer',
  minimum: PAGE.minLimit,
  maximum: PAGE.maxLimit,
}
export const CURSOR_ARGUMENT_SCHEMA: JsonSchema = { title: 'Next page', type: 'string', minLength: 1 }

/** `nextCursor` of a page. */
export const NEXT_CURSOR_SCHEMA: JsonSchema = { type: 'string', minLength: 1 }

/** The schema of the structured content of an error (§9), with the members each code requires. */
export function errorContentSchema(errors: readonly ErrorDefinition[]): JsonSchema {
  return {
    type: 'object',
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        required: ['code', 'message'],
        properties: {
          code: { type: 'string', minLength: 1 },
          message: { type: 'string', minLength: 1 },
          field: { type: 'string', minLength: 1 },
          currentVersion: VERSION_SCHEMA,
          limitBytes: { type: 'integer', minimum: 0 },
          sizeBytes: { type: 'integer', minimum: 0 },
          retryAfterSeconds: { type: 'number', minimum: 0 },
          reason: { type: 'string', minLength: 1 },
        },
        allOf: errors
          .filter((e) => e.members.length > 0)
          .map((e) => ({ if: { properties: { code: { const: e.code } } }, then: { required: e.members } })),
      },
    },
  }
}

/** The members of a declaration that every profile has (§3); a profile adds its own. */
export interface DeclarationBase<C extends string = string> {
  version: string
  capabilities: C[]
  limits?: Partial<Limits>
  atomicWrites?: boolean
}

/** The schema of the members of §3, with the least of each limit (FEAT-CORE-026). */
export function declarationSchema(members: Record<string, JsonSchema>): JsonSchema {
  return {
    type: 'object',
    required: ['version', 'capabilities'],
    properties: {
      version: { type: 'string', pattern: '^\\d+\\.\\d+$' },
      // a later minor version may add capabilities: the names of this version are checked elsewhere (FEAT-CORE-001)
      capabilities: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
      limits: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: LEAST_LIMITS.page },
          readBytes: { type: 'integer', minimum: LEAST_LIMITS.readBytes },
          writeBytes: { type: 'integer', minimum: LEAST_LIMITS.writeBytes },
        },
      },
      atomicWrites: { type: 'boolean' },
      ...members,
    },
  }
}

/** `major.minor` of a profile's version. */
export function parseVersion(version: string): { major: number; minor: number } | undefined {
  const m = /^(\d+)\.(\d+)$/.exec(version)
  if (!m) return undefined
  return { major: Number(m[1]), minor: Number(m[2]) }
}

/**
 * Whether a client of `known` works with a server that declares `declared`: the same major version, whatever the
 * minor (§14, FEAT-CORE-023).
 */
export function isCompatibleVersion(known: string, declared: string): boolean {
  const a = parseVersion(known)
  const b = parseVersion(declared)
  return !!a && !!b && a.major === b.major
}
