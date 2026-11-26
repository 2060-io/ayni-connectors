/**
 * What a run of the conformance kit takes and answers (common §13): two accounts of the service, A and B, with their
 * credentials; an empty location that A may write to, and a second location that A may read, outside the first; for
 * a capability that names people, addresses inside and outside a test organization; for `team-roots`, a third account
 * M that may make one.
 */
import type { CalendarCapability, FilesCapability } from '@ayni.org/ayni-feature-profiles'

/** An account of the service, as a client sends it: the headers of its requests. */
export interface ConformanceAccount {
  /** the headers that carry the account (`Authorization`, or those the provider's documentation names) */
  headers: Record<string, string>
  /** the account's address at the service, for the tests that share with it or invite it */
  address?: string
  /** further values no answer may hold (a password); the values of `headers` are always looked for */
  secrets?: string[]
}

/** A location of the run, by its reference, with its path in the account's own tree when known. */
export interface ConformanceLocation {
  ref: string
  /** the location's path in A's tree, for the tests of `files_roots` with a `query` (FEAT-FILES-003) */
  path?: string
}

/** Items a test needs that a profile cannot make, made at the service by other means. */
export interface FilesFixtures {
  /** a shortcut, in the first location, to a file of the second (FEAT-FILES-012, FEAT-CORE-014) */
  link?: string
  /** a document of the store's own format, in the first location (FEAT-FILES-005, 015, 061, 063) */
  native?: string
  /** a document of the store's own that the store does not convert from text, in the first location (FEAT-FILES-016) */
  nativeNotConvertible?: string
  /** a folder of the first location that holds two items named `a.txt` (FEAT-FILES-017) */
  duplicates?: string
}

export interface FilesConformance {
  /** the capabilities the server must declare to A, exactly; what it declares when absent */
  expect?: FilesCapability[]
  first: ConformanceLocation
  second: ConformanceLocation
  fixtures?: FilesFixtures
}

export interface CalendarFixtures {
  /** a weekly series in the first calendar, of four occurrences at least from `weeklySeries.from` (FEAT-CAL-005, 011, 013) */
  weeklySeries?: { ref: string; from: string; to: string }
  /** a floating event in the first calendar, and the start it must read (FEAT-CAL-015) */
  floating?: { ref: string; start: string }
  /** an event organized by B in A's first calendar, A invited (FEAT-CAL-009, 017), used when `attendees` is absent */
  invitation?: string
  /** an event with an iCalendar `CONFERENCE` in the first calendar (FEAT-CAL-061) */
  conference?: string
}

export interface CalendarConformance {
  expect?: CalendarCapability[]
  /** A's calendar, empty and writable: A's main calendar, where invitations to A arrive */
  first: ConformanceLocation
  /** a second calendar A may read, outside the first; one A may not write tests FEAT-CAL-012's last part */
  second: ConformanceLocation
  /** B's main calendar, where invitations to B arrive and B organizes */
  bCalendar?: string
  fixtures?: CalendarFixtures
}

/** A message the service sent, as a hook reads it back from a test mailbox. */
export interface ObservedMessage {
  to: string
  subject?: string
  text: string
}

/** What the runner lets the kit do to the service or read of it beyond MCP; a test that needs one it lacks is skipped. */
export interface ConformanceHooks {
  /** stops the service behind the provider, and starts it again (FEAT-CORE-007) */
  stopService?(): Promise<void>
  startService?(): Promise<void>
  /** makes the service ask the person before every write, or stop asking (FEAT-CORE-024) */
  askBeforeWrite?(on: boolean): Promise<void>
  /** the messages the service sent to an address since the run began (shares, invitations, replies) */
  messages?(address: string): Promise<ObservedMessage[]>
  /** what the provider logged and stored during the run, to look for credentials in (FEAT-CORE-021) */
  logs?(): Promise<string>
}

export interface ConformanceOptions {
  /** the provider's MCP endpoint (Streamable HTTP) */
  url: string
  accounts: { A: ConformanceAccount; B: ConformanceAccount; M?: ConformanceAccount }
  files?: FilesConformance
  calendar?: CalendarConformance
  /** an address inside the test organization that is no account of the service, and one outside it */
  organization?: { noAccount?: string; outside?: string }
  hooks?: ConformanceHooks
  /** the MCP era to test: `modern` (2026-07-28, `server/discover`), `legacy` (`initialize`), `auto` (probe) */
  era?: 'modern' | 'legacy' | 'auto'
  /** a fetch to reach the endpoint with (a test that serves the provider in-process) */
  fetch?: typeof fetch
  /** reports each requirement as it ends */
  onResult?: (result: RequirementResult) => void
}

export type Status = 'pass' | 'fail' | 'skip' | 'manual' | 'not-applicable'

export interface RequirementResult {
  /** `FEAT-CORE-012`, `FEAT-FILES-007`, … */
  id: string
  /** the profile the test ran for (FEAT-CORE runs once per profile) */
  profile: string
  /** the capability the requirement belongs to, `null` for the core */
  capability: string | null
  status: Status
  detail?: string
  ms: number
}

export interface ConformanceReport {
  url: string
  era: 'modern' | 'legacy'
  declarations: Record<string, unknown>
  results: RequirementResult[]
  /** no failure: every test ran passed, or could not run for want of a fixture, a hook or a capability */
  passed: boolean
}
