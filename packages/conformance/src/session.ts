/**
 * One account's connection to the provider under test, through the official MCP client, and the record of every
 * answer it reads: each answer is checked against the rules that hold for all of them (FEAT-CORE-006, 007, 013, 017,
 * 019 and the members of items and events), by the observer.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { Observer } from './observer.js'
import type { ConformanceAccount } from './types.js'

export type Json = Record<string, unknown>

export type Outcome =
  | { ok: true; content: Json; raw: Json }
  | { ok: false; error: { code: string; message: string; field?: string; [k: string]: unknown }; raw: Json }

export const MODERN = '2026-07-28'
export const LEGACY = '2025-11-25'

/** A thrown answer: the call did not complete as a tool result (a protocol error, a transport error). */
export class CallFailed extends Error {}

export class Session {
  private client?: Client
  public era: 'modern' | 'legacy' = 'modern'
  /** the elicitations the service asked during the run, and how this session answers the next */
  public readonly asked: string[] = []
  public answer: 'accept' | 'decline' = 'decline'

  public constructor(
    public readonly name: string,
    public readonly account: ConformanceAccount,
    private readonly url: string,
    private readonly mode: 'modern' | 'legacy' | 'auto',
    private readonly observer: Observer,
    private readonly fetchFn?: typeof fetch
  ) {}

  public async connect(): Promise<void> {
    const client = new Client(
      { name: 'ayni-conformance', version: '0.1.0' },
      {
        capabilities: { elicitation: { form: {} } },
        // every answer reaches the observer as it is: the kit checks results against the profile itself
        jsonSchemaValidator: {
          getValidator: () => (input: unknown) => ({ valid: true, data: input as never, errorMessage: undefined }),
        },
        ...(this.mode === 'legacy'
          ? {}
          : { versionNegotiation: this.mode === 'modern' ? { mode: { pin: MODERN } } : { mode: 'auto' } }),
      }
    )
    client.setRequestHandler('elicitation/create', async (request) => {
      this.asked.push(String((request.params as { message?: unknown }).message ?? ''))
      return this.answer === 'accept' ? { action: 'accept', content: { confirm: true } } : { action: 'decline' }
    })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(this.url), {
        requestInit: { headers: this.account.headers },
        ...(this.fetchFn ? { fetch: this.fetchFn } : {}),
      })
    )
    this.era = client.getProtocolEra() === 'legacy' ? 'legacy' : 'modern'
    this.client = client
  }

  private get c(): Client {
    if (!this.client) throw new Error(`session ${this.name} is not connected`)
    return this.client
  }

  /** The extensions the server declares to this account, read again now. */
  public async extensions(): Promise<Record<string, unknown>> {
    if (this.era === 'modern') {
      const d = await this.c.discover()
      return ((d.capabilities as Json | undefined)?.extensions as Record<string, unknown> | undefined) ?? {}
    }
    return (await this.initializeRaw()).extensions
  }

  /** A bare 2025-era `initialize`, as a client of an earlier revision sends it: what it declares there (common §3). */
  public async initializeRaw(): Promise<{ extensions: Record<string, unknown>; raw: string }> {
    const f = this.fetchFn ?? fetch
    const res = await f(this.url, {
      method: 'POST',
      headers: {
        ...this.account.headers,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LEGACY,
          capabilities: {},
          clientInfo: { name: 'ayni-conformance', version: '0.1.0' },
        },
      }),
    })
    const text = await res.text()
    const json = text.trimStart().startsWith('{')
      ? (JSON.parse(text) as Json)
      : (JSON.parse(
          text
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .join('')
        ) as Json)
    const result = json.result as Json | undefined
    const extensions = ((result?.capabilities as Json | undefined)?.extensions as Record<string, unknown>) ?? {}
    return { extensions, raw: text }
  }

  public async listTools(): Promise<Json[]> {
    const { tools } = await this.c.listTools()
    return tools as unknown as Json[]
  }

  /** Calls a tool; the answer is recorded and checked, a protocol error is thrown as `CallFailed`. */
  public async call(name: string, args: Json): Promise<Outcome> {
    let raw: Json
    try {
      raw = (await this.c.callTool({ name, arguments: args })) as unknown as Json
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.observer.thrown(this.name, name, message)
      throw new CallFailed(`${name} did not answer a tool result: ${message}`)
    }
    const outcome = this.observer.answer(this.name, name, args, raw)
    return outcome
  }

  public async close(): Promise<void> {
    await this.client?.close().catch(() => undefined)
  }
}
