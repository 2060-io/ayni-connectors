/**
 * Validation against the profiles' JSON Schemas (2020-12), for a provider and for a client alike: the arguments of a
 * call, the structured content of a result or of an error, and a declaration.
 */
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { COMMON_ERRORS, declarationSchema, errorContentSchema, type JsonSchema } from './common.js'
import type { ProfileDefinition } from './profile.js'

const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true })
addFormats(ajv)

const compiled = new WeakMap<JsonSchema, ValidateFunction>()

function compile(schema: JsonSchema): ValidateFunction {
  let fn = compiled.get(schema)
  if (!fn) {
    fn = ajv.compile(schema)
    compiled.set(schema, fn)
  }
  return fn
}

export type SchemaProblem = ErrorObject

/** Validates a value against a schema; the problems found, none when it validates. */
export function validateSchema(schema: JsonSchema, value: unknown): SchemaProblem[] {
  const fn = compile(schema)
  return fn(value) ? [] : [...(fn.errors ?? [])]
}

/** One line for a problem: where, and what is wrong. */
export function describeProblem(problem: SchemaProblem): string {
  const at = problem.instancePath || '(the object)'
  return `${at} ${problem.message ?? 'is not valid'}`
}

/** The top-level member a problem is about: the argument of a call that is the cause. */
export function topMemberOf(problem: SchemaProblem): string | undefined {
  const first = problem.instancePath.split('/')[1]
  if (first) return first.replace(/~1/g, '/').replace(/~0/g, '~')
  const params = problem.params as { missingProperty?: string; additionalProperty?: string }
  return params.missingProperty ?? params.additionalProperty
}

/** The problems of a tool's structured content against the profile's result (FEAT-CORE-006). */
export function validateResult(profile: ProfileDefinition, toolName: string, content: unknown): string[] {
  const tool = profile.tools.find((t) => t.name === toolName)
  if (!tool) return [`${toolName} is no tool of ${profile.id} ${profile.version}`]
  return validateSchema(tool.result, content).map(describeProblem)
}

const errorSchemas = new WeakMap<ProfileDefinition, JsonSchema>()

/** The problems of an error's structured content (common §9, FEAT-CORE-007). */
export function validateErrorContent(profile: ProfileDefinition, content: unknown): string[] {
  let schema = errorSchemas.get(profile)
  if (!schema) {
    schema = errorContentSchema([...COMMON_ERRORS, ...profile.errors])
    errorSchemas.set(profile, schema)
  }
  return validateSchema(schema, content).map(describeProblem)
}

const declarationSchemas = new WeakMap<ProfileDefinition, JsonSchema>()

/** The schema of a profile's declaration (common §3). */
export function declarationSchemaOf(profile: ProfileDefinition): JsonSchema {
  let schema = declarationSchemas.get(profile)
  if (!schema) {
    schema = declarationSchema(profile.declarationMembers)
    declarationSchemas.set(profile, schema)
  }
  return schema
}

/**
 * The problems of a declaration (common §3, FEAT-CORE-001 and 026): its shape, the least of each limit, the
 * capabilities a capability requires, and, for a server of the profile's own minor version, capabilities the version
 * does not know. A later minor version may add capabilities, which a client ignores (common §14).
 */
export function validateDeclaration(profile: ProfileDefinition, declaration: unknown): string[] {
  const problems = validateSchema(declarationSchemaOf(profile), declaration).map(describeProblem)
  if (problems.length) return problems
  const d = declaration as { version: string; capabilities: string[] }
  const known = new Map(profile.capabilities.map((c) => [c.name, c]))
  if (d.version === profile.version)
    for (const c of d.capabilities)
      if (!known.has(c)) problems.push(`capability ${c} is not one of ${profile.id} ${profile.version}`)
  for (const c of d.capabilities) {
    for (const r of known.get(c)?.requires ?? [])
      if (!d.capabilities.includes(r)) problems.push(`capability ${c} requires ${r}, which is not declared`)
    // a capability whose member of the declaration has required members needs that member (FEAT-CAL-061)
    const member = profile.declarationMembers[c]
    if (Array.isArray(member?.required) && member.required.length > 0 && !(c in (declaration as object)))
      problems.push(`capability ${c} is declared without its member "${c}"`)
  }
  return problems
}
