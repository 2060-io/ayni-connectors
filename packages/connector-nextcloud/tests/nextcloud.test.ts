/**
 * A Nextcloud's own interfaces (providers §5): what is declared from what the server says (FEAT-NC-001), file ids as
 * references found under the root (002), portable roots (003), names searched (004), the trash bin (005), shares
 * (006), busy times and scheduling (007), and team folders for the managing account (§5.1, FEAT-NC-008 to 011).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { teamGroups } from '../src/shares.js'
import { connect, type Json, type TestClient } from './client.js'
import { headersOf, type Started, startRun } from './setup.js'
import type { StubOptions } from './stub/index.js'

const filesDeclared = async (s: Started, id = 'ana', more: Record<string, string> = {}) => {
  const c = await connect(s.connector.url, { ...headersOf(s, id), ...more })
  const d = (await c.declared())['org.ayni/files'] as Json & { capabilities: string[] }
  const tools = await c.tools()
  await c.close()
  return { d, tools }
}

describe('FEAT-NC-001: declared from what the server says, found from its address alone', () => {
  it('declares no trash with the trash bin off, no share with sharing off, no anyone without public links', async () => {
    const cases: [StubOptions, string[], (d: Json) => void][] = [
      [{ trashbin: false }, ['search', 'folders', 'share', 'versions'], () => undefined],
      [{ sharing: false }, ['search', 'folders', 'trash', 'versions'], (d) => expect(d.share).toBeUndefined()],
      [{ versions: false }, ['search', 'folders', 'trash', 'share'], () => undefined],
      [
        { publicLinks: false },
        ['search', 'folders', 'trash', 'share', 'versions'],
        (d) => expect(d.share).toEqual({ audiences: [], notify: true }),
      ],
    ]
    for (const [opts, caps, more] of cases) {
      const s = await startRun(opts)
      const { d, tools } = await filesDeclared(s)
      expect(d.capabilities).toEqual(caps)
      more(d)
      if (!caps.includes('trash')) expect(tools).not.toContain('files_trash')
      if (!caps.includes('share'))
        for (const t of ['files_share', 'files_shares', 'files_unshare']) expect(tools).not.toContain(t)
      await s.close()
    }
  })

  it('declares the whole to an ordinary account: search with content false, share without organization', async () => {
    const s = await startRun()
    const { d } = await filesDeclared(s)
    expect(d).toEqual({
      version: '1.0',
      capabilities: ['search', 'folders', 'trash', 'share', 'versions'],
      atomicWrites: true,
      search: { content: false },
      share: { audiences: ['anyone'], notify: true },
    })
    await s.close()
  })

  it('signed in by an email address, reaches the folder of the account’s user id', async () => {
    const s = await startRun()
    s.stub.folder('ana', ['By email'])
    const c = await connect(s.connector.url, { ...headersOf(s, 'ana'), 'Ayni-Dav-Username': 'ana@example.org' })
    const found = (await c.ok('files_roots', { query: '/By' })).roots as Json[]
    expect(found.map((r) => r.path)).toEqual(['/By email'])
    expect(s.stub.requests.some((r) => r.path.startsWith('/remote.php/dav/files/ana/'))).toBe(true)
    await c.close()
    await s.close()
  })
})

describe('a Nextcloud: references, roots, search, trash, versions, shares', () => {
  let s: Started
  let a: TestClient
  let b: TestClient
  let root: string
  beforeAll(async () => {
    s = await startRun()
    root = String(s.stub.folder('ana', ['Work']))
    s.stub.folder('ana', ['Work', 'A'])
    s.stub.folder('ana', ['Work', 'B'])
    s.stub.folder('ana', ['Elsewhere'])
    a = await connect(s.connector.url, headersOf(s, 'ana'))
    b = await connect(s.connector.url, headersOf(s, 'jonas'))
  })
  afterAll(async () => {
    await a.close()
    await b.close()
    await s.close()
  })

  it('FEAT-NC-002: a file renamed and moved inside the root keeps its reference; one of another folder is not found', async () => {
    const f = (await a.ok('files_create', { root, name: 'plan.md', content: { text: '# plan' } })).item as Json
    expect(f.ref).toMatch(/^\d+$/)
    const sub = (await a.ok('files_list', { root })).items as Json[]
    const folderA = sub.find((x) => x.name === 'A') as Json
    const moved = (await a.ok('files_move', { root, ref: f.ref, toFolder: folderA.ref, newName: 'plan-2.md' }))
      .item as Json
    expect(moved.ref).toBe(f.ref)
    expect((await a.ok('files_read', { root, ref: f.ref })).item).toMatchObject({
      path: '/A/plan-2.md',
      parent: folderA.ref,
    })
    const other = s.stub.file('ana', ['Elsewhere', 'not-here.md'], 'x')
    const e1 = await a.err('files_get', { root, ref: String(other) })
    const e2 = await a.err('files_get', { root, ref: '999999' })
    expect([e1.code, e2.code]).toEqual(['not-found', 'not-found'])
    expect(e1.message).toBe(e2.message)
    expect(JSON.stringify(e1)).not.toContain('not-here')
    expect((await a.ok('files_get', { root, ref: root })).item).toMatchObject({ path: '/', kind: 'folder' })
  })

  it('FEAT-NC-003: a folder A shares with B, which B moved and renamed, lists the same files to both; others see nothing', async () => {
    const shared = String(s.stub.folder('ana', ['To Jonas']))
    s.stub.file('ana', ['To Jonas', 'agenda.md'], 'agenda')
    await a.ok('files_share', {
      root: shared,
      ref: shared,
      role: 'reader',
      recipients: [{ address: 'jonas@example.org' }],
      notify: false,
    })
    // Jonas moves the share into a folder of his own, under another name, as Nextcloud lets him
    s.stub.folder('jonas', ['From colleagues'])
    const share = s.stub.store.shares.find((x) => x.shareWith === 'jonas' && String(x.node.id) === shared)
    if (share) share.target = ['From colleagues', 'Agenda of Ana']
    const ofA = ((await a.ok('files_list', { root: shared })).items as Json[]).map((x) => [x.ref, x.name])
    const ofB = ((await b.ok('files_list', { root: shared })).items as Json[]).map((x) => [x.ref, x.name])
    expect(ofB).toEqual(ofA)
    const rootOfB = (await b.ok('files_roots', { query: '/From colleagues/Ag' })).roots as Json[]
    expect(rootOfB.map((r) => [r.ref, r.path, r.portable])).toEqual([[shared, '/From colleagues/Agenda of Ana', true]])
    const m = await connect(s.connector.url, headersOf(s, 'ayni-manager'))
    expect((await m.err('files_list', { root: shared })).code).toBe('not-found')
    await m.close()
  })

  it('FEAT-NC-004: a word of a name finds it under the root and not under another folder; in content refused', async () => {
    s.stub.file('ana', ['Work', 'B', 'invoice march.pdf'], 'x')
    s.stub.file('ana', ['Elsewhere', 'invoice april.pdf'], 'x')
    const found = (await a.ok('files_search', { root, query: 'invoice' })).items as Json[]
    expect(found.map((x) => x.path)).toEqual(['/B/invoice march.pdf'])
    // the store's own wildcards are no operators: a % finds names that hold a %
    expect((await a.ok('files_search', { root, query: '%' })).items).toEqual([])
    expect((await a.err('files_search', { root, query: 'invoice', in: 'content' })).code).toBe('not-supported')
  })

  it('FEAT-NC-005: the trash of the root holds what was trashed under it alone; a restore checks the folder first', async () => {
    const f = (await a.ok('files_create', { root, name: 'old.txt', content: { text: 'old' } })).item as Json
    const outside = String(s.stub.file('ana', ['Elsewhere', 'old elsewhere.txt'], 'x'))
    const elsewhere = String(s.stub.folder('ana', ['Elsewhere']))
    const t = (await a.ok('files_trash', { root, ref: f.ref })).item as Json
    expect(t.trashedAt).toMatch(/Z$/)
    await a.ok('files_trash', { root: elsewhere, ref: outside })
    const listed = (await a.ok('files_list_trash', { root })).items as Json[]
    expect(listed.map((x) => x.name)).toEqual(['old.txt'])
    expect(listed[0]).toMatchObject({ ref: f.ref, path: '/old.txt', parent: root })
    // a new file of its name: Nextcloud would restore under another name; the profile answers already-exists
    await a.ok('files_create', { root, name: 'old.txt', content: { text: 'new' } })
    expect((await a.err('files_restore', { root, ref: f.ref })).code).toBe('already-exists')
    const g = (await a.ok('files_create', { root, name: 'gone.txt', content: { text: 'g' } })).item as Json
    const sub = (await a.ok('files_create_folder', { root, name: 'Gone' })).item as Json
    const h = (await a.ok('files_move', { root, ref: g.ref, toFolder: sub.ref })).item as Json
    await a.ok('files_trash', { root, ref: h.ref })
    await a.ok('files_trash', { root, ref: sub.ref })
    // the folder it left is gone: Nextcloud would restore into the account's own folder; the profile answers not-found
    expect((await a.err('files_restore', { root, ref: h.ref })).code).toBe('not-found')
    expect((await a.ok('files_restore', { root, ref: sub.ref })).item).toMatchObject({ path: '/Gone' })
    expect((await a.ok('files_restore', { root, ref: h.ref })).item).toMatchObject({
      path: '/Gone/gone.txt',
      ref: h.ref,
    })
  })

  it('versions: each replace keeps the former content, even two within one second', async () => {
    const f = (await a.ok('files_create', { root, name: 'fast.txt', content: { text: 'v0' } })).item as Json
    let version = f.version as string
    for (let i = 1; i <= 3; i++)
      version = (
        (await a.ok('files_replace', { root, ref: f.ref, ifVersion: version, content: { text: `v${i}` } })).item as Json
      ).version as string
    const listed = (await a.ok('files_versions', { root, ref: f.ref })).versions as Json[]
    expect(listed).toHaveLength(4)
    const texts: string[] = []
    for (const v of listed)
      texts.push(String(((await a.ok('files_read', { root, ref: f.ref, version: v.version })).content as Json).text))
    expect(texts).toEqual(['v3', 'v2', 'v1', 'v0'])
    expect(s.stub.requests.some((r) => r.method === 'PUT')).toBe(true)
    expect((await a.err('files_read', { root, ref: f.ref, version: '123' })).code).toBe('not-found')
  })

  it('FEAT-NC-006: reader is the permission 1, editor 3 for a file and 15 for a folder; anyone a public link', async () => {
    const f = (await a.ok('files_create', { root, name: 'shared.txt', content: { text: 's' } })).item as Json
    const folder = (await a.ok('files_create_folder', { root, name: 'Shared folder' })).item as Json
    await a.ok('files_share', {
      root,
      ref: f.ref,
      role: 'reader',
      recipients: [{ address: 'jonas@example.org' }],
      notify: false,
    })
    await a.ok('files_share', {
      root,
      ref: folder.ref,
      role: 'editor',
      recipients: [{ address: 'jonas@example.org' }],
      notify: false,
    })
    const at = (id: unknown) =>
      s.stub.store.shares.filter((x) => String(x.node.id) === String(id)).map((x) => [x.type, x.permissions])
    expect(at(f.ref)).toEqual([[0, 1]])
    expect(at(folder.ref)).toEqual([[0, 15]])
    // sharing again changes the role of the share, and makes no other
    await a.ok('files_share', {
      root,
      ref: f.ref,
      role: 'editor',
      recipients: [{ address: 'jonas@example.org' }],
      notify: false,
    })
    expect(at(f.ref)).toEqual([[0, 3]])
    // an address of nobody of the server: a share by email, with the server's mail and its note
    const g = (await a.ok('files_create', { root, name: 'outside.txt', content: { text: 'o' } })).item as Json
    const made = (
      await a.ok('files_share', {
        root,
        ref: g.ref,
        role: 'reader',
        recipients: [{ address: 'piet@partner.example' }],
        message: 'Q3',
      })
    ).shares as Json[]
    expect(made[0]).toMatchObject({ role: 'reader', recipient: { address: 'piet@partner.example' }, inherited: false })
    expect(s.stub.messagesTo('piet@partner.example').some((m) => m.text.includes('Q3'))).toBe(true)
    const link = (await a.ok('files_share', { root, ref: g.ref, role: 'reader', audience: 'anyone' })).shares as Json[]
    expect(link[0]).toMatchObject({ audience: 'anyone', role: 'reader' })
    expect(String(link[0]?.link)).toMatch(/^https:\/\//)
    expect(at(g.ref).sort()).toEqual([
      [3, 1],
      [4, 1],
    ])
    expect(s.stub.store.shares.every((x) => !(x.permissions & 16))).toBe(true)
    expect((await a.err('files_share', { root, ref: g.ref, role: 'reader', audience: 'organization' })).code).toBe(
      'not-supported'
    )
  })

  it('FEAT-NC-006: an address of nobody where the server shares by email with nobody is not-supported', async () => {
    const s2 = await startRun({ shareByMail: false })
    const r2 = String(s2.stub.folder('ana', ['Work']))
    const c = await connect(s2.connector.url, headersOf(s2, 'ana'))
    const f = (await c.ok('files_create', { root: r2, name: 'x.txt', content: { text: 'x' } })).item as Json
    const e = await c.err('files_share', {
      root: r2,
      ref: f.ref,
      role: 'reader',
      recipients: [{ address: 'piet@partner.example' }],
    })
    expect([e.code, e.field]).toEqual(['not-supported', 'recipients'])
    expect(s2.stub.store.shares).toHaveLength(0)
    await c.close()
    await s2.close()
  })

  it('FEAT-NC-007: free-busy with people of the same server; attendees and respond only with scheduling', async () => {
    const d = (await a.declared())['org.ayni/calendar'] as Json
    expect(d.capabilities).toEqual(['free-busy', 'recurrence', 'attendees', 'respond'])
    const s2 = await startRun({ scheduling: false })
    const c = await connect(s2.connector.url, headersOf(s2, 'ana'))
    expect(((await c.declared())['org.ayni/calendar'] as Json).capabilities).toEqual(['free-busy', 'recurrence'])
    await c.close()
    await s2.close()
  })
})

describe('§5.1 team folders, for the managing account', () => {
  let s: Started
  let a: TestClient
  let b: TestClient
  let m: TestClient
  beforeAll(async () => {
    s = await startRun()
    a = await connect(s.connector.url, headersOf(s, 'ana'))
    b = await connect(s.connector.url, headersOf(s, 'jonas'))
    m = await connect(s.connector.url, headersOf(s, 'ayni-manager'))
  })
  afterAll(async () => {
    for (const c of [a, b, m]) await c.close()
    await s.close()
  })

  it('FEAT-NC-008: team-roots with manager false and share, to the administrator and a delegated account alone', async () => {
    const dm = (await m.declared())['org.ayni/files'] as Json & { capabilities: string[] }
    expect(dm.capabilities).toEqual(['search', 'folders', 'trash', 'share', 'versions', 'team-roots'])
    expect(dm['team-roots']).toEqual({ manager: false })
    const da = (await a.declared())['org.ayni/files'] as Json & { capabilities: string[] }
    expect(da.capabilities).not.toContain('team-roots')
    // an account given the administration of team folders, and of users and groups, by delegation
    s.stub.store.teamAdminGroups.add('team-folder-admins')
    s.stub.store.userAdminGroups.add('team-folder-admins')
    s.stub.store.groups.add('team-folder-admins')
    s.stub.store.users.get('jonas')?.groups.add('team-folder-admins')
    expect(((await b.declared())['org.ayni/files'] as Json & { capabilities: string[] }).capabilities).toContain(
      'team-roots'
    )
    // delegated team folders without the right to make groups: not declared
    s.stub.store.userAdminGroups.delete('team-folder-admins')
    expect(((await b.declared())['org.ayni/files'] as Json & { capabilities: string[] }).capabilities).not.toContain(
      'team-roots'
    )
    s.stub.store.users.get('jonas')?.groups.delete('team-folder-admins')
    const off = await startRun({ groupfolders: false })
    const c = await connect(off.connector.url, headersOf(off, 'ayni-manager'))
    expect(((await c.declared())['org.ayni/files'] as Json & { capabilities: string[] }).capabilities).not.toContain(
      'team-roots'
    )
    await c.close()
    await off.close()
  })

  it('FEAT-NC-009: one team folder and its two groups, 1 and 15, never 16; the same request makes nothing more', async () => {
    const made = (await m.ok('files_create_team_root', { name: 'Project Alpha', requestId: 'space-1-files' }))
      .root as Json
    expect(made).toMatchObject({ title: 'Project Alpha', team: true, portable: true, path: '/Project Alpha' })
    const again = (await m.ok('files_create_team_root', { name: 'Project Alpha', requestId: 'space-1-files' }))
      .root as Json
    expect(again.ref).toBe(made.ref)
    const folders = s.stub.store.folders.filter((f) => f.mountPoint === 'Project Alpha')
    expect(folders).toHaveLength(1)
    expect(Object.fromEntries(folders[0]?.groups ?? [])).toEqual({
      'ayni-space-1-files-editors': 15,
      'ayni-space-1-files-readers': 1,
    })
    expect(String(made.ref)).toBe(String(folders[0]?.root.id))
    // two team folders of one name: Nextcloud keeps one mount point per folder
    expect((await m.err('files_create_team_root', { name: 'Project Alpha', requestId: 'space-2-files' })).code).toBe(
      'already-exists'
    )
    expect(teamGroups('x'.repeat(100)).editors.length).toBeLessThanOrEqual(64)
  })

  it('FEAT-NC-010: a member by the one user of the address, in one group at a time; out of both when unshared', async () => {
    const root = String(((await m.ok('files_roots', { query: '/Project' })).roots as Json[])[0]?.ref)
    const groups = () => [...(s.stub.store.users.get('ana')?.groups ?? [])].filter((g) => g.startsWith('ayni-'))
    const shared = (
      await m.ok('files_share', { root, ref: root, role: 'editor', recipients: [{ address: 'ana@example.org' }] })
    ).shares as Json[]
    expect(shared).toEqual([
      {
        id: 'member:ana',
        role: 'editor',
        recipient: { address: 'ana@example.org', name: 'Ana Example' },
        inherited: false,
      },
    ])
    expect(groups()).toEqual(['ayni-space-1-files-editors'])
    await m.ok('files_share', { root, ref: root, role: 'reader', recipients: [{ address: 'ana@example.org' }] })
    expect(groups()).toEqual(['ayni-space-1-files-readers'])
    const e = await m.err('files_share', {
      root,
      ref: root,
      role: 'reader',
      recipients: [{ address: 'nobody@example.org' }],
    })
    expect([e.code, e.reason]).toEqual(['recipient-refused', 'no-account'])
    const members = (await m.ok('files_shares', { root, ref: root })).shares as Json[]
    expect(members.map((x) => x.id)).toEqual(['member:ana'])
    expect((await a.ok('files_get', { root, ref: root })).item).toMatchObject({ name: 'Project Alpha' })
    await m.ok('files_unshare', { root, ref: root, share: 'member:ana' })
    expect(groups()).toEqual([])
    expect((await a.err('files_get', { root, ref: root })).code).toBe('not-found')
    expect((await m.err('files_unshare', { root, ref: root, share: 'member:ana' })).code).toBe('not-found')
    expect((await m.err('files_share', { root, ref: root, role: 'reader', audience: 'anyone' })).code).toBe(
      'not-supported'
    )
  })

  it('FEAT-NC-011: one reference for every member and the managing account, kept by a rename of the mount point', async () => {
    const root = String(((await m.ok('files_roots', { query: '/Project' })).roots as Json[])[0]?.ref)
    await m.ok('files_share', { root, ref: root, role: 'editor', recipients: [{ address: 'ana@example.org' }] })
    await m.ok('files_share', { root, ref: root, role: 'reader', recipients: [{ address: 'jonas@example.org' }] })
    const seen = async (c: TestClient) => ((await c.ok('files_roots', {})).roots as Json[]).find((r) => r.ref === root)
    expect((await seen(a))?.team).toBe(true)
    expect((await seen(b))?.ref).toBe(root)
    const got = (await m.ok('files_get', { root, ref: root })).item as Json
    expect(got).toMatchObject({ name: 'Project Alpha', kind: 'folder' })
    expect(String(got.webUrl)).toBe(`${s.stub.origin()}/index.php/f/${root}`)
    const renamed = (await m.ok('files_rename_root', { root, name: 'Alpha' })).root as Json
    expect([renamed.ref, renamed.title]).toEqual([root, 'Alpha'])
    expect((await seen(a))?.title).toBe('Alpha')
    expect(await a.tools()).not.toContain('files_rename_root')
    const own = ((await m.ok('files_roots', {})).roots as Json[]).find((r) => r.path === '/') as Json
    expect((await m.err('files_rename_root', { root: own.ref, name: 'x' })).code).toBe('not-supported')
  })
})
