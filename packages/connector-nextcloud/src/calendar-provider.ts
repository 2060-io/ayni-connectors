/**
 * The provider of Calendar of a request (providers §2, §4): the core, `recurrence` and `free-busy` for every CalDAV
 * server (FEAT-CALDAV-001), `attendees` and `respond` only for one that announces `calendar-auto-schedule`
 * (FEAT-CALDAV-006, FEAT-NC-007), never `meeting`. A request that cannot reach its server is declared the core alone,
 * each of whose calls answers why.
 */
import type { CalendarCapability } from '@ayni.org/ayni-feature-profiles'
import { type CalendarProvider, errors, type ProfileError } from '@ayni.org/ayni-provider-kit'
import type { DavAccountData } from './account.js'
import { accountOfPrincipal, CalDav, type CalendarAccount, discoverCaldav } from './caldav.js'
import { statusError } from './dav.js'
import { asProfileError, type RequestScope } from './scope.js'

type Provider = CalendarProvider<DavAccountData>

export function refusingCalendar(problem: ProfileError): Provider {
  const refuse = async (): Promise<never> => {
    throw problem
  }
  return {
    declaration: { capabilities: [], atomicWrites: true },
    calendars: refuse,
    listEvents: refuse,
    getEvent: refuse,
    createEvent: refuse,
    updateEvent: refuse,
    cancelEvent: refuse,
  }
}

/** The features a CalDAV server announces in its `DAV` header (RFC 4918 §10.1). */
export function davFeatures(header: string | undefined): Set<string> {
  return new Set(
    (header ?? '')
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean)
  )
}

export async function calendarFor(scope: RequestScope): Promise<Provider | undefined> {
  const target = scope.target.calendar
  if (!target) return undefined
  const problem = scope.problem
  if (problem || !scope.http) return refusingCalendar(problem ?? errors.accountRefused())
  const http = scope.http
  try {
    let probe: URL
    let find: (signal?: AbortSignal) => Promise<CalendarAccount>
    if (target.kind === 'nextcloud') {
      const nc = await scope.nextcloud(target.base)
      const user = encodeURIComponent(nc.userId)
      const principal = new URL(`principals/users/${user}/`, nc.dav)
      probe = new URL(`calendars/${user}/`, nc.dav)
      find = (signal) => accountOfPrincipal(http, principal, signal)
    } else {
      probe = target.address
      find = (signal) => discoverCaldav(http, target.address, signal)
    }
    const options = await http.send({ method: 'OPTIONS', url: probe })
    if (options.status === 401) throw statusError(options)
    const features = davFeatures(options.headers.dav)
    const scheduling = features.has('calendar-auto-schedule')
    let found: Promise<CalendarAccount> | undefined
    const dav = new CalDav({
      http,
      account: (signal) => {
        found ??= find(signal)
        return found
      },
      scheduling,
      noTimezone: features.has('calendar-no-timezone'),
      logger: scope.config.logger,
    })
    const capabilities: CalendarCapability[] = ['free-busy', 'recurrence']
    if (scheduling) capabilities.push('attendees', 'respond')
    const p: Provider = {
      declaration: { capabilities, atomicWrites: true },
      calendars: (a, c) => dav.calendars(a, c),
      listEvents: (a, c) => dav.listEvents(a, c),
      getEvent: (a, c) => dav.getEvent(a, c),
      createEvent: (a, c) => dav.createEvent(a, c),
      updateEvent: (a, c) => dav.updateEvent(a, c),
      cancelEvent: (a, c) => dav.cancelEvent(a, c),
      freeBusy: (a, c) => dav.freeBusy(a, c),
    }
    if (scheduling) p.respond = (a, c) => dav.respond(a, c)
    return p
  } catch (error) {
    return refusingCalendar(asProfileError(error))
  }
}
