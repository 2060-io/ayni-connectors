/**
 * The conformance kit against the connector over the stub, over HTTPS both ways: a Nextcloud (Files with the messages
 * its shares send, for FEAT-FILES-053; Calendar), and a plain WebDAV and CalDAV server (FEAT-WEBDAV-001,
 * FEAT-CALDAV-001: the core, `folders`, `recurrence` and `free-busy`), over MCP 2026-07-28, then both profiles of a
 * Nextcloud over the 2025-era `initialize`. Calendar runs without the hook of messages: CalDAV's cancellation carries
 * no line of the organizer, so the connector refuses `comment` (`not-supported`), which FEAT-CAL-042 would read as a
 * failure with that hook; what B receives of invitations and answers is the connector's own test (calendar.test.ts).
 * Every requirement the kit tests must pass; what it skips is listed by the kit with its reason, but one: a Nextcloud
 * types a file by its name's extension alone, whatever the PUT says (seen on Nextcloud 35), so that a text created as
 * `notes`, with no extension, reads `application/octet-stream` where FEAT-FILES-014 asks `text/plain`. No request of
 * WebDAV or of Nextcloud's interfaces sets a file's type: that one case of FEAT-FILES-014 is a divergence of the
 * store, pinned here exactly, so that any other failure of FEAT-FILES-014 still fails.
 */
import { type ConformanceReport, registerConformance } from '@ayni.org/ayni-conformance'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { conformanceOptions, type Started, startRun } from './setup.js'
import type { StubOptions } from './stub/index.js'

/** The one failure a Nextcloud gives the kit: FEAT-FILES-014's file of no extension, created as text. */
const NO_EXTENSION = /^the type of t[0-9a-f]+-notes: expected "text\/plain", got "application\/octet-stream"$/

/** A runner whose FEAT-FILES-014 of a Nextcloud passes only when it fails for that one reason. */
function runnerFor(nextcloud: boolean) {
  return {
    describe,
    beforeAll,
    it: (name: string, fn: (context?: { skip?: (note?: string) => void }) => void | Promise<void>) =>
      it(name, async (context) => {
        if (!nextcloud || !name.endsWith(' FEAT-FILES-014')) return fn(context)
        let failed: unknown
        try {
          await fn(context)
        } catch (e) {
          failed = e
        }
        if (!failed) throw new Error('FEAT-FILES-014 passed against a Nextcloud: its known divergence is to remove')
        if (!NO_EXTENSION.test((failed as Error).message)) throw failed
      }),
  }
}

function suite(
  title: string,
  stub: StubOptions,
  profiles: ('files' | 'calendar')[],
  era: 'modern' | 'legacy',
  messages: boolean,
  plainCalendars?: string
): void {
  let started: Started | undefined
  afterAll(async () => started?.close())
  registerConformance(runnerFor(stub.nextcloud !== false), {
    title,
    profiles,
    timeoutMs: 300_000,
    options: async () => {
      started = await startRun(stub)
      return conformanceOptions(started, { era, messages, profiles, ...(plainCalendars ? { plainCalendars } : {}) })
    },
    onReport: (report: ConformanceReport) => {
      const failed = report.results.filter((r) => r.status === 'fail')
      if (failed.length) process.stderr.write(`${failed.map((f) => `${f.profile} ${f.id}: ${f.detail}`).join('\n')}\n`)
      if (process.env.AYNI_CONFORMANCE_REPORT)
        process.stderr.write(
          `${report.results.map((r) => `${title} | ${r.profile} | ${r.id} | ${r.status} | ${r.detail ?? ''}`).join('\n')}\n`
        )
    },
  })
}

suite('Nextcloud connector over a stub Nextcloud, Files, MCP 2026-07-28', {}, ['files'], 'modern', true)
suite('Nextcloud connector over a stub Nextcloud, Calendar, MCP 2026-07-28', {}, ['calendar'], 'modern', false)
suite(
  'Nextcloud connector over a stub Nextcloud, Files and Calendar, MCP 2025-11-25 (initialize)',
  {},
  ['files', 'calendar'],
  'legacy',
  false
)
suite(
  'Nextcloud connector over a plain WebDAV server, Files, MCP 2026-07-28',
  { nextcloud: false },
  ['files'],
  'modern',
  false
)
suite(
  'Nextcloud connector over a plain CalDAV server with scheduling, found from its root, Calendar, MCP 2026-07-28',
  { nextcloud: false, scheduling: true },
  ['calendar'],
  'modern',
  false,
  '{origin}/'
)
