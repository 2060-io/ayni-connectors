/**
 * The Ayni Feature Profiles 1.0 as code: Files 1.0 and Calendar 1.0 on the common part, transcribed from the spec
 * (`2060-io/ayni-spec`, `v4/ayni-feature-profiles/`). For a provider (a server) and for a client (the Ayni Agent) alike.
 */
import { CALENDAR_PROFILE } from './calendar.js'
import { FILES_PROFILE } from './files.js'
import type { ProfileDefinition } from './profile.js'

export * from './calendar.js'
export type * from './calendar-types.js'
export * from './check.js'
export * from './common.js'
export * from './files.js'
export type * from './files-types.js'
export * from './locations.js'
export * from './profile.js'
export * from './rule.js'
export * from './validation.js'

/** Every profile of this version of the package, by identifier. */
export const PROFILES: Readonly<Record<string, ProfileDefinition>> = {
  [FILES_PROFILE.id]: FILES_PROFILE,
  [CALENDAR_PROFILE.id]: CALENDAR_PROFILE,
}

/** The profile of an identifier, or `undefined` for one this package does not know. */
export function profileOf(id: string): ProfileDefinition | undefined {
  return PROFILES[id]
}
