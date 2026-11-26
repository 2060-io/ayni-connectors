/**
 * The conformance kit against the in-memory provider, over HTTP: every capability (both eras of MCP), and the core
 * alone, so that the refusals of capabilities not declared run too. Every requirement the kit tests automatically
 * must pass.
 */
import { registerConformance } from '@ayni.org/ayni-conformance'
import type { RunningProvider } from '@ayni.org/ayni-provider-kit'
import { type MemoryProvider, startMemoryProvider } from '@ayni.org/ayni-provider-memory'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { conformanceSetup } from '../src/setup.js'

type Started = MemoryProvider & { running: RunningProvider; url: string }

function suite(title: string, start: () => Promise<{ provider: Started; logs: string[] }>, era: 'modern' | 'legacy') {
  let started: { provider: Started; logs: string[] } | undefined
  afterAll(async () => started?.provider.running.close())
  registerConformance(
    { describe, it, beforeAll },
    {
      title,
      profiles: ['files', 'calendar'],
      timeoutMs: 300_000,
      options: async () => {
        started = await start()
        const s = started
        return conformanceSetup(s.provider, s.provider.url, { era, logs: () => s.logs.join('\n') })
      },
      onReport: (report) => {
        const failed = report.results.filter((r) => r.status === 'fail')
        if (failed.length)
          process.stderr.write(`${failed.map((f) => `${f.profile} ${f.id}: ${f.detail}`).join('\n')}\n`)
      },
    }
  )
}

/** A logger that keeps every line, at its most verbose, to look for credentials in (FEAT-CORE-021). */
function capture(lines: string[]) {
  const write = (level: string) => (fields: Record<string, unknown>, message: string) =>
    lines.push(JSON.stringify({ level, message, ...fields }))
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') }
}

suite(
  'in-memory provider, every capability, MCP 2026-07-28',
  async () => {
    const logs: string[] = []
    return { provider: await startMemoryProvider({ logger: capture(logs) }), logs }
  },
  'modern'
)

suite(
  'in-memory provider, every capability, MCP 2025-11-25 (initialize)',
  async () => {
    const logs: string[] = []
    return { provider: await startMemoryProvider({ logger: capture(logs) }), logs }
  },
  'legacy'
)

suite(
  'in-memory provider, the core alone, small pages',
  async () => {
    const logs: string[] = []
    const provider = await startMemoryProvider({
      logger: capture(logs),
      files: { capabilities: [], limits: { page: 20 } },
      calendar: { capabilities: [] },
    })
    return { provider, logs }
  },
  'modern'
)

suite(
  'in-memory provider, narrower declarations',
  async () => {
    const logs: string[] = []
    const provider = await startMemoryProvider({
      logger: capture(logs),
      files: {
        capabilities: ['search', 'folders', 'share', 'team-roots'],
        searchContent: false,
        audiences: ['anyone'],
        notify: false,
        teamRootManager: false,
        nativeConvertsText: false,
      },
      calendar: { capabilities: ['free-busy', 'recurrence'] },
    })
    return { provider, logs }
  },
  'modern'
)
