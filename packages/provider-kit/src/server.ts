/**
 * The MCP server of a provider (Streamable HTTP, MCP revision 2026-07-28 with the stateless serving of earlier
 * revisions): one server per HTTP request, for the account that request carries (common §11). It declares each profile
 * the provider implements for that account under its identifier in `capabilities.extensions`, in `server/discover`
 * and in `initialize` alike (FEAT-CORE-001); lists exactly the tools of the core and of the declared capabilities, with
 * the profile's definitions (FEAT-CORE-002 to 004, 018); checks every call against the contract before a handler runs
 * (FEAT-CORE-005); pages (FEAT-CORE-016, 026); and answers every result and error in both forms (FEAT-CORE-006, 007).
 */
import {
  CALENDAR_PROFILE,
  type CalendarDeclaration,
  checkCall,
  type DeclarationBase,
  FILES_PROFILE,
  type FilesDeclaration,
  foreignItems,
  type Limits,
  limitsOf,
  type McpToolDefinition,
  mcpToolsFor,
  type ProfileDefinition,
  pageSizeOf,
  type ToolDefinition,
  toolsFor,
  validateDeclaration,
  validateResult,
} from '@ayni.org/ayni-feature-profiles'
import {
  acceptedContent,
  type CallToolResult,
  createMcpHandler,
  inputRequired,
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type ServerCapabilities,
  type ServerContext,
  type Tool,
} from '@modelcontextprotocol/server'
import type { Account, AccountReader } from './account.js'
import { bindingOf, CursorCodec } from './cursor.js'
import { errors, isProfileError, ProfileError, scrub } from './errors.js'
import {
  type Awaitable,
  type CalendarProvider,
  type CallContext,
  type FilesProvider,
  handlerName,
  type Logger,
  type Question,
  silentLogger,
} from './providers.js'

export interface ProviderServerOptions<D = unknown> {
  /** the server's name and version, as `serverInfo` */
  name: string
  version: string
  /** reads the account of each request (common §11) */
  readAccount: AccountReader<D>
  /**
   * The provider of Files for the account of a request, or `undefined` to declare no Files to it (a connector that
   * serves Files only to a request that names a file store, FEAT-DAV-001). What it declares may differ between accounts
   * and must not differ otherwise (FEAT-CORE-025).
   */
  files?: (account: Account<D> | undefined, request: Request) => Awaitable<FilesProvider<D> | undefined>
  /** The provider of Calendar for the account of a request, likewise. */
  calendar?: (account: Account<D> | undefined, request: Request) => Awaitable<CalendarProvider<D> | undefined>
  /** the key of the cursors: the same on every replica of a provider, random per process when absent */
  cursorSecret?: string | Uint8Array
  cursorLifetimeSeconds?: number
  logger?: Logger
  /** checks every result a handler answers against the profile before it leaves (true when absent) */
  validateResults?: boolean
  /** the largest request body taken, in bytes: a content of `writeBytes` in base64 and its call (16 MiB when absent) */
  maxRequestBodyBytes?: number
  instructions?: string
}

/** 16 MiB: a content of the default `writeBytes` (10 MiB) in base64, with room for its call. */
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024

/** The web-standard face of a provider: one HTTP request in, its response out. */
export interface ProviderHandler {
  fetch(request: Request): Promise<Response>
  close(): Promise<void>
}

type AnyProvider = FilesProvider<unknown> | CalendarProvider<unknown>

interface Bound {
  profile: ProfileDefinition
  provider: AnyProvider
  declaration: DeclarationBase & Record<string, unknown>
  limits: Limits
  tools: ToolDefinition[]
  definitions: McpToolDefinition[]
}

/** Thrown by `ctx.ask` when the person has not answered yet: the call answers an input request. */
class AskSignal extends Error {
  public constructor(public readonly question: Question) {
    super('a question for the person')
  }
}

/**
 * The declaration of a profile for an account (common §3): `version`, then `capabilities` in the profile's order,
 * `limits`, `atomicWrites` and the profile's own members, in one order, so that one account reads the same bytes on
 * every request (FEAT-CORE-025).
 */
export function declarationOf(
  profile: ProfileDefinition,
  provider: AnyProvider
): DeclarationBase & Record<string, unknown> {
  const given = provider.declaration as unknown as Record<string, unknown> & { capabilities: string[] }
  const order = profile.capabilities.map((c) => c.name)
  const capabilities = [...given.capabilities].sort((a, b) => order.indexOf(a) - order.indexOf(b))
  const out: Record<string, unknown> = { version: profile.version, capabilities }
  const limits = given.limits as Partial<Limits> | undefined
  if (limits) {
    const l: Record<string, number> = {}
    for (const k of ['page', 'readBytes', 'writeBytes'] as const)
      if (limits[k] !== undefined) l[k] = limits[k] as number
    out.limits = l
  }
  if (given.atomicWrites !== undefined) out.atomicWrites = given.atomicWrites
  for (const member of Object.keys(profile.declarationMembers))
    if (given[member] !== undefined) out[member] = given[member]
  return out as DeclarationBase & Record<string, unknown>
}

function bind(profile: ProfileDefinition, provider: AnyProvider): Bound {
  const declaration = declarationOf(profile, provider)
  const problems = validateDeclaration(profile, declaration)
  if (problems.length) throw new Error(`the declaration of ${profile.id} is not the profile's: ${problems.join('; ')}`)
  const tools = toolsFor(profile, declaration.capabilities)
  for (const t of tools) {
    const name = handlerName(t.name, profile.prefix)
    if (typeof (provider as unknown as Record<string, unknown>)[name] !== 'function')
      throw new Error(`${profile.id} declares ${t.capability ?? 'its core'} but the provider has no handler ${name}`)
  }
  return {
    profile,
    provider,
    declaration,
    limits: limitsOf(declaration),
    tools,
    definitions: mcpToolsFor(profile, declaration.capabilities),
  }
}

function result(content: object, isError = false): CallToolResult {
  return {
    ...(isError ? { isError: true } : {}),
    structuredContent: content as Record<string, unknown>,
    content: [{ type: 'text', text: JSON.stringify(content) }],
  }
}

function base64Length(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}

/** The UTF-8 bytes of a text cut at a character, at most `maxBytes` of them. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return { text, truncated: false }
  let end = maxBytes
  // step back over continuation bytes (10xxxxxx) to the start of a character
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true }
}

/** The size of a content a call writes, in bytes. */
function writtenBytes(content: unknown): number | undefined {
  if (!content || typeof content !== 'object') return undefined
  const c = content as { text?: string; base64?: string }
  if (typeof c.text === 'string') return Buffer.byteLength(c.text, 'utf8')
  if (typeof c.base64 === 'string') return base64Length(c.base64)
  return undefined
}

/** The list member of the result of a tool that lists. */
function listMemberOf(tool: ToolDefinition): string | undefined {
  const props = (tool.result.properties ?? {}) as Record<string, { type?: string }>
  return Object.keys(props).find((k) => props[k]?.type === 'array')
}

/** Contents read: a text cut at `maxBytes` or `readBytes`, bytes over `readBytes` refused, an export over it refused. */
function boundContent(toolName: string, args: Record<string, unknown>, out: Record<string, unknown>, limits: Limits) {
  if (toolName !== 'files_read' && toolName !== 'files_export') return
  const content = out.content as { kind?: string; text?: string; base64?: string } | undefined
  if (!content) return
  if (content.kind === 'bytes' && typeof content.base64 === 'string') {
    const size = base64Length(content.base64)
    if (size > limits.readBytes) throw errors.tooLarge(limits.readBytes, size)
  }
  if (content.kind === 'text' && typeof content.text === 'string') {
    if (toolName === 'files_export') {
      const size = Buffer.byteLength(content.text, 'utf8')
      if (size > limits.readBytes) throw errors.tooLarge(limits.readBytes, size)
      return
    }
    const max = Math.min((args.maxBytes as number | undefined) ?? limits.readBytes, limits.readBytes)
    const cut = truncateUtf8(content.text, max)
    if (cut.truncated) {
      out.content = { ...content, text: cut.text }
      out.truncated = true
    }
  }
}

/** Creates the web-standard handler of a provider. */
export function createProviderHandler<D = unknown>(options: ProviderServerOptions<D>): ProviderHandler {
  const logger = options.logger ?? silentLogger
  const codec = new CursorCodec(options.cursorSecret, options.cursorLifetimeSeconds)
  const validate = options.validateResults ?? true

  async function call(
    bound: Bound[],
    account: Account<D> | undefined,
    name: string,
    rawArgs: Record<string, unknown> | undefined,
    sdk: ServerContext
  ): Promise<CallToolResult> {
    const b = bound.find((x) => x.tools.some((t) => t.name === name))
    const tool = b?.tools.find((t) => t.name === name)
    if (!b || !tool) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${name}`)
    const started = Date.now()
    const secrets = account?.secrets ?? []
    try {
      if (!account) throw errors.accountRefused()
      const args = rawArgs ?? {}
      const refusal = checkCall(b.profile, name, args, b.declaration)
      if (refusal) throw new ProfileError(refusal.code, refusal.message, refusal.field ? { field: refusal.field } : {})
      if (name === 'files_create' || name === 'files_replace') {
        const size = writtenBytes(args.content)
        if (size !== undefined && size > b.limits.writeBytes) throw errors.tooLarge(b.limits.writeBytes, size)
      }
      const binding = bindingOf(name, args, account.id)
      const ctx: CallContext<D, unknown> & { page?: { limit: number; cursor?: string } } = {
        account,
        declaration: b.declaration,
        limits: b.limits,
        signal: sdk.mcpReq.signal,
        logger,
        ask: (question) => {
          const responses = sdk.mcpReq.inputResponses
          if (!responses || !(question.key in responses)) throw new AskSignal(question)
          const answer = acceptedContent<{ confirm?: unknown }>(responses, question.key)
          if (answer?.confirm !== true)
            throw errors.permissionDenied('The person declined the question of the service.')
        },
      }
      let handlerArgs: Record<string, unknown> = args
      if (tool.pages) {
        const { limit, cursor, ...rest } = args
        ctx.page = {
          limit: pageSizeOf(limit as number | undefined, b.limits),
          ...(typeof cursor === 'string' ? { cursor: codec.open(binding, cursor) } : {}),
        }
        handlerArgs = rest
      }
      const handler = (b.provider as unknown as Record<string, (a: unknown, c: unknown) => unknown>)[
        handlerName(name, b.profile.prefix)
      ] as (a: unknown, c: unknown) => unknown
      const answered = (await handler.call(b.provider, handlerArgs, ctx)) as Record<string, unknown>
      const out: Record<string, unknown> = { ...answered }
      boundContent(name, args, out, b.limits)
      if (validate) {
        const problems = validateResult(b.profile, name, out)
        const foreign = tool.located ? foreignItems(b.profile, name, args, out).length : 0
        const list = tool.pages ? listMemberOf(tool) : undefined
        const tooMany = list && ctx.page && Array.isArray(out[list]) && (out[list] as unknown[]).length > ctx.page.limit
        if (problems.length || foreign || tooMany) {
          logger.error(
            { tool: name, problems: problems.slice(0, 5), foreignItems: foreign, tooMany: !!tooMany },
            'a handler answered a result that is not the profile’s'
          )
          throw errors.unavailable('The provider answered a result that is not the profile’s.')
        }
      }
      if (typeof out.nextCursor === 'string') out.nextCursor = codec.seal(binding, out.nextCursor)
      logger.debug({ tool: name, outcome: 'ok', ms: Date.now() - started }, 'tool call')
      return result(out)
    } catch (error) {
      if (error instanceof AskSignal) {
        logger.debug({ tool: name, outcome: 'input-required' }, 'tool call')
        return inputRequired({
          inputRequests: {
            [error.question.key]: inputRequired.elicit({
              message: error.question.message,
              requestedSchema: {
                type: 'object',
                properties: { confirm: { type: 'boolean', title: 'Confirm' } },
                required: ['confirm'],
              },
            }),
          },
        }) as unknown as CallToolResult
      }
      if (error instanceof ProtocolError) throw error
      const e = isProfileError(error) ? error : errors.unavailable()
      if (!isProfileError(error))
        logger.error({ tool: name, error: error instanceof Error ? error.name : typeof error }, 'a handler failed')
      const content = e.toContent()
      content.error.message = scrub(content.error.message, secrets)
      logger.debug({ tool: name, outcome: e.code, ms: Date.now() - started }, 'tool call')
      return result(content, true)
    }
  }

  const handler = createMcpHandler(
    async ({ requestInfo }) => {
      const request = requestInfo ?? new Request('http://provider.invalid/mcp')
      const account = await options.readAccount(request)
      const bound: Bound[] = []
      if (options.files) {
        const p = await options.files(account, request)
        if (p) bound.push(bind(FILES_PROFILE, p as AnyProvider))
      }
      if (options.calendar) {
        const p = await options.calendar(account, request)
        if (p) bound.push(bind(CALENDAR_PROFILE, p as AnyProvider))
      }
      const extensions = Object.fromEntries(
        bound.map((b) => [b.profile.id, b.declaration])
      ) as ServerCapabilities['extensions']
      const server = new Server(
        { name: options.name, version: options.version },
        {
          capabilities: { tools: {}, extensions },
          ...(options.instructions ? { instructions: options.instructions } : {}),
        }
      )
      server.setRequestHandler('tools/list', async () => ({
        tools: bound.flatMap((b) => b.definitions) as unknown as Tool[],
      }))
      server.setRequestHandler('tools/call', async (req, ctx) =>
        call(bound, account, req.params.name, req.params.arguments as Record<string, unknown> | undefined, ctx)
      )
      return server
    },
    {
      onerror: (error) => logger.warn({ error: error.name }, 'mcp request refused'),
      maxRequestBodySize: options.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES,
    }
  )

  return { fetch: (request) => handler.fetch(request), close: () => handler.close() }
}

export type { CalendarDeclaration, FilesDeclaration }
