/**
 * An MCP client of the connector for the package's own tests (MCP 2026-07-28, the official client), with one account's
 * headers: each call answers the tool's structured content, or its error; `declared` answers what the server declares
 * to the account, from `server/discover`.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

export type Json = Record<string, unknown>
export type Outcome = { ok: true; content: Json } | { ok: false; error: Json & { code: string } }

export interface TestClient {
  call(name: string, args: Json): Promise<Outcome>
  /** the content of a call that must succeed */
  ok(name: string, args: Json): Promise<Json>
  /** the error of a call that must fail */
  err(name: string, args: Json): Promise<Json & { code: string }>
  /** the extensions of `server/discover`, by profile */
  declared(): Promise<Record<string, Json>>
  tools(): Promise<string[]>
  close(): Promise<void>
}

export async function connect(url: string, headers: Record<string, string>): Promise<TestClient> {
  const client = new Client(
    { name: 'connector-nextcloud-tests', version: '0.0.0' },
    {
      jsonSchemaValidator: {
        getValidator: () => (input: unknown) => ({ valid: true, data: input as never, errorMessage: undefined }),
      },
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    }
  )
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }))
  const call = async (name: string, args: Json): Promise<Outcome> => {
    const raw = (await client.callTool({ name, arguments: args })) as unknown as {
      isError?: boolean
      structuredContent?: Json
    }
    const content = raw.structuredContent ?? {}
    return raw.isError ? { ok: false, error: content.error as Json & { code: string } } : { ok: true, content }
  }
  return {
    call,
    ok: async (name, args) => {
      const out = await call(name, args)
      if (!out.ok) throw new Error(`${name} answered ${out.error.code}: ${String(out.error.message)}`)
      return out.content
    },
    err: async (name, args) => {
      const out = await call(name, args)
      if (out.ok) throw new Error(`${name} succeeded where an error was expected`)
      return out.error
    },
    declared: async () => {
      const d = await client.discover()
      return ((d.capabilities as Json | undefined)?.extensions ?? {}) as Record<string, Json>
    },
    tools: async () => (await client.listTools()).tools.map((t) => t.name),
    close: () => client.close(),
  }
}
