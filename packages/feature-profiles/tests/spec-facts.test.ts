/**
 * `spec/facts.json` against the spec's documents, when a checkout of them is at hand: `AYNI_SPEC_DIR` names its
 * `v4/ayni-feature-profiles/` directory. With `UPDATE_SPEC_FACTS=1` (and `AYNI_SPEC_COMMIT`, the commit checked out)
 * the file is written again from the documents; then `tests/spec-pin.test.ts` says what of the code has to follow.
 */
import { existsSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FACTS_FILE, factsOf, readFacts } from './spec-reader.js'

const dir = process.env.AYNI_SPEC_DIR

describe.skipIf(!dir)('spec/facts.json against the documents of AYNI_SPEC_DIR', () => {
  it('holds the facts of the documents', () => {
    const current = existsSync(FACTS_FILE) ? readFacts() : undefined
    const source = {
      repository: 'https://github.com/2060-io/ayni-spec',
      path: 'v4/ayni-feature-profiles',
      commit: process.env.AYNI_SPEC_COMMIT ?? current?.source.commit ?? 'unknown',
    }
    const facts = factsOf(dir as string, source)
    if (process.env.UPDATE_SPEC_FACTS) {
      writeFileSync(FACTS_FILE, `${JSON.stringify(facts, null, 2)}\n`)
      return
    }
    expect({ ...facts, source: undefined }).toEqual({ ...current, source: undefined })
  })
})
