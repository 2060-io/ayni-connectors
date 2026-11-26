/**
 * Reads the spec's documents (`2060-io/ayni-spec`, `v4/ayni-feature-profiles/`) into the facts their tables and lines
 * give: tools, titles, effects, marks, descriptions, arguments, capabilities, errors, limits and requirement ids. The
 * facts of the commit the package follows are kept in `spec/facts.json`; the documents themselves are not part of this
 * repository.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const FACTS_FILE = join(import.meta.dirname, '..', 'spec', 'facts.json')

export function specText(dir: string, file: string): string {
  return readFileSync(join(dir, file), 'utf8')
}

/** The cells of every row of every markdown table of a text, rows with their line index. */
function tableRows(text: string): { cells: string[]; line: number }[] {
  const out: { cells: string[]; line: number }[] = []
  text.split('\n').forEach((line, i) => {
    if (!line.startsWith('|') || /^\|[-| :]+\|$/.test(line.trim())) return
    const cells = line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim())
    out.push({ cells, line: i })
  })
  return out
}

const code = (cell: string): string[] => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string)

export interface SpecTool {
  name: string
  title: string
  effect: string
  external: boolean
  mark: string
}

/** The rows of the tables `| Tool | Title | Effect | Result carries … |`. */
export function specTools(text: string, prefix: string): SpecTool[] {
  const lines = text.split('\n')
  const out: SpecTool[] = []
  lines.forEach((line, start) => {
    if (!line.startsWith('| Tool | Title | Effect |')) return
    for (let i = start + 2; i < lines.length && lines[i]?.startsWith('|'); i++) {
      const cells = (lines[i] as string)
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => c.trim())
      const [name, title, effect, mark] = cells as [string, string, string, string]
      const n = code(name)[0] as string
      if (!n.startsWith(prefix)) continue
      out.push({
        name: n,
        title,
        effect: code(effect)[0] as string,
        external: code(effect).includes('external'),
        mark: mark.split(':')[0]?.trim() as string,
      })
    }
  })
  return out
}

/** Each tool's `*Description:*`, joined over its lines, by the tool named last before it. */
export function specDescriptions(text: string, prefix: string): Map<string, string> {
  const out = new Map<string, string>()
  const re = /\*Description:\* "([^"]+)"/g
  for (const m of text.matchAll(re)) {
    const before = text.slice(0, m.index)
    const names = [...before.matchAll(new RegExp(`\`(${prefix}[a-z_]+)\``, 'g'))]
    const name = names[names.length - 1]?.[1]
    if (name) out.set(name, (m[1] as string).replace(/\s*\n\s*/g, ' '))
  }
  return out
}

export interface SpecArgument {
  name: string
  title: string
  presence: string
}

/** Each tool's table `| Argument | Title | Type | | Meaning |`, the first after its description. */
export function specArguments(text: string, prefix: string): Map<string, SpecArgument[]> {
  const lines = text.split('\n')
  const out = new Map<string, SpecArgument[]>()
  const descriptions = [...text.matchAll(/\*Description:\* "/g)]
  for (const d of descriptions) {
    const before = text.slice(0, d.index)
    const names = [...before.matchAll(new RegExp(`\`(${prefix}[a-z_]+)\``, 'g'))]
    const tool = names[names.length - 1]?.[1]
    if (!tool) continue
    const startLine = before.split('\n').length
    let i = startLine
    while (i < lines.length && !lines[i]?.startsWith('| Argument')) i++
    const args: SpecArgument[] = []
    for (i += 2; i < lines.length && lines[i]?.startsWith('|'); i++) {
      const cells = (lines[i] as string)
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => c.trim())
      const [names, title, , presence] = cells as [string, string, string, string]
      for (const n of code(names)) args.push({ name: n, title, presence })
    }
    out.set(tool, args)
  }
  return out
}

/** The rows of the table `| Capability | Tools | Adds to core tools |`. */
export function specCapabilities(text: string): { name: string; tools: string[] }[] {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.startsWith('| Capability | Tools |'))
  const out: { name: string; tools: string[] }[] = []
  for (let i = start + 2; i < lines.length && lines[i]?.startsWith('|'); i++) {
    const cells = (lines[i] as string)
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim())
    out.push({ name: code(cells[0] ?? '')[0] as string, tools: code(cells[1] ?? '').filter((t) => /^[a-z]+_/.test(t)) })
  }
  return out
}

/** The header lines of a profile: identifier, version, prefix, location argument and labels. */
export function specHeader(text: string): {
  id: string
  version: string
  prefix: string
  location: string
  labels: string[]
} {
  const id = /\*\*Identifier:\*\* `([^`]+)`/.exec(text)?.[1] as string
  const version = /\*\*Version:\*\* `([^`]+)`/.exec(text)?.[1] as string
  const prefix = /\*\*Prefix:\*\* `([^`]+)`/.exec(text)?.[1] as string
  const location = /\*\*Location argument:\*\* `([^`]+)`/.exec(text)?.[1] as string
  const labelsLine = /\*\*Location's labels\*\*[^\n]*/.exec(text)?.[0] ?? ''
  return { id, version, prefix, location, labels: code(labelsLine) }
}

/** The codes of the error table of common §9. */
export function specCommonErrors(text: string): { code: string; members: string }[] {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.startsWith('| `code` | When |'))
  const out: { code: string; members: string }[] = []
  for (let i = start + 2; i < lines.length && lines[i]?.startsWith('|'); i++) {
    const cells = (lines[i] as string)
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim())
    out.push({ code: code(cells[0] ?? '')[0] as string, members: cells[2] ?? '' })
  }
  return out
}

/** The rows of the limits table of common §12: member, default, least. */
export function specLimits(text: string): { member: string; default: string; least: string }[] {
  return tableRows(text)
    .filter((r) => r.cells.length === 4 && /^`(page|readBytes|writeBytes)`$/.test(r.cells[0] ?? ''))
    .map((r) => ({ member: code(r.cells[0] ?? '')[0] as string, default: r.cells[2] ?? '', least: r.cells[3] ?? '' }))
}

/** The requirement ids a document defines (`- **[FEAT-…]**`), in order. */
export function specRequirementIds(text: string): string[] {
  return [...text.matchAll(/^- \*\*\[(FEAT-[A-Z]+-\d{3})\]\*\*/gm)].map((m) => m[1] as string)
}

/** The reasons of `recipient-refused` the text of files §4.7 gives. */
export function specRecipientRefusedReasons(text: string): string[] {
  const m = /answers `recipient-refused`, with `reason`:([\s\S]*?)\.\n/.exec(text)
  return m ? code(m[1] ?? '').filter((c) => /^[a-z-]+$/.test(c)) : []
}

export interface ProfileFacts {
  header: ReturnType<typeof specHeader>
  tools: SpecTool[]
  descriptions: Record<string, string>
  arguments: Record<string, SpecArgument[]>
  capabilities: ReturnType<typeof specCapabilities>
  /** for each tool the error codes the prose of "Errors:" names */
  errorsInProse: Record<string, string[]>
  requirementIds: string[]
}

export interface SpecFacts {
  source: { repository: string; path: string; commit: string }
  common: {
    errors: ReturnType<typeof specCommonErrors>
    limits: ReturnType<typeof specLimits>
    requirementIds: string[]
  }
  files: ProfileFacts & { recipientRefusedReasons: string[] }
  calendar: ProfileFacts
}

function errorsInProse(text: string, prefix: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const m of text.matchAll(/Errors( also)?: ([^\n]+(\n[^\n#|]+)*)/g)) {
    const before = text.slice(0, m.index)
    const name = [...before.matchAll(new RegExp(`\`(${prefix}[a-z_]+)\``, 'g'))].pop()?.[1]
    if (!name) continue
    const codes = [...(m[2] ?? '').matchAll(/`([a-z-]+)`/g)].map((x) => x[1] as string)
    out[name] = [...new Set([...(out[name] ?? []), ...codes])]
  }
  return out
}

function profileFacts(text: string, prefix: string): ProfileFacts {
  return {
    header: specHeader(text),
    tools: specTools(text, prefix),
    descriptions: Object.fromEntries(specDescriptions(text, prefix)),
    arguments: Object.fromEntries(specArguments(text, prefix)),
    capabilities: specCapabilities(text),
    errorsInProse: errorsInProse(text, prefix),
    requirementIds: specRequirementIds(text),
  }
}

/** The facts of the documents of a directory, a checkout of `v4/ayni-feature-profiles/`. */
export function factsOf(dir: string, source: SpecFacts['source']): SpecFacts {
  const common = specText(dir, 'common.md')
  const files = specText(dir, 'files.md')
  return {
    source,
    common: {
      errors: specCommonErrors(common),
      limits: specLimits(common),
      requirementIds: specRequirementIds(common),
    },
    files: { ...profileFacts(files, 'files_'), recipientRefusedReasons: specRecipientRefusedReasons(files) },
    calendar: profileFacts(specText(dir, 'calendar.md'), 'calendar_'),
  }
}

export function readFacts(): SpecFacts {
  return JSON.parse(readFileSync(FACTS_FILE, 'utf8')) as SpecFacts
}
