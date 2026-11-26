/**
 * The Google connector of Ayni: an MCP server that speaks Files 1.0 over the Google Drive API v3 and Calendar 1.0 over
 * the Google Calendar API v3 (providers §6), with the person's own Google access token of each request in
 * `Authorization: Bearer` (common §11, TOOL-OAUTH-018). It holds no account, no secret, no client and no token: one
 * image, no state. Its Protected Resource Metadata names Google's authorization server, and a request without a token
 * is answered `401` with the pointer to it.
 */
import {
  bearerAccount,
  createProviderHandler,
  type Logger,
  type ProtectedResourceMetadata,
  type ProviderHandler,
  type RunningProvider,
  type ServeOptions,
  serve,
  silentLogger,
} from '@ayni.org/ayni-provider-kit'
import { calendarProvider } from './calendar.js'
import { driveProvider, type GoogleAccount } from './drive.js'
import { GOOGLE_AUTHORIZATION_SERVER, type GoogleEndpoints, resolveEndpoints } from './endpoints.js'
import { GoogleClient } from './google.js'

export { CALENDAR_DECLARATION } from './calendar.js'
export { FILES_DECLARATION, type GoogleAccount, WRITE_BYTES } from './drive.js'
export {
  GOOGLE_API_HOST,
  GOOGLE_AUTHORIZATION_SERVER,
  GOOGLE_ENDPOINTS,
  type GoogleEndpoints,
  isGoogleEndpoint,
  isLoopbackEndpoint,
} from './endpoints.js'
export { GoogleError, profileErrorOf } from './google.js'
export { isLogLevel, jsonLogger, type LogLevel } from './log.js'

export const NAME = 'ayni-connector-google'
export const VERSION = '0.1.0'

export interface GoogleConnectorOptions {
  /**
   * The address of the MCP endpoint as its clients reach it (`http://connector-google.internal:8000/mcp`): the
   * `resource` of the Protected Resource Metadata, which a client checks against the address it was given (RFC 9728).
   * When absent, the address the server listens on.
   */
  resourceUrl?: string
  logger?: Logger
  /** the key of the cursors, the same on every replica; random per process when absent (one replica needs none) */
  cursorSecret?: string
  /** the fetch the connector reaches Google with; the runtime's when absent */
  fetch?: typeof fetch
  /**
   * For tests only: the base addresses of a stub of Google's interfaces, on a loopback address (any other host is
   * refused). The command line and the image never set it; without it, the connector reaches
   * `https://www.googleapis.com` and nothing else.
   */
  testEndpoints?: Partial<GoogleEndpoints>
  /** serve Files over Drive (true when absent) */
  files?: boolean
  /** serve Calendar over Google Calendar (true when absent) */
  calendar?: boolean
}

export interface GoogleConnector {
  handler: ProviderHandler
  endpoints: GoogleEndpoints
  /** the Protected Resource Metadata, whose `resource` a server started without `resourceUrl` sets once it listens */
  protectedResource: ProtectedResourceMetadata
}

/** The connector's web-standard handler, with the endpoints it reaches and its metadata. */
export function createGoogleConnector(options: GoogleConnectorOptions = {}): GoogleConnector {
  const logger = options.logger ?? silentLogger
  const endpoints = resolveEndpoints(options.testEndpoints, options.testEndpoints !== undefined)
  const fetchFn = options.fetch ?? fetch
  const client = (ctx: { account: { data: GoogleAccount }; signal: AbortSignal; logger: Logger }) =>
    new GoogleClient(ctx.account.data.token, endpoints, fetchFn, ctx.signal, ctx.logger)
  const files = options.files === false ? undefined : driveProvider(client)
  const calendar = options.calendar === false ? undefined : calendarProvider(client)
  const handler = createProviderHandler<GoogleAccount>({
    name: NAME,
    version: VERSION,
    // the person's Google access token, used for the call that carries it and kept no longer (TOOL-OAUTH-018)
    readAccount: bearerAccount(),
    ...(files ? { files: () => files } : {}),
    ...(calendar ? { calendar: () => calendar } : {}),
    logger,
    ...(options.cursorSecret ? { cursorSecret: options.cursorSecret } : {}),
    instructions:
      'Files over Google Drive and Calendar over Google Calendar, with the Google account of the access token of each request.',
  })
  const protectedResource: ProtectedResourceMetadata = {
    resource: options.resourceUrl ?? '',
    authorization_servers: [GOOGLE_AUTHORIZATION_SERVER],
    bearer_methods_supported: ['header'],
    resource_name: 'Ayni connector for Google Drive and Google Calendar',
  }
  return { handler, endpoints, protectedResource }
}

/** Starts the connector on HTTP: `/mcp`, `/healthz`, and its Protected Resource Metadata. */
export async function startGoogleConnector(
  options: GoogleConnectorOptions & Omit<ServeOptions, 'protectedResource'> = {}
): Promise<GoogleConnector & { running: RunningProvider; url: string }> {
  const connector = createGoogleConnector(options)
  const running = await serve(connector.handler, { ...options, protectedResource: connector.protectedResource })
  // routes read the metadata at each request: a server started on any free port names the address it listens on
  if (!options.resourceUrl) connector.protectedResource.resource = running.url
  return { ...connector, running, url: running.url }
}
