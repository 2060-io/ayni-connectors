/**
 * A run of the conformance kit against one provider (common §13): FEAT-CORE for each profile the run asks for, then
 * the profile's own tests, the core and each capability it declares; then the rules read from every answer. A test
 * of a capability the server does not declare is not part of its conformance and is reported `not-applicable`.
 */
import { CALENDAR_PROFILE, FILES_PROFILE, type ProfileDefinition } from '@ayni.org/ayni-feature-profiles'
import { CALENDAR_TESTS, type CalendarState, calendarRun } from './calendar.js'
import { CORE_TESTS, type CoreState, type Declared, secretsOf } from './core.js'
import { FILES_TESTS, type FilesState, filesRun } from './files.js'
import { Ended, Failure, type RunState, runToken, type Test, TestContext } from './harness.js'
import { Observer } from './observer.js'
import { type Json, Session } from './session.js'
import type { ConformanceOptions, ConformanceReport, RequirementResult, Status } from './types.js'

const PRECEDENCE: Status[] = ['fail', 'pass', 'manual', 'skip', 'not-applicable']

/** The tests of a profile, in the order they run: those that make items first, those that read the whole run last. */
export function testsOf(profile: 'files' | 'calendar'): Test<CoreState>[] {
  const own = (profile === 'files' ? FILES_TESTS : CALENDAR_TESTS) as unknown as Test<CoreState>[]
  const all = [...CORE_TESTS, ...own]
  return [...all.filter((t) => !t.late), ...all.filter((t) => t.late)]
}

/** The requirement ids a run reports for a profile, in order, each once. */
export function requirementIdsOf(profile: 'files' | 'calendar'): string[] {
  const ids = [
    ...CORE_TESTS,
    ...((profile === 'files' ? FILES_TESTS : CALENDAR_TESTS) as unknown as Test<CoreState>[]),
  ].map((t) => t.id)
  return [...new Set(ids)].sort()
}

async function runOne(
  test: Test<CoreState>,
  state: CoreState,
  declared: string[]
): Promise<{ status: Status; detail?: string; ms: number }> {
  const started = Date.now()
  if (test.capability && !declared.includes(test.capability))
    return { status: 'not-applicable', detail: `the capability ${test.capability} is not declared`, ms: 0 }
  const t = new TestContext()
  try {
    await test.run(t, state)
    return { status: 'pass', ...(t.notes.length ? { detail: t.notes.join('; ') } : {}), ms: Date.now() - started }
  } catch (error) {
    const ms = Date.now() - started
    if (error instanceof Ended) return { status: error.status, detail: [error.message, ...t.notes].join('; '), ms }
    const message = error instanceof Failure || error instanceof Error ? error.message : String(error)
    return { status: 'fail', detail: [message, ...t.notes].join('; '), ms }
  }
}

/** Several tests of one requirement make one result: a failure of any fails it. */
function merge(parts: { status: Status; detail?: string; ms: number }[]): {
  status: Status
  detail?: string
  ms: number
} {
  const status = PRECEDENCE.find((p) => parts.some((x) => x.status === p)) ?? 'skip'
  const detail = parts
    .map((p) => p.detail)
    .filter(Boolean)
    .join(' · ')
  return { status, ...(detail ? { detail } : {}), ms: parts.reduce((a, b) => a + b.ms, 0) }
}

async function runProfile(
  base: RunState,
  profile: ProfileDefinition,
  key: 'files' | 'calendar',
  declaration: Declared,
  results: RequirementResult[],
  onResult?: (r: RequirementResult) => void
): Promise<void> {
  let state: CoreState
  const created = new Set<string>()
  const events: CalendarState['events'] = []
  if (key === 'files') {
    const files = base.options.files
    if (!files) return
    state = { ...base, run: filesRun(base, declaration, files, created), made: [], files, created } as FilesState
  } else {
    const calendar = base.options.calendar
    if (!calendar) return
    state = {
      ...base,
      run: calendarRun(base, declaration, calendar, events),
      made: [],
      calendar,
      events,
    } as CalendarState
  }
  const byId = new Map<string, { status: Status; detail?: string; ms: number }[]>()
  const tests = testsOf(key)
  for (const test of tests) {
    const r = await runOne(test, state, declaration.capabilities)
    const list = byId.get(test.id) ?? []
    list.push(r)
    byId.set(test.id, list)
    if (list.length === tests.filter((t) => t.id === test.id).length) {
      const merged = merge(list)
      const result: RequirementResult = { id: test.id, profile: profile.id, capability: test.capability, ...merged }
      results.push(result)
      onResult?.(result)
    }
  }
  // a run leaves the first location empty: what it made goes to the trash, or is cancelled
  if (key === 'files' && declaration.capabilities.includes('trash')) {
    const first = base.options.files?.first.ref as string
    let cursor: string | undefined
    const top: string[] = []
    do {
      const page = await base.A.call('files_list', { root: first, ...(cursor ? { cursor } : {}) })
      if (!page.ok) break
      top.push(
        ...((page.content.items as Json[]) ?? []).filter((i) => created.has(String(i.ref))).map((i) => String(i.ref))
      )
      cursor = page.content.nextCursor as string | undefined
    } while (cursor)
    for (const ref of top) await base.A.call('files_trash', { root: first, ref }).catch(() => undefined)
  }
  if (key === 'calendar')
    for (const e of events.reverse())
      await e.session.call('calendar_cancel_event', { calendar: e.calendar, ref: e.ref }).catch(() => undefined)
}

/** Runs the kit against a provider, and answers a result for each requirement. */
export async function runConformance(options: ConformanceOptions): Promise<ConformanceReport> {
  const observer = new Observer(secretsOf(options))
  const mode = options.era ?? 'auto'
  const session = (name: string, account: ConformanceOptions['accounts']['A']) =>
    new Session(name, account, options.url, mode, observer, options.fetch)
  const A = session('A', options.accounts.A)
  const B = session('B', options.accounts.B)
  const M = options.accounts.M ? session('M', options.accounts.M) : undefined
  await A.connect()
  await B.connect()
  await M?.connect()
  const base: RunState = { options, observer, A, B, ...(M ? { M } : {}), token: runToken() }
  const results: RequirementResult[] = []
  const declarations: Record<string, unknown> = {}
  try {
    const extensions = await A.extensions()
    for (const [key, profile] of [
      ['files', FILES_PROFILE],
      ['calendar', CALENDAR_PROFILE],
    ] as const) {
      if (!options[key]) continue
      const declaration = extensions[profile.id] as Declared | undefined
      if (!declaration) {
        const r: RequirementResult = {
          id: 'FEAT-CORE-001',
          profile: profile.id,
          capability: null,
          status: 'fail',
          detail: `the server does not declare ${profile.id} to A`,
          ms: 0,
        }
        results.push(r)
        options.onResult?.(r)
        continue
      }
      declarations[profile.id] = declaration
      observer.declarations[profile.id] = declaration
      await runProfile(base, profile, key, declaration, results, options.onResult)
    }
  } finally {
    await A.close()
    await B.close()
    await M?.close()
  }
  return { url: options.url, era: A.era, declarations, results, passed: !results.some((r) => r.status === 'fail') }
}
