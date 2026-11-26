/**
 * An MCP client of the connector for the package's own tests (MCP 2026-07-28, the official client), with one account's
 * token: each call answers the tool's structured content, or its error.
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
  close(): Promise<void>
}

export async function connect(url: string, token: string): Promise<TestClient> {
  const client = new Client(
    { name: 'connector-google-tests', version: '0.0.0' },
    {
      jsonSchemaValidator: {
        getValidator: () => (input: unknown) => ({ valid: true, data: input as never, errorMessage: undefined }),
      },
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    }
  )
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } })
  )
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
    close: () => client.close(),
  }
}

/**
 * One `tools/call` as a bare request of the 2025 era, as the Ayni Agent's client sends it: the HTTP status, the
 * challenge of `WWW-Authenticate`, and the tool's structured content when the answer is a result.
 */
export async function rawCall(
  url: string,
  token: string,
  name: string,
  args: Json
): Promise<{ status: number; challenge: string | null; content?: Json }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  const text = await res.text()
  const data = text
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .join('')
  const message = data ? (JSON.parse(data) as { result?: { structuredContent?: Json } }) : undefined
  return {
    status: res.status,
    challenge: res.headers.get('www-authenticate'),
    ...(message?.result?.structuredContent ? { content: message.result.structuredContent } : {}),
  }
}
