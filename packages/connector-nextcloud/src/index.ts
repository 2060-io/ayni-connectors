/**
 * The Nextcloud connector of Ayni (providers §1 to §5): an MCP server that speaks Files 1.0 over WebDAV and Calendar
 * 1.0 over CalDAV, with a Nextcloud's own interfaces for search, the trash bin, versions, shares and team folders, and
 * any other WebDAV or CalDAV server with fewer operations. The account of each request is in its `Ayni-*` headers
 * (FEAT-DAV-001); its credentials go, over TLS, to the hosts of the request's addresses alone, each checked and pinned
 * (FEAT-DAV-002, 003), and nothing of a request is kept once it is answered (FEAT-DAV-004). One image, no state.
 */
import {
  createProviderHandler,
  type Logger,
  type ProviderHandler,
  type RunningProvider,
  type ServeOptions,
  serve,
  silentLogger,
} from '@ayni.org/ayni-provider-kit'
import { type DavAccountData, davAccount } from './account.js'
import { calendarFor } from './calendar-provider.js'
import { filesFor } from './files-provider.js'
import { type HostPolicy, OPEN_POLICY, type Resolve, systemResolve } from './net.js'
import { type ConnectorConfig, scopeOf } from './scope.js'

export { ACCOUNT_HEADERS, SECRET_HEADERS, targetOf } from './account.js'
export { isLogLevel, jsonLogger, type LogLevel } from './log.js'
export { type HostPolicy, hostPolicy, isPublicAddress, parseAddress, type Resolve, type Resolved } from './net.js'

export const NAME = 'ayni-connector-nextcloud'
export const VERSION = '0.1.0'

export interface NextcloudConnectorOptions {
  logger?: Logger
  /** the key of the cursors, the same on every replica; random per process when absent */
  cursorSecret?: string
  /** the hosts the operator lists, which may resolve to a private address, and whether only they are reached */
  policy?: HostPolicy
  /** certificate authorities to trust beside the runtime's, in PEM (a server of the operator's own authority) */
  ca?: string[]
  /** the most a request to the server may take, in milliseconds (30 s when absent) */
  timeoutMs?: number
  /**
   * The resolver of host names: the system's when absent. A test gives its own to name its stub servers; it cannot
   * widen what is reached, since every address it answers is checked as the system's would be (FEAT-DAV-003).
   */
  resolve?: Resolve
}

export interface NextcloudConnector {
  handler: ProviderHandler
  config: ConnectorConfig
}

/** The connector's web-standard handler. */
export function createNextcloudConnector(options: NextcloudConnectorOptions = {}): NextcloudConnector {
  const logger = options.logger ?? silentLogger
  const config: ConnectorConfig = {
    policy: options.policy ?? OPEN_POLICY,
    resolve: options.resolve ?? systemResolve,
    ...(options.ca?.length ? { ca: options.ca } : {}),
    timeoutMs: options.timeoutMs ?? 30_000,
    logger,
  }
  const handler = createProviderHandler<DavAccountData>({
    name: NAME,
    version: VERSION,
    // the account of each request in its headers, for that request alone (FEAT-DAV-001, FEAT-CORE-019)
    readAccount: davAccount(),
    files: (account, request) => filesFor(scopeOf(request, account, config)),
    calendar: (account, request) => calendarFor(scopeOf(request, account, config)),
    logger,
    ...(options.cursorSecret ? { cursorSecret: options.cursorSecret } : {}),
    instructions:
      'Files over WebDAV and Calendar over CalDAV, of a Nextcloud or any other such server, with the account of the Ayni-* headers of each request.',
  })
  return { handler, config }
}

/** Starts the connector on HTTP: `/mcp` and `/healthz`. */
export async function startNextcloudConnector(
  options: NextcloudConnectorOptions & Omit<ServeOptions, 'protectedResource'> = {}
): Promise<NextcloudConnector & { running: RunningProvider; url: string }> {
  const connector = createNextcloudConnector(options)
  const running = await serve(connector.handler, options)
  return { ...connector, running, url: running.url }
}
