/**
 * The harness of the tests: each requirement is one test, which passes, fails, or says why it could not run (a
 * fixture, a hook or a capability it needs, or a rule no client can observe); and the state a run shares between them.
 */
import { randomBytes } from 'node:crypto'
import type { JsonSchema, ProfileDefinition } from '@ayni.org/ayni-feature-profiles'
import type { Observer } from './observer.js'
import type { Json, Outcome, Session } from './session.js'
import type { ConformanceOptions, Status } from './types.js'

export class Ended extends Error {
  public constructor(
    public readonly status: Exclude<Status, 'pass' | 'fail'>,
    message: string
  ) {
    super(message)
  }
}

export class Failure extends Error {}

/** What a test is given. */
export class TestContext {
  public readonly notes: string[] = []

  public skip(reason: string): never {
    throw new Ended('skip', reason)
  }
  public manual(reason: string): never {
    throw new Ended('manual', reason)
  }
  public notApplicable(reason: string): never {
    throw new Ended('not-applicable', reason)
  }
  public note(text: string): void {
    this.notes.push(text)
  }

  public ok(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Failure(message)
  }

  public equal(actual: unknown, expected: unknown, message: string): void {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Failure(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }

  /** The content of a result, or a failure naming the error the server answered. */
  public success(outcome: Outcome, what: string): Json {
    if (!outcome.ok) throw new Failure(`${what} answered ${outcome.error.code}: ${outcome.error.message}`)
    return outcome.content
  }

  /** An error of one of the codes, with the field when one is given. */
  public refused(outcome: Outcome, codes: string | string[], what: string, field?: string): Outcome & { ok: false } {
    const list = Array.isArray(codes) ? codes : [codes]
    if (outcome.ok) throw new Failure(`${what} succeeded where ${list.join(' or ')} was expected`)
    if (!list.includes(outcome.error.code))
      throw new Failure(`${what} answered ${outcome.error.code} where ${list.join(' or ')} was expected`)
    if (field !== undefined && outcome.error.field !== field)
      throw new Failure(
        `${what} answered ${outcome.error.code} with field ${String(outcome.error.field)}, not ${field}`
      )
    return outcome
  }
}

/** A requirement's test. */
export interface Test<S> {
  id: string
  capability: string | null
  /** read what the whole run observed: runs after every other test of the profile */
  late?: boolean
  run(t: TestContext, s: S): Promise<void>
}

/** What every profile's tests share. */
export interface RunState {
  options: ConformanceOptions
  observer: Observer
  A: Session
  B: Session
  M?: Session
  /** a word of this run, in every name it makes, so that runs do not meet */
  token: string
}

export function runToken(): string {
  return `t${randomBytes(4).toString('hex')}`
}

/** A value an argument's schema takes, for FEAT-CORE-004: the least that validates. */
export function sampleOf(schema: JsonSchema, name: string): unknown {
  if (Array.isArray(schema.enum)) return schema.enum[0]
  if ('const' in schema) return schema.const
  const type = schema.type
  if (type === 'boolean') return true
  if (type === 'integer' || type === 'number') return (schema.minimum as number | undefined) ?? 1
  if (type === 'array') {
    const items = (schema.items as JsonSchema | undefined) ?? {}
    return Array.from({ length: Math.max(1, (schema.minItems as number | undefined) ?? 1) }, () =>
      sampleOf(items, name)
    )
  }
  if (type === 'object') {
    const props = (schema.properties as Record<string, JsonSchema> | undefined) ?? {}
    const required = (schema.required as string[] | undefined) ?? []
    const keys = required.length
      ? required
      : Object.keys(props).slice(0, (schema.minProperties as number | undefined) ?? 0)
    return Object.fromEntries(keys.map((k) => [k, sampleOf(props[k] ?? {}, k)]))
  }
  if (schema.format === 'email') return 'someone@example.org'
  if (schema.format === 'date-time') return '2027-01-04T10:00:00Z'
  if (name === 'start') return '2027-01-04T10:00:00Z'
  if (name === 'end') return '2027-01-04T11:00:00Z'
  if (name === 'timeZone') return 'Europe/Paris'
  if (name === 'rule') return 'FREQ=WEEKLY;COUNT=2'
  if (name === 'requestId') return 'request-1'
  if (name === 'mediaType') return 'text/plain'
  return 'sample'
}

/** The tools of a profile that a test can call with sample arguments in FEAT-CORE-004. */
export function profileToolOf(profile: ProfileDefinition, name: string) {
  return profile.tools.find((t) => t.name === name)
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
