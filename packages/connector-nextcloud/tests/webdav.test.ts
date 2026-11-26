/**
 * Files over a WebDAV server that is not a Nextcloud (providers §3): the methods of the table alone (FEAT-WEBDAV-001),
 * path references checked before any request (002), inside a root part by part and never `Depth: infinity` (003),
 * preconditions on writes and a server without entity tags (004), `search` only with `DASL` (005), roots not portable
 * (006).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connect, type TestClient } from './client.js'
import { headersOf, type Started, startRun } from './setup.js'

const TABLE = new Set(['OPTIONS', 'PROPFIND', 'GET', 'PUT', 'MKCOL', 'MOVE', 'SEARCH'])

/** An account's headers for Files alone: no calendar address, so that every request of a call is of the files. */
const filesOnly = (h: Record<string, string>) => {
  const { 'Ayni-Dav-Calendars': _c, ...rest } = h
  return rest
}

describe('a plain WebDAV server with entity tags', () => {
  let s: Started
  let a: TestClient
  beforeAll(async () => {
    s = await startRun({ nextcloud: false, dasl: true })
    s.stub.folder('ana', ['Projects', 'Alpha'])
    s.stub.folder('ana', ['Projects', 'Alphabet'])
    s.stub.file('ana', ['Projects', 'Alphabet', 'x.md'], 'x')
    s.stub.file('ana', ['Projects', 'Alpha', 'budget notes.md'], 'b')
    s.stub.file('ana', ['Projects', 'Alphabet', 'budget other.md'], 'b')
    a = await connect(s.connector.url, filesOnly(headersOf(s, 'ana')))
  })
  afterAll(async () => {
    await a.close()
    await s.close()
  })

  it('FEAT-WEBDAV-001: works with the methods of the table alone', async () => {
    const root = '/Projects/Alpha'
    const made = (await a.ok('files_create', { root, name: 'w1.txt', content: { text: 'one' } })).item as {
      ref: string
      version: string
    }
    await a.ok('files_replace', { root, ref: made.ref, ifVersion: made.version, content: { text: 'two' } })
    await a.ok('files_read', { root, ref: made.ref })
    const folder = (await a.ok('files_create_folder', { root, name: 'Sub' })).item as { ref: string }
    await a.ok('files_move', { root, ref: made.ref, toFolder: folder.ref, newName: 'w2.txt' })
    await a.ok('files_list', { root })
    await a.ok('files_search', { root, query: 'budget' })
    const used = new Set(s.stub.requests.map((r) => r.method))
    for (const m of used) expect(TABLE.has(m), m).toBe(true)
  })

  it('FEAT-WEBDAV-002: refuses a reference with "..", an empty part or a control character, and sends nothing for it', async () => {
    for (const ref of ['/Reports/../../other', '/Reports//x', '/Reports/./x', '/Reports/a\u0001b']) {
      const before = s.stub.requests.length
      const e = await a.err('files_get', { root: '/', ref })
      expect([e.code, e.field]).toEqual(['invalid-argument', 'ref'])
      // the requests of the declaration of the call, and none that names the reference
      const after = s.stub.requests.slice(before)
      expect(after.filter((r) => r.path !== '/dav/files/ana/').map((r) => `${r.method} ${r.path}`)).toEqual([])
    }
    expect((await a.err('files_list', { root: '/Projects/../..' })).code).toBe('invalid-argument')
  })

  it('FEAT-WEBDAV-003: an item is inside a root part by part, and no PROPFIND has Depth infinity', async () => {
    expect((await a.err('files_get', { root: '/Projects/Alpha', ref: '/Projects/Alphabet/x.md' })).code).toBe(
      'not-found'
    )
    expect((await a.ok('files_get', { root: '/Projects', ref: '/Projects/Alphabet/x.md' })).item).toMatchObject({
      path: '/Alphabet/x.md',
      parent: '/Projects/Alphabet',
    })
    expect(
      s.stub.requests.filter((r) => r.method === 'PROPFIND').every((r) => r.depth === '0' || r.depth === '1')
    ).toBe(true)
  })

  it('FEAT-WEBDAV-004: creates with If-None-Match and replaces with If-Match', async () => {
    const before = s.stub.requests.length
    const made = (await a.ok('files_create', { root: '/', name: 'tags.txt', content: { text: 'a' } })).item as {
      ref: string
      version: string
    }
    await a.ok('files_replace', { root: '/', ref: made.ref, ifVersion: made.version, content: { text: 'b' } })
    const puts = s.stub.requests.slice(before).filter((r) => r.method === 'PUT')
    expect(puts[0]?.ifNoneMatch).toBe('*')
    expect(puts[1]?.ifMatch).toBe(made.version)
    expect((await a.declared())['org.ayni/files']?.atomicWrites).toBe(true)
    const stale = await a.err('files_replace', {
      root: '/',
      ref: made.ref,
      ifVersion: made.version,
      content: { text: 'c' },
    })
    expect(stale.code).toBe('version-mismatch')
  })

  it('FEAT-WEBDAV-005: with DASL, search finds a file by its name under the root only, content: false', async () => {
    const d = (await a.declared())['org.ayni/files'] as { capabilities: string[]; search?: unknown }
    expect(d.capabilities).toContain('search')
    expect(d.search).toEqual({ content: false })
    expect(d.capabilities).not.toEqual(expect.arrayContaining(['trash']))
    for (const c of ['trash', 'share', 'versions', 'export', 'team-roots']) expect(d.capabilities).not.toContain(c)
    const found = (await a.ok('files_search', { root: '/Projects/Alpha', query: 'budget' })).items as { name: string }[]
    expect(found.map((x) => x.name)).toEqual(['budget notes.md'])
    expect((await a.err('files_search', { root: '/Projects/Alpha', query: 'budget', in: 'content' })).code).toBe(
      'not-supported'
    )
  })

  it('FEAT-WEBDAV-006: every root is not portable', async () => {
    const roots = (await a.ok('files_roots', {})).roots as { portable: boolean; path: string }[]
    expect(roots.map((r) => [r.path, r.portable])).toEqual([['/', false]])
    const found = (await a.ok('files_roots', { query: '/Projects/Al' })).roots as { portable: boolean; path: string }[]
    expect(found.map((r) => r.path).sort()).toEqual(['/Projects/Alpha', '/Projects/Alphabet'])
    expect(found.every((r) => r.portable === false)).toBe(true)
  })
})

describe('a plain WebDAV server without entity tags or search', () => {
  let s: Started
  let a: TestClient
  beforeAll(async () => {
    s = await startRun({ nextcloud: false, etags: false })
    a = await connect(s.connector.url, filesOnly(headersOf(s, 'ana')))
  })
  afterAll(async () => {
    await a.close()
    await s.close()
  })

  it('FEAT-WEBDAV-004: declares atomicWrites false, and refuses a replace of a file changed since', async () => {
    expect((await a.declared())['org.ayni/files']?.atomicWrites).toBe(false)
    const made = (await a.ok('files_create', { root: '/', name: 'n.txt', content: { text: 'one' } })).item as {
      ref: string
      version: string
    }
    expect(made.version).toMatch(/^m:\d+:3$/)
    // changed at the server by someone else, a second later
    const node = s.stub.store.resolve('ana', ['n.txt'])?.node
    if (node) {
      node.content = Buffer.from('changed')
      node.mtime += 2000
    }
    const e = await a.err('files_replace', {
      root: '/',
      ref: made.ref,
      ifVersion: made.version,
      content: { text: 'x' },
    })
    expect(e.code).toBe('version-mismatch')
    expect(e.currentVersion).not.toBe(made.version)
    expect(node?.content.toString()).toBe('changed')
    // a create of a name that is there is refused, the server not being trusted to compare
    expect((await a.err('files_create', { root: '/', name: 'n.txt', content: { text: 'again' } })).code).toBe(
      'already-exists'
    )
  })

  it('FEAT-WEBDAV-005: without DASL, files_search is not listed', async () => {
    expect(await a.tools()).not.toContain('files_search')
    expect((await a.declared())['org.ayni/files']?.capabilities).toEqual(['folders'])
  })
})
