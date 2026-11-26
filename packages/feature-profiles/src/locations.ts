/**
 * Locations (common §6): every item of a result carries the location of its call, in the member named after the
 * location argument (FEAT-CORE-013). A provider checks its own results with these; a client drops what does not carry
 * the location before anything reads it (the Ayni Agent's TOOL-FEAT-015).
 */
import type { ProfileDefinition } from './profile.js'

type Obj = Record<string, unknown>

/** The items of a result, from the members the profile gives for the tool. */
export function itemsOfResult(profile: ProfileDefinition, toolName: string, result: unknown): Obj[] {
  const tool = profile.tools.find((t) => t.name === toolName)
  if (!tool || !result || typeof result !== 'object') return []
  const out: Obj[] = []
  for (const member of tool.itemMembers) {
    const value = (result as Obj)[member]
    if (Array.isArray(value)) for (const v of value) out.push(v as Obj)
    else if (value && typeof value === 'object') out.push(value as Obj)
  }
  return out
}

/** The items of a result that do not carry the location of the call. */
export function foreignItems(profile: ProfileDefinition, toolName: string, args: Obj, result: unknown): Obj[] {
  const location = args[profile.location.argument]
  const member = profile.location.argument
  return itemsOfResult(profile, toolName, result).filter((item) => item[member] !== location)
}

/**
 * A result with every item that does not carry the location of its call left out of its lists; `undefined` when a
 * member that holds one item does not carry it, so that the whole result cannot be read as the profile's.
 */
export function dropForeignItems(
  profile: ProfileDefinition,
  toolName: string,
  args: Obj,
  result: Obj
): { result: Obj; dropped: number } | undefined {
  const tool = profile.tools.find((t) => t.name === toolName)
  if (!tool) return undefined
  const location = args[profile.location.argument]
  const member = profile.location.argument
  let dropped = 0
  const out: Obj = { ...result }
  for (const m of tool.itemMembers) {
    const value = result[m]
    if (Array.isArray(value)) {
      const kept = value.filter((v) => (v as Obj)?.[member] === location)
      dropped += value.length - kept.length
      out[m] = kept
    } else if (value !== undefined && (value as Obj)?.[member] !== location) {
      return undefined
    }
  }
  return { result: out, dropped }
}
