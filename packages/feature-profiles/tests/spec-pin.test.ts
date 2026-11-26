/**
 * Pins the definitions to the spec's text, through the facts its tables and lines give at the commit the package
 * follows (`spec/facts.json`, made from the documents by `tests/spec-facts.test.ts`): every tool, title, effect, mark,
 * description, argument, capability, error code and limit is the package's, and the package has nothing the
 * documents do not give. A change of the spec is a change of `spec/facts.json` first, and this test then says what of
 * the code has to follow.
 */
import {
  CALENDAR_PROFILE,
  COMMON_ERROR_CODES,
  COMMON_ERRORS,
  DEFAULT_LIMITS,
  FILES_PROFILE,
  LEAST_LIMITS,
  type ProfileDefinition,
  RECIPIENT_REFUSED_REASONS,
} from '@ayni.org/ayni-feature-profiles'
import { describe, expect, it } from 'vitest'
import { type ProfileFacts, readFacts } from './spec-reader.js'

const facts = readFacts()

/** Arguments the spec gives in its prose rather than in a tool's table. */
const ARGUMENTS_IN_PROSE: Record<string, string[]> = {
  // files §4.5: "`files_read` then takes `version` (title "Version", a string, optional)"
  files_read: ['version'],
}

function pinProfile(profile: ProfileDefinition, file: string, spec: ProfileFacts) {
  describe(`${profile.id} against ${file} at ${facts.source.commit.slice(0, 7)}`, () => {
    it('has the identifier, version, prefix, location argument and labels of the header', () => {
      const h = spec.header
      expect(profile.id).toBe(h.id)
      expect(profile.version).toBe(h.version)
      expect(profile.prefix).toBe(h.prefix)
      expect(profile.location.argument).toBe(h.location)
      expect([profile.location.labels.one, profile.location.labels.list, profile.location.labels.any]).toEqual(h.labels)
    })

    it('has exactly the tools of the tables, in their order, with their titles, effects and marks', () => {
      const tools = spec.tools
      expect(profile.tools.map((t) => t.name)).toEqual(tools.map((t) => t.name))
      for (const s of tools) {
        const t = profile.tools.find((x) => x.name === s.name)
        expect(t?.title, s.name).toBe(s.title)
        expect(t?.effect, s.name).toBe(s.effect)
        expect(t?.untrusted, s.name).toBe(s.mark)
        expect(t?.externalWhen !== undefined, `${s.name} external`).toBe(s.external)
      }
    })

    it('gives the model each description word for word', () => {
      const descriptions = spec.descriptions
      expect(Object.keys(descriptions).sort()).toEqual(profile.tools.map((t) => t.name).sort())
      for (const t of profile.tools) expect(t.description, t.name).toBe(descriptions[t.name])
    })

    it('has exactly the arguments of each table, with their titles, presence and capabilities', () => {
      const tables = spec.arguments
      for (const tool of profile.tools) {
        const rows = tables[tool.name]
        expect(rows, tool.name).toBeDefined()
        const expected = [...(rows ?? []).map((r) => r.name), ...(ARGUMENTS_IN_PROSE[tool.name] ?? [])]
        expect(tool.arguments.map((a) => a.name).sort(), tool.name).toEqual(expected.sort())
        for (const row of rows ?? []) {
          const arg = tool.arguments.find((a) => a.name === row.name)
          expect(arg, `${tool.name}.${row.name}`).toBeDefined()
          if (!arg) continue
          // "as in §3.4": the title and the capability of the creation's argument
          const creation = profile.tools.find((t) => t.name === 'calendar_create_event')
          const same = row.title.startsWith('as in') ? creation?.arguments.find((a) => a.name === row.name) : undefined
          expect(arg.title, `${tool.name}.${row.name} title`).toBe(same ? same.title : row.title)
          const capability = /capability `([^`]+)`/.exec(row.presence)?.[1]
          if (row.presence === 'required') {
            expect(arg.required, `${tool.name}.${row.name} required`).toBe(true)
            expect(arg.capability, `${tool.name}.${row.name} capability`).toBeUndefined()
          } else if (capability) {
            expect(arg.capability, `${tool.name}.${row.name} capability`).toBe(capability)
            expect(arg.required).toBe(false)
          } else if (row.presence === 'of their capabilities') {
            expect(arg.capability, `${tool.name}.${row.name} capability`).toBe(same?.capability)
            expect(arg.capability).toBeDefined()
          } else {
            // optional, "one of …", "optional, where the provider declares …"
            expect(arg.required, `${tool.name}.${row.name} optional`).toBe(false)
            expect(arg.capability, `${tool.name}.${row.name} capability`).toBeUndefined()
          }
        }
      }
    })

    it('has exactly the capabilities of the table, each with its tools', () => {
      const caps = spec.capabilities
      expect(profile.capabilities.map((c) => c.name)).toEqual(caps.map((c) => c.name))
      for (const c of caps) expect(profile.capabilities.find((x) => x.name === c.name)?.tools, c.name).toEqual(c.tools)
      for (const t of profile.tools)
        if (t.capability) expect(profile.capabilities.find((c) => c.name === t.capability)?.tools).toContain(t.name)
    })

    it('names, for each tool, only error codes of the tables', () => {
      const codes = new Set<string>([...COMMON_ERROR_CODES, ...profile.errors.map((e) => e.code)])
      for (const t of profile.tools) for (const c of t.errors) expect(codes.has(c), `${t.name}: ${c}`).toBe(true)
      // every code the prose of "Errors:" names for a tool is among the tool's
      for (const [name, named] of Object.entries(spec.errorsInProse)) {
        const tool = profile.tools.find((t) => t.name === name)
        for (const c of named) if (codes.has(c)) expect(tool?.errors, `${name}: ${c}`).toContain(c)
      }
    })
  })
}

pinProfile(FILES_PROFILE, 'files.md', facts.files)
pinProfile(CALENDAR_PROFILE, 'calendar.md', facts.calendar)

describe('the common part against common.md', () => {
  it('has exactly the error codes of §9, with their members', () => {
    const rows = facts.common.errors
    expect([...COMMON_ERROR_CODES]).toEqual(rows.map((r) => r.code))
    for (const r of rows) {
      const def = COMMON_ERRORS.find((e) => e.code === r.code)
      const members = [...r.members.matchAll(/`([a-zA-Z]+)`/g)].map((m) => m[1])
      expect([...(def?.members ?? []), ...(def?.optionalMembers ?? [])].sort(), r.code).toEqual(members.sort())
    }
  })

  it('has the defaults and the least of each limit of §12', () => {
    const MIB = 1024 * 1024
    const value = (s: string) => (s.endsWith('MiB') ? Number.parseInt(s, 10) * MIB : Number(s))
    const rows = facts.common.limits
    expect(rows.map((r) => r.member)).toEqual(['page', 'readBytes', 'writeBytes'])
    for (const r of rows) {
      expect(DEFAULT_LIMITS[r.member as keyof typeof DEFAULT_LIMITS], r.member).toBe(value(r.default))
      expect(LEAST_LIMITS[r.member as keyof typeof LEAST_LIMITS], r.member).toBe(value(r.least))
    }
  })

  it("adds Files' own code, recipient-refused, with its reasons", () => {
    expect([...RECIPIENT_REFUSED_REASONS]).toEqual(facts.files.recipientRefusedReasons)
    expect(FILES_PROFILE.errors.map((e) => e.code)).toEqual(['recipient-refused'])
    expect(CALENDAR_PROFILE.errors).toEqual([])
  })
})
