/**
 * The conformance kit against the connector over the stub of Google, over HTTP both ways: Files (with the messages
 * Google would send, for FEAT-FILES-053) and Calendar over MCP 2026-07-28, then both over the 2025-era `initialize`.
 * Calendar runs without the hook of messages: Google's cancellation carries no message of the organizer, so the
 * connector refuses `comment` on a cancellation (`not-supported`), which FEAT-CAL-042 would read as a failure with that
 * hook; the messages of invitations, changes and answers are the connector's own tests (calendar.test.ts). Every
 * requirement the kit tests must pass; what it skips is listed by the kit with its reason.
 */
import { type ConformanceReport, registerConformance } from '@ayni.org/ayni-conformance'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { conformanceOptions, type Started, startRun } from './setup.js'

function suite(title: string, profiles: ('files' | 'calendar')[], era: 'modern' | 'legacy', messages: boolean): void {
  let started: Started | undefined
  afterAll(async () => started?.close())
  registerConformance(
    { describe, it, beforeAll },
    {
      title,
      profiles,
      timeoutMs: 300_000,
      options: async () => {
        started = await startRun()
        return conformanceOptions(started, { era, messages, profiles })
      },
      onReport: (report: ConformanceReport) => {
        const failed = report.results.filter((r) => r.status === 'fail')
        if (failed.length)
          process.stderr.write(`${failed.map((f) => `${f.profile} ${f.id}: ${f.detail}`).join('\n')}\n`)
        if (process.env.AYNI_CONFORMANCE_REPORT)
          process.stderr.write(
            `${report.results.map((r) => `${title} | ${r.profile} | ${r.id} | ${r.status} | ${r.detail ?? ''}`).join('\n')}\n`
          )
      },
    }
  )
}

suite('Google connector over the stub, Files, MCP 2026-07-28', ['files'], 'modern', true)
suite('Google connector over the stub, Calendar, MCP 2026-07-28', ['calendar'], 'modern', false)
suite(
  'Google connector over the stub, Files and Calendar, MCP 2025-11-25 (initialize)',
  ['files', 'calendar'],
  'legacy',
  false
)
