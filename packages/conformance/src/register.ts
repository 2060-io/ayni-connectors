/**
 * The kit in a test runner (vitest, jest, node:test with the same shape): one test per requirement id, each passing,
 * failing or skipped as the run reported it. The run itself happens once, before the first test.
 */
import { CALENDAR_PROFILE, FILES_PROFILE } from '@ayni.org/ayni-feature-profiles'
import { requirementIdsOf, runConformance } from './run.js'
import type { ConformanceOptions, ConformanceReport } from './types.js'

/** The functions of a test runner the kit uses. */
export interface RunnerApi {
  describe(name: string, fn: () => void): void
  it(name: string, fn: (context?: { skip?: (note?: string) => void }) => void | Promise<void>): void
  beforeAll(fn: () => Promise<void>, timeout?: number): void
}

export interface RegisterOptions {
  title?: string
  /** the profiles the run tests: the ids reported are known before the run, so that each is a test of its own */
  profiles: ('files' | 'calendar')[]
  /** the options of the run, read when it starts (a provider started in the runner's own setup) */
  options: () => ConformanceOptions | Promise<ConformanceOptions>
  /** how long the whole run may take */
  timeoutMs?: number
  /** a requirement whose test is skipped, manual or not applicable fails, rather than being skipped */
  strict?: boolean
  /** receives the report once the run ended */
  onReport?: (report: ConformanceReport) => void
}

export function registerConformance(api: RunnerApi, opts: RegisterOptions): void {
  api.describe(opts.title ?? 'Ayni Feature Profiles conformance', () => {
    let report: ConformanceReport | undefined
    let failure: unknown
    api.beforeAll(async () => {
      try {
        report = await runConformance(await opts.options())
        opts.onReport?.(report)
      } catch (error) {
        failure = error
      }
    }, opts.timeoutMs ?? 600_000)
    for (const key of opts.profiles) {
      const profile = key === 'files' ? FILES_PROFILE : CALENDAR_PROFILE
      for (const id of requirementIdsOf(key)) {
        api.it(`${profile.id} ${id}`, (context) => {
          if (failure) throw failure
          const r = report?.results.find((x) => x.id === id && x.profile === profile.id)
          if (!r) throw new Error(`${id} did not run`)
          if (r.status === 'fail') throw new Error(r.detail ?? 'failed')
          if (r.status !== 'pass') {
            if (opts.strict) throw new Error(`${r.status}: ${r.detail ?? ''}`)
            context?.skip?.(`${r.status}: ${r.detail ?? ''}`)
          }
        })
      }
    }
  })
}
