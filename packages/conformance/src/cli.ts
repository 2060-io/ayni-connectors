#!/usr/bin/env node
/**
 * `ayni-conformance --config <file>`: runs the kit against a provider and prints one line per requirement. The
 * configuration is a JSON file of the run's options, or a JavaScript module whose default export is them (hooks
 * included). Exits 1 when a requirement fails.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { runConformance } from './run.js'
import type { ConformanceOptions, RequirementResult } from './types.js'

const out = (line: string) => process.stdout.write(`${line}\n`)
const err = (line: string) => process.stderr.write(`${line}\n`)

const LABEL: Record<RequirementResult['status'], string> = {
  pass: 'PASS',
  fail: 'FAIL',
  skip: 'SKIP',
  manual: 'MANUAL',
  'not-applicable': 'N/A',
}

async function load(file: string): Promise<ConformanceOptions> {
  const path = resolve(file)
  if (path.endsWith('.json')) return JSON.parse(await readFile(path, 'utf8')) as ConformanceOptions
  const mod = (await import(pathToFileURL(path).href)) as {
    default?: ConformanceOptions | (() => Promise<ConformanceOptions>)
  }
  const value = mod.default
  if (!value) throw new Error(`${file} has no default export`)
  return typeof value === 'function' ? await value() : value
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', short: 'c' },
      url: { type: 'string' },
      era: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (values.help || !values.config) {
    out('usage: ayni-conformance --config <run.json | run.mjs> [--url <mcp url>] [--era modern|legacy|auto] [--json]')
    return values.help ? 0 : 2
  }
  const options = await load(values.config)
  if (values.url) options.url = values.url
  if (values.era) options.era = values.era as ConformanceOptions['era']
  if (!values.json)
    options.onResult = (r) =>
      out(`${LABEL[r.status].padEnd(6)} ${r.id}  ${r.profile}${r.detail ? `  ${r.detail}` : ''}`)
  const report = await runConformance(options)
  if (values.json) out(JSON.stringify(report, null, 2))
  else {
    const count = (s: RequirementResult['status']) => report.results.filter((r) => r.status === s).length
    out(
      `\n${report.url} (${report.era}): ${count('pass')} pass, ${count('fail')} fail, ${count('skip')} skip, ${count('manual')} manual, ${count('not-applicable')} not applicable`
    )
  }
  return report.passed ? 0 : 1
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    err(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }
)
