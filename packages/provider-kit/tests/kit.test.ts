/**
 * The kit with a small provider of its own: what a client of each era reads (the Ayni Agent connects today with the
 * v1 SDK's `initialize`), the checks of calls and results, errors, cursors and accounts.
 */
import { FILES_PROFILE, type Item } from '@ayni.org/ayni-feature-profiles'
import {
  type Account,
  bearerAccount,
  CursorCodec,
  createProviderHandler,
  errors,
  type FilesProvider,
  headerAccount,
  pageByKey,
  type RunningProvider,
  routes,
  serve,
  truncateUtf8,
} from '@ayni.org/ayni-provider-kit'
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const TOKEN = 'kit-test-token-0123456789'
const ROOT = 'root-1'

const folder: Item = { ref: ROOT, root: ROOT, kind: 'folder', name: 'Root', path: '/' }
const files: Item[] = Array.from({ length: 7 }, (_, i) => ({
  ref: `f${i}`,
  root: ROOT,
  kind: 'file',
  name: `n${i}.txt`,
  path: `/n${i}.txt`,
  parent: ROOT,
  mediaType: 'text/plain',
  version: 'v1',
}))

/** A provider of the core of Files, with handlers that misbehave on purpose for some names. */
function stub(): FilesProvider<{ token: string }> {
  return {
    declaration: { capabilities: [], limits: { page: 20 } },
    roots: () => ({ roots: [{ ref: ROOT, title: 'Root', path: '/', writable: true, portable: true }] }),
    list: (_args, ctx) => {
      const page = pageByKey(files, (f) => f.ref, ctx.page)
      return { folder, items: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }
    },
    get: (args) => {
      if (args.ref === 'foreign') return { item: { ...folder, root: 'another-root' } }
      if (args.ref === 'crash') throw new Error(`the service said no to ${TOKEN}`)
      if (args.ref === 'leak') throw errors.notFound(`No item for ${TOKEN}.`)
      const f = files.find((x) => x.ref === args.ref) ?? (args.ref === ROOT ? folder : undefined)
      if (!f) throw errors.notFound()
      return { item: f }
    },
    read: () => ({ item: files[0] as Item, content: { kind: 'text', text: 'é'.repeat(10), mediaType: 'text/plain' } }),
    create: () => {
      throw errors.permissionDenied()
    },
    replace: () => {
      throw errors.permissionDenied()
    },
  }
}

describe('the kit served over HTTP', () => {
  let running: RunningProvider
  beforeAll(async () => {
    const reader = bearerAccount()
    running = await serve(
      createProviderHandler<{ token: string }>({
        name: 'kit-test',
        version: '0.0.0',
        readAccount: async (request) => {
          const a = await reader(request)
          return a && a.data.token === TOKEN ? a : undefined
        },
        files: () => stub(),
      })
    )
  })
  afterAll(async () => running.close())

  const connect = async (token?: string) => {
    const client = new LegacyClient({ name: 'like-the-agent', version: '1.0.0' })
    await client.connect(
      new LegacyTransport(new URL(running.url), {
        requestInit: { headers: token ? { authorization: `Bearer ${token}` } : {} },
      })
    )
    return client
  }

  it('declares the profile in initialize and lists the core, as a v1 client reads them', async () => {
    const client = await connect(TOKEN)
    const extensions = client.getServerCapabilities()?.extensions as Record<string, unknown>
    expect(extensions['org.ayni/files']).toEqual({ version: '1.0', capabilities: [], limits: { page: 20 } })
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(FILES_PROFILE.tools.filter((t) => !t.capability).map((t) => t.name))
    const get = tools.find((t) => t.name === 'files_get')
    expect(get?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
    expect(get?.description).toBe(FILES_PROFILE.tools.find((t) => t.name === 'files_get')?.description)
    await client.close()
  })

  it('answers results in both forms, and pages with cursors of its own bound to the call', async () => {
    const client = await connect(TOKEN)
    const first = (await client.callTool({ name: 'files_list', arguments: { root: ROOT, limit: 3 } })) as unknown as {
      structuredContent: { items: Item[]; nextCursor: string }
      content: { text: string }[]
    }
    expect(JSON.parse(first.content[0]?.text ?? '')).toEqual(first.structuredContent)
    expect(first.structuredContent.items.map((i) => i.ref)).toEqual(['f0', 'f1', 'f2'])
    const cursor = first.structuredContent.nextCursor
    expect(cursor).not.toBe('f2')
    const second = (await client.callTool({
      name: 'files_list',
      arguments: { root: ROOT, limit: 3, cursor },
    })) as unknown as {
      structuredContent: { items: Item[] }
    }
    expect(second.structuredContent.items.map((i) => i.ref)).toEqual(['f3', 'f4', 'f5'])
    const other = await client.callTool({ name: 'files_list', arguments: { root: ROOT, folder: ROOT, cursor } })
    expect(other.structuredContent).toMatchObject({ error: { code: 'bad-cursor' } })
    const big = (await client.callTool({ name: 'files_list', arguments: { root: ROOT, limit: 50 } })) as unknown as {
      structuredContent: { items: Item[]; nextCursor?: string }
    }
    expect(big.structuredContent.items.length).toBe(7)
    await client.close()
  })

  it('refuses before a handler runs, and maps what a handler throws', async () => {
    const client = await connect(TOKEN)
    const call = async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as unknown as {
        isError?: boolean
        structuredContent: { error: Record<string, unknown> }
      }
    expect((await call('files_list', { root: ROOT, colour: 'red' })).structuredContent.error).toMatchObject({
      code: 'invalid-argument',
      field: 'colour',
    })
    expect((await call('files_list', { root: ROOT, limit: 101 })).structuredContent.error).toMatchObject({
      code: 'invalid-argument',
      field: 'limit',
    })
    expect((await call('files_read', { root: ROOT, ref: 'f0', version: 'v1' })).structuredContent.error).toMatchObject({
      code: 'not-supported',
      field: 'version',
    })
    const foreign = await call('files_get', { root: ROOT, ref: 'foreign' })
    expect(foreign.isError).toBe(true)
    expect(foreign.structuredContent.error.code).toBe('unavailable')
    const crash = await call('files_get', { root: ROOT, ref: 'crash' })
    expect(crash.structuredContent.error.code).toBe('unavailable')
    expect(JSON.stringify(crash)).not.toContain(TOKEN)
    const leak = await call('files_get', { root: ROOT, ref: 'leak' })
    expect(leak.structuredContent.error.code).toBe('not-found')
    expect(JSON.stringify(leak)).not.toContain(TOKEN)
    const big = await call('files_create', {
      root: ROOT,
      name: 'x.bin',
      content: { base64: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64') },
    })
    expect(big.structuredContent.error).toMatchObject({ code: 'too-large', limitBytes: 10 * 1024 * 1024 })
    const read = (await client.callTool({
      name: 'files_read',
      arguments: { root: ROOT, ref: 'f0', maxBytes: 5 },
    })) as unknown as {
      structuredContent: { content: { text: string }; truncated?: boolean }
    }
    expect(read.structuredContent.content.text).toBe('éé')
    expect(read.structuredContent.truncated).toBe(true)
    await expect(client.callTool({ name: 'files_nothing', arguments: {} })).rejects.toThrow()
    await client.close()
  })

  it('answers account-refused to a call with no account the service accepts', async () => {
    const client = await connect('someone-else-0123456789')
    const out = (await client.callTool({ name: 'files_list', arguments: { root: ROOT } })) as unknown as {
      structuredContent: { error: { code: string } }
    }
    expect(out.structuredContent.error.code).toBe('account-refused')
    await client.close()
  })
})

describe('cursors', () => {
  it('opens only for the binding it was sealed for, until it expires', () => {
    let now = 1_000_000
    const codec = new CursorCodec('secret of the test', 600, () => now)
    const c = codec.seal('binding-a', 'offset-3')
    expect(codec.open('binding-a', c)).toBe('offset-3')
    expect(() => codec.open('binding-b', c)).toThrow(/other arguments/)
    expect(() => codec.open('binding-a', `${c.slice(0, -2)}AA`)).toThrow()
    expect(() => new CursorCodec('other secret').open('binding-a', c)).toThrow()
    now += 601_000
    expect(() => codec.open('binding-a', c)).toThrow(/expired/)
    expect(() => new CursorCodec('s', 60)).toThrow(/ten minutes/)
  })

  it('pages by key: an item added before the cursor is not answered twice', () => {
    const items = ['b', 'd', 'f', 'h'].map((k) => ({ k }))
    const first = pageByKey(items, (i) => i.k, { limit: 2 })
    items.push({ k: 'a' })
    const second = pageByKey(items, (i) => i.k, { limit: 2, ...(first.nextCursor ? { cursor: first.nextCursor } : {}) })
    expect([...first.items, ...second.items].map((i) => i.k)).toEqual(['b', 'd', 'f', 'h'])
    expect(second.nextCursor).toBeUndefined()
  })
})

describe('accounts and contents', () => {
  it('reads a bearer token and named headers, keeping the secrets apart', async () => {
    const bearer = await bearerAccount()(
      new Request('http://x.invalid/', { headers: { authorization: 'Bearer abc.def' } })
    )
    expect(bearer?.data.token).toBe('abc.def')
    expect(bearer?.secrets).toEqual(['abc.def'])
    const reader = headerAccount(['Ayni-Dav-Files', 'Ayni-Dav-Username', 'Ayni-Dav-Password'], ['Ayni-Dav-Password'])
    const headers = {
      'ayni-dav-files': 'https://dav.example.org/files/',
      'ayni-dav-username': 'avery',
      'ayni-dav-password': 'app-password-1',
    }
    const a = (await reader(new Request('http://x.invalid/', { headers }))) as Account<Record<string, string>>
    expect(a.data['ayni-dav-username']).toBe('avery')
    expect(a.secrets).toEqual(['app-password-1'])
    expect(a.id).not.toContain('app-password-1')
    expect(await reader(new Request('http://x.invalid/'))).toBeUndefined()
  })

  it('cuts a text at a character', () => {
    expect(truncateUtf8('aé€', 4)).toEqual({ text: 'aé', truncated: true })
    expect(truncateUtf8('aé€', 6)).toEqual({ text: 'aé€', truncated: false })
  })

  it('serves the metadata of a protected resource and names it to a request without a token', async () => {
    const handler = createProviderHandler({ name: 'x', version: '0', readAccount: bearerAccount() })
    const fetch = routes(handler, {
      protectedResource: {
        resource: 'https://files.example.org/mcp',
        authorization_servers: ['https://accounts.example.org'],
      },
    })
    const unauthorized = await fetch(new Request('https://files.example.org/mcp', { method: 'POST' }))
    expect(unauthorized.status).toBe(401)
    expect(unauthorized.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource/mcp')
    const metadata = await fetch(new Request('https://files.example.org/.well-known/oauth-protected-resource/mcp'))
    expect(await metadata.json()).toMatchObject({ authorization_servers: ['https://accounts.example.org'] })
    expect((await fetch(new Request('https://files.example.org/healthz'))).status).toBe(200)
  })
})
