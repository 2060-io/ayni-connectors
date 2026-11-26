import type { CalendarProvider } from '@ayni.org/ayni-provider-kit'
import type { DavAccountData } from './account.js'
import type { RequestScope } from './scope.js'

export async function calendarFor(_scope: RequestScope): Promise<CalendarProvider<DavAccountData> | undefined> {
  return undefined
}
