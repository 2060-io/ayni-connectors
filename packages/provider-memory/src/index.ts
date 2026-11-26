/**
 * An in-memory provider of Files 1.0 and Calendar 1.0 with every capability, on the provider kit: the reference the
 * conformance kit runs against in CI, and a fake for a client's tests (the Ayni Agent's). Accounts are bearer tokens
 * of the service's users. Nothing is kept beyond the process; every example is fictional.
 */
import { randomBytes } from 'node:crypto'
import {
  bearerAccount,
  createProviderHandler,
  type Logger,
  type ProviderHandler,
  type RunningProvider,
  type ServeOptions,
  serve,
} from '@ayni.org/ayni-provider-kit'
import { type MemoryCalendarOptions, MemoryCalendars } from './calendar.js'
import { MemoryFiles, type MemoryFilesOptions } from './files.js'
import { MemoryService, type MemoryUser } from './store.js'

export { type MemoryCalendarOptions, MemoryCalendars } from './calendar.js'
export { MemoryFiles, type MemoryFilesOptions } from './files.js'
export { MemoryService, type MemoryUser, type SentMessage } from './store.js'

export interface MemoryProviderOptions {
  /** the service's accounts: three fictional ones with random tokens when absent */
  users?: MemoryUser[]
  /** Files: every capability when absent, none of Files with `false` */
  files?: MemoryFilesOptions | false
  calendar?: MemoryCalendarOptions | false
  logger?: Logger
  cursorSecret?: string
}

export interface MemoryProvider {
  handler: ProviderHandler
  service: MemoryService
  files?: MemoryFiles
  calendar?: MemoryCalendars
}

/** Three fictional accounts of one organization, `example.org`, and one outside it, with random tokens. */
export function demoUsers(): MemoryUser[] {
  const token = () => randomBytes(18).toString('base64url')
  return [
    { id: 'avery', name: 'Avery Example', email: 'avery@example.org', token: token() },
    { id: 'blake', name: 'Blake Example', email: 'blake@example.org', token: token() },
    { id: 'morgan', name: 'Morgan Example', email: 'morgan@example.org', token: token() },
    { id: 'riley', name: 'Riley Partner', email: 'riley@partner.example', token: token() },
  ]
}

export function createMemoryProvider(options: MemoryProviderOptions = {}): MemoryProvider {
  const service = new MemoryService(options.users ?? demoUsers())
  const files = options.files === false ? undefined : new MemoryFiles(service, options.files)
  const calendar = options.calendar === false ? undefined : new MemoryCalendars(service, options.calendar)
  const bearer = bearerAccount()
  const handler = createProviderHandler<MemoryUser>({
    name: 'ayni-provider-memory',
    version: '0.1.0',
    readAccount: async (request) => {
      const b = await bearer(request)
      const user = b ? service.userByToken(b.data.token) : undefined
      // an unknown token is no account: a call answers account-refused
      return b && user ? { id: b.id, secrets: b.secrets, data: user } : undefined
    },
    ...(files ? { files: () => files.provider() } : {}),
    ...(calendar ? { calendar: () => calendar.provider() } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.cursorSecret ? { cursorSecret: options.cursorSecret } : {}),
  })
  return { handler, service, ...(files ? { files } : {}), ...(calendar ? { calendar } : {}) }
}

/** Starts an in-memory provider on HTTP (a free port of 127.0.0.1 by default). */
export async function startMemoryProvider(
  options: MemoryProviderOptions & ServeOptions = {}
): Promise<MemoryProvider & { running: RunningProvider; url: string }> {
  const provider = createMemoryProvider(options)
  const running = await serve(provider.handler, options)
  return { ...provider, running, url: running.url }
}

export { conformanceSetup } from './setup.js'
