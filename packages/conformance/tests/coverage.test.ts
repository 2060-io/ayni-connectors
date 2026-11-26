/**
 * The kit's tests are the spec's requirements (common §13): every FEAT-CORE, FEAT-FILES and FEAT-CAL id the spec
 * gives (the facts of the contracts package, `spec/facts.json`) has a test, and no test has an id the spec does not give.
 */
import { requirementIdsOf, testsOf } from '@ayni.org/ayni-conformance'
import { describe, expect, it } from 'vitest'
import { readFacts } from '../../feature-profiles/tests/spec-reader.js'

describe('the requirements the kit tests', () => {
  const facts = readFacts()
  const core = facts.common.requirementIds
  const files = facts.files.requirementIds
  const calendar = facts.calendar.requirementIds

  it('are those of the spec, for Files', () => {
    expect(requirementIdsOf('files')).toEqual([...core, ...files].sort())
  })

  it('are those of the spec, for Calendar', () => {
    expect(requirementIdsOf('calendar')).toEqual([...core, ...calendar].sort())
  })

  it('run in an order where those that read the whole run come last', () => {
    for (const profile of ['files', 'calendar'] as const) {
      const tests = testsOf(profile)
      const firstLate = tests.findIndex((t) => t.late)
      expect(tests.slice(firstLate).every((t) => t.late)).toBe(true)
    }
  })
})
