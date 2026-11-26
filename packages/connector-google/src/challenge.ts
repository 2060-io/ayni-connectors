/**
 * What the connector answers at the level of HTTP, beside the tools' results (MCP authorization, the Ayni Agent's
 * TOOL-OAUTH-008 and 009): a call whose token Google refuses (Google's `401`, an expired or revoked token) is answered
 * `401` with `WWW-Authenticate: Bearer error="invalid_token"`, so that the client refreshes the token or asks the
 * person to sign in again; a call whose token lacks a scope of the tool (Google's `403` for an insufficient scope) is
 * answered `403` with `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"`, naming the scopes the tool
 * needs at Google, so that the client asks for more access. Both name the Protected Resource Metadata.
 *
 * The provider kit answers a tool's refusal as a tool result. The connector marks those two refusals with members of
 * its own (`x_tokenRefused`, `x_scope`, which the profiles let a server add), and its HTTP layer turns a response
 * whose one result carries one of them into the HTTP answer: the kit is not changed. A client that does not read
 * these HTTP answers is never sent them for anything else.
 */
import type { ProviderHandler } from '@ayni.org/ayni-provider-kit'
import { ProfileError } from '@ayni.org/ayni-provider-kit'

const AUTH = 'https://www.googleapis.com/auth/'

/**
 * The narrowest of Google's scopes that covers every method of Google a tool calls (each method's reference gives the
 * scopes it takes). Which tools a person is given, and so which scopes are asked, is the agent's to say (its
 * architecture §10.10); this table is what the connector needs at Google.
 */
export const TOOL_SCOPES: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  Object.entries({
    files_roots: 'drive.readonly',
    files_list: 'drive.readonly',
    files_get: 'drive.readonly',
    files_read: 'drive.readonly',
    files_search: 'drive.readonly',
    files_list_trash: 'drive.readonly',
    files_shares: 'drive.readonly',
    files_versions: 'drive.readonly',
    files_export: 'drive.readonly',
    files_create: 'drive',
    files_replace: 'drive',
    files_create_folder: 'drive',
    files_move: 'drive',
    files_trash: 'drive',
    files_restore: 'drive',
    files_share: 'drive',
    files_unshare: 'drive',
    files_create_team_root: 'drive',
    files_rename_root: 'drive',
    calendar_calendars: 'calendar.calendarlist.readonly',
    calendar_list_events: 'calendar.events.readonly',
    calendar_get_event: 'calendar.events.readonly',
    calendar_free_busy: 'calendar.events.freebusy',
    calendar_create_event: 'calendar.events',
    calendar_update_event: 'calendar.events',
    calendar_cancel_event: 'calendar.events',
    calendar_respond: 'calendar.events',
  }).map(([tool, scope]) => [tool, [`${AUTH}${scope}`]])
)

/** The members that mark a refusal for the HTTP layer. */
export const TOKEN_REFUSED = 'x_tokenRefused'
export const INSUFFICIENT_SCOPE = 'x_insufficientScope'
export const SCOPE = 'x_scope'

const snake = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

/**
 * A provider whose handlers name, on a refusal for a missing scope, the scopes of their tool (`x_scope`).
 */
export function withToolScopes<P extends object>(provider: P, prefix: string): P {
  const out = { ...provider } as Record<string, unknown>
  for (const [key, value] of Object.entries(provider)) {
    if (typeof value !== 'function') continue
    const scopes = TOOL_SCOPES[`${prefix}${snake(key)}`] ?? []
    out[key] = async (...args: unknown[]) => {
      try {
        return await (value as (...a: unknown[]) => unknown).apply(provider, args)
      } catch (e) {
        if (e instanceof ProfileError && e.members[INSUFFICIENT_SCOPE as keyof typeof e.members] === true)
          throw new ProfileError(e.code, e.message, { ...e.members, [SCOPE]: scopes.join(' ') })
        throw e
      }
    }
  }
  return out as P
}

/** The JSON-RPC messages of a response: one JSON body, or the `data` of each event of a stream. */
function messagesOf(text: string, type: string): unknown[] {
  try {
    if (type.includes('application/json')) return [JSON.parse(text)]
    if (type.includes('text/event-stream')) {
      const out: unknown[] = []
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n')
        if (data) out.push(JSON.parse(data))
      }
      return out
    }
  } catch {
    return []
  }
  return []
}

/** The marks of a refusal in a tool result, if the response is one. */
function marksOf(messages: unknown[]): Record<string, unknown> | undefined {
  for (const m of messages) {
    const result = (m as { result?: { isError?: boolean; structuredContent?: { error?: Record<string, unknown> } } })
      ?.result
    const error = result?.isError ? result.structuredContent?.error : undefined
    if (error && (error[TOKEN_REFUSED] === true || error[INSUFFICIENT_SCOPE] === true)) return error
  }
  return undefined
}

/**
 * A handler whose answers to a call refused for its token or for a missing scope are the HTTP answers of MCP
 * authorization; every other answer goes out as the kit made it. `metadataUrl` is the address of the Protected
 * Resource Metadata for a request.
 */
export function withHttpChallenges(
  handler: ProviderHandler,
  metadataUrl: (request: Request) => string
): ProviderHandler {
  return {
    close: () => handler.close(),
    fetch: async (request) => {
      const response = await handler.fetch(request)
      const type = response.headers.get('content-type') ?? ''
      if (request.method !== 'POST' || !(type.includes('application/json') || type.includes('text/event-stream')))
        return response
      const text = await response.text()
      const marks = marksOf(messagesOf(text, type))
      const meta = `resource_metadata="${metadataUrl(request)}"`
      if (marks?.[TOKEN_REFUSED] === true)
        return new Response('Unauthorized', {
          status: 401,
          headers: {
            'www-authenticate': `Bearer error="invalid_token", error_description="Google refuses the access token", ${meta}`,
          },
        })
      if (marks?.[INSUFFICIENT_SCOPE] === true) {
        const scope = typeof marks[SCOPE] === 'string' && marks[SCOPE] ? `, scope="${marks[SCOPE]}"` : ''
        return new Response('Forbidden', {
          status: 403,
          headers: { 'www-authenticate': `Bearer error="insufficient_scope"${scope}, ${meta}` },
        })
      }
      return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers })
    },
  }
}
