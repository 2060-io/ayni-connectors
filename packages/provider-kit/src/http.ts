/**
 * Serving a provider over HTTP with Node: the MCP endpoint, a health check, and, for a provider that is an OAuth
 * resource server (common §11, MCP authorization), its Protected Resource Metadata (RFC 9728) and the `401` that
 * names it to a request without a bearer token. A connector is reachable by its client only: run it inside the
 * deployment, or behind TLS (common §11).
 */
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { DEFAULT_MAX_REQUEST_BODY_BYTES, type ProviderHandler } from './server.js'

/** RFC 9728: what a client reads to find where to sign the person in. */
export interface ProtectedResourceMetadata {
  /** the resource's identifier, the provider's MCP URL */
  resource: string
  authorization_servers: string[]
  scopes_supported?: string[]
  bearer_methods_supported?: string[]
  resource_name?: string
  resource_documentation?: string
}

export interface ServeOptions {
  /** 0 for any free port */
  port?: number
  host?: string
  /** the path of the MCP endpoint, `/mcp` when absent */
  path?: string
  /** for a provider that takes bearer tokens: its metadata, served at `/.well-known/oauth-protected-resource` */
  protectedResource?: ProtectedResourceMetadata
  /** the `Host` values the provider answers, every other refused with `403` (none checked when absent) */
  allowedHosts?: string[]
  /** the largest request body taken, in bytes; the handler's own bound applies too */
  maxRequestBodyBytes?: number
}

export interface RunningProvider {
  /** the URL of the MCP endpoint */
  url: string
  server: HttpServer
  close(): Promise<void>
}

/** The routes of a provider around its MCP handler, as one web-standard function. */
export function routes(handler: ProviderHandler, options: ServeOptions = {}): (request: Request) => Promise<Response> {
  const path = options.path ?? '/mcp'
  const metadataPath = '/.well-known/oauth-protected-resource'
  return async (request) => {
    const url = new URL(request.url)
    if (options.allowedHosts && !options.allowedHosts.includes(request.headers.get('host') ?? ''))
      return new Response('Forbidden', { status: 403 })
    if (url.pathname === '/healthz') return new Response('ok', { status: 200 })
    if (options.protectedResource && (url.pathname === metadataPath || url.pathname === `${metadataPath}${path}`))
      return Response.json(options.protectedResource)
    if (url.pathname !== path) return new Response('Not Found', { status: 404 })
    if (options.protectedResource && !/^Bearer\s+\S+/i.test(request.headers.get('authorization') ?? '')) {
      const metadataUrl = new URL(`${metadataPath}${path}`, url).toString()
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'www-authenticate': `Bearer resource_metadata="${metadataUrl}"` },
      })
    }
    return handler.fetch(request)
  }
}

/** Serves a provider with Node's HTTP server. */
export async function serve(handler: ProviderHandler, options: ServeOptions = {}): Promise<RunningProvider> {
  const fetch = routes(handler, options)
  const node = toNodeHandler(
    { fetch },
    { maxRequestBodySize: options.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES }
  )
  const server = createServer((req, res) => {
    void node(req, res)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => resolve())
  })
  const address = server.address() as AddressInfo
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address
  return {
    url: `http://${host}:${address.port}${options.path ?? '/mcp'}`,
    server,
    close: async () => {
      await handler.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
