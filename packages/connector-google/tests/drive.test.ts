/**
 * Files over the stub of Drive, beyond what the conformance kit reaches: the scope each tool needs (the agent's table,
 * architecture §10.10), Google's limits and refusals as the profile's errors, the documents of Google's own, the
 * shared drives' members, and what the connector reads of a large file.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connect, rawCall, type TestClient } from './client.js'
import { type Started, startRun } from './setup.js'
import { SCOPE } from './stub/index.js'

let s: Started
let a: TestClient
let first: string

beforeAll(async () => {
  s = await startRun()
  first = s.stub.drive.seedFolder(s.stub.drive.myDriveOf('avery'), 'Work', 'avery')
  a = await connect(s.connector.url, s.tokens.A)
})
afterAll(async () => {
  await a.close()
  await s.close()
})

describe('scopes', () => {
  it('reads with drive.readonly alone, and a write without drive answers 403 insufficient_scope', async () => {
    const readOnlyToken = s.stub.token('avery', [SCOPE('drive.readonly')])
    const readOnly = await connect(s.connector.url, readOnlyToken)
    const f = s.stub.drive.seedFile(first, 'kiwi notes.txt', 'a kiwi', 'avery')
    await readOnly.ok('files_roots', {})
    await readOnly.ok('files_roots', { query: '/Wo' })
    await readOnly.ok('files_list', { root: first })
    await readOnly.ok('files_get', { root: first, ref: f })
    await readOnly.ok('files_read', { root: first, ref: f })
    await readOnly.ok('files_search', { root: first, query: 'kiwi' })
    const e = await rawCall(s.connector.url, readOnlyToken, 'files_create', {
      root: first,
      name: 'x.txt',
      content: { text: 'x' },
    })
    expect([e.status, e.challenge]).toEqual([
      403,
      expect.stringContaining('scope="https://www.googleapis.com/auth/drive"'),
    ])
    const r = await readOnly.err('files_replace', { root: first, ref: f, ifVersion: 'v', content: { text: 'x' } })
    // compared before Google is asked: a version that is not the file's changes nothing
    expect(r.code).toBe('version-mismatch')
    await readOnly.close()
  })

  it('writes with drive', async () => {
    const write = await connect(s.connector.url, s.stub.token('avery', [SCOPE('drive')]))
    const made = await write.ok('files_create', { root: first, name: 'by-drive.txt', content: { text: 'one' } })
    const item = made.item as { ref: string; version: string }
    await write.ok('files_replace', { root: first, ref: item.ref, ifVersion: item.version, content: { text: 'two' } })
    await write.close()
  })

  it('answers 403 insufficient_scope to a token with no scope of Drive', async () => {
    const out = await rawCall(s.connector.url, s.stub.token('avery', [SCOPE('calendar.events')]), 'files_roots', {})
    expect([out.status, out.challenge]).toEqual([
      403,
      expect.stringContaining('scope="https://www.googleapis.com/auth/drive.readonly"'),
    ])
  })
})

describe('Google’s limits and failures', () => {
  it('answers rate-limited with Google’s Retry-After', async () => {
    s.stub.limitNext(1, 7)
    const e = await a.err('files_list', { root: first })
    expect(e).toMatchObject({ code: 'rate-limited', retryAfterSeconds: 7 })
  })

  it('answers unavailable while Google fails', async () => {
    s.stub.available = false
    try {
      expect((await a.err('files_list', { root: first })).code).toBe('unavailable')
    } finally {
      s.stub.available = true
    }
  })

  it('refuses bytes larger than readBytes before downloading them', async () => {
    const big = s.stub.drive.seedFile(
      first,
      'big.bin',
      Buffer.alloc(10 * 1024 * 1024 + 1, 1),
      'avery',
      'application/octet-stream'
    )
    const before = s.sent.length
    const e = await a.err('files_read', { root: first, ref: big })
    expect(e).toMatchObject({ code: 'too-large', limitBytes: 10 * 1024 * 1024, sizeBytes: 10 * 1024 * 1024 + 1 })
    expect(s.sent.slice(before).some((r) => r.url.includes('alt=media'))).toBe(false)
  })

  it('reads the start of a long text only, and cuts it at a character', async () => {
    const long = s.stub.drive.seedFile(first, 'long.txt', 'é'.repeat(200_000), 'avery')
    const out = await a.ok('files_read', { root: first, ref: long, maxBytes: 1001 })
    const text = String((out.content as { text: string }).text)
    expect(Buffer.byteLength(text, 'utf8')).toBe(1000)
    expect(out.truncated).toBe(true)
  })

  it('refuses an export larger than Google exports, with its limit', async () => {
    const doc = s.stub.drive.seedDocument(first, 'Huge notes', 'x'.repeat(10 * 1024 * 1024 + 10), 'avery')
    const e = await a.err('files_export', { root: first, ref: doc, mediaType: 'text/plain' })
    expect(e).toMatchObject({ code: 'too-large', limitBytes: 10 * 1024 * 1024 })
  })
})

describe('documents of Google’s own', () => {
  it('reads a Google Doc as Markdown, a spreadsheet through files_export only, and converts text into a Doc only', async () => {
    const doc = s.stub.drive.seedDocument(first, 'Plan', '# Plan\n\nOne.', 'avery')
    const sheet = s.stub.drive.seedDocument(
      first,
      'Figures',
      'a,b\n1,2\n',
      'avery',
      'application/vnd.google-apps.spreadsheet'
    )
    const read = await a.ok('files_read', { root: first, ref: doc })
    expect(read.content).toEqual({ kind: 'text', text: '# Plan\n\nOne.', mediaType: 'text/markdown' })
    const item = read.item as { native: boolean; version: string; exportTypes: string[]; mediaType: string }
    expect([item.native, item.mediaType, item.exportTypes[0]]).toEqual([
      true,
      'application/vnd.google-apps.document',
      'text/markdown',
    ])
    expect((await a.err('files_read', { root: first, ref: sheet })).code).toBe('not-supported')
    const csv = await a.ok('files_export', { root: first, ref: sheet, mediaType: 'text/csv' })
    expect(csv.content).toEqual({ kind: 'text', text: 'a,b\n1,2\n', mediaType: 'text/csv' })
    const pdf = await a.ok('files_export', { root: first, ref: doc, mediaType: 'application/pdf' })
    expect((pdf.content as { kind: string }).kind).toBe('bytes')
    const replaced = await a.ok('files_replace', {
      root: first,
      ref: doc,
      ifVersion: item.version,
      content: { text: '# Plan\n\nTwo.' },
    })
    expect((replaced.item as { version: string }).version).not.toBe(item.version)
    expect(((await a.ok('files_read', { root: first, ref: doc })).content as { text: string }).text).toBe(
      '# Plan\n\nTwo.'
    )
    const bytes = await a.err('files_replace', {
      root: first,
      ref: doc,
      ifVersion: (replaced.item as { version: string }).version,
      content: { base64: 'AAEC' },
    })
    expect(bytes.code).toBe('not-supported')
    expect((await a.err('files_versions', { root: first, ref: doc })).code).toBe('not-supported')
  })

  it('writes no type of Google’s own as a content', async () => {
    const e = await a.err('files_create', {
      root: first,
      name: 'sneaky',
      content: { text: 'x' },
      mediaType: 'application/vnd.google-apps.document',
    })
    expect(e).toMatchObject({ code: 'invalid-argument', field: 'mediaType' })
  })
})

describe('shares', () => {
  it('shares with the account’s domain and with anyone with the link', async () => {
    const f = s.stub.drive.seedFile(first, 'open.txt', 'x', 'avery')
    const org = await a.ok('files_share', { root: first, ref: f, role: 'reader', audience: 'organization' })
    expect((org.shares as { audience: string }[])[0]?.audience).toBe('organization')
    const any = await a.ok('files_share', { root: first, ref: f, role: 'reader', audience: 'anyone' })
    const link = (any.shares as { link?: string }[])[0]?.link
    expect(link).toMatch(/^https:\/\//)
    const got = await a.ok('files_get', { root: first, ref: f })
    expect((got.item as { shared?: boolean }).shared).toBe(true)
    const shares = (await a.ok('files_shares', { root: first, ref: f })).shares as { audience?: string }[]
    expect(
      shares
        .map((x) => x.audience)
        .filter(Boolean)
        .sort()
    ).toEqual(['anyone', 'organization'])
  })

  it('answers recipient-refused too-many past the members Google allows on a shared drive', async () => {
    const m = await connect(s.connector.url, s.tokens.M)
    const made = await m.ok('files_create_team_root', { name: 'Big team', requestId: 'big-team' })
    const drive = (made.root as { ref: string }).ref
    const top = s.stub.drive.files.get(drive)
    for (let i = 0; i < 599; i++)
      top?.perms.push({ id: `9${i}`, type: 'user', role: 'reader', email: `p${i}@example.org` })
    const e = await m.err('files_share', {
      root: drive,
      ref: drive,
      role: 'reader',
      recipients: [{ address: 'blake@example.org' }],
    })
    expect(e).toMatchObject({ code: 'recipient-refused', reason: 'too-many' })
    await m.close()
  })

  it('answers the same root to the same request, and already-exists when Google refuses the requestId', async () => {
    const m = await connect(s.connector.url, s.tokens.M)
    const one = await m.ok('files_create_team_root', { name: 'Gamma', requestId: 'gamma-1' })
    const two = await m.ok('files_create_team_root', { name: 'Gamma', requestId: 'gamma-1' })
    expect((two.root as { ref: string }).ref).toBe((one.root as { ref: string }).ref)
    expect(one.root).toMatchObject({ title: 'Gamma', path: '/Gamma', team: true, portable: true, writable: true })
    const e = await m.err('files_create_team_root', { name: 'Gamma renamed', requestId: 'gamma-1' })
    expect(e.code).toBe('already-exists')
    const root = (one.root as { ref: string }).ref
    const got = await m.ok('files_get', { root, ref: root })
    expect(got.item).toMatchObject({ kind: 'folder', path: '/', name: 'Gamma' })
    expect(typeof (got.item as { webUrl?: string }).webUrl).toBe('string')
    // the creator is the drive's first member, as its manager
    const members = (await m.ok('files_shares', { root, ref: root })).shares as {
      role: string
      recipient?: { address: string }
    }[]
    expect(members).toEqual([
      expect.objectContaining({
        role: 'manager',
        recipient: expect.objectContaining({ address: 'morgan@example.org' }),
      }),
    ])
    // unsharing a member that is no longer there answers not-found, which the agent counts as done
    expect((await m.err('files_unshare', { root, ref: root, share: '123' })).code).toBe('not-found')
    await m.close()
  })

  it('answers permission-denied to an account Google lets create no shared drive', async () => {
    const user = s.stub.user('riley')
    user.canCreateDrives = false
    const r = await connect(s.connector.url, s.tokens.R)
    expect((await r.err('files_create_team_root', { name: 'Nope', requestId: 'nope' })).code).toBe('permission-denied')
    await r.close()
  })
})

describe('trash', () => {
  it('gives the time of trashing as the connector trashed it, where Drive gives none for My Drive', async () => {
    const f = s.stub.drive.seedFile(first, 'old.txt', 'x', 'avery')
    const before = Date.now() - 1000
    const out = await a.ok('files_trash', { root: first, ref: f })
    const at = Date.parse(String((out.item as { trashedAt: string }).trashedAt))
    expect(at).toBeGreaterThanOrEqual(before)
    const listed = (await a.ok('files_list_trash', { root: first })).items as { ref: string; trashedAt?: string }[]
    expect(listed.find((x) => x.ref === f)?.trashedAt).toBeTruthy()
  })
})
