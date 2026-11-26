/**
 * The tests of Files 1.0 (files §7): the core (FEAT-FILES-001 to 017) and each capability's group, run with A, B and,
 * for `team-roots`, M (common §13). Everything made in the first location goes to the trash at the end where the server
 * has `trash`; otherwise the runner empties it.
 */
import { FILES_PROFILE, limitsOf } from '@ayni.org/ayni-feature-profiles'
import type { CoreState, Declared, ProfileRun } from './core.js'
import type { RunState, Test, TestContext } from './harness.js'
import type { Json, Session } from './session.js'
import type { FilesConformance } from './types.js'

export interface FilesState extends CoreState {
  files: FilesConformance
  /** everything the run made in the first location, by reference */
  created: Set<string>
  /** the team root M makes for the tests of `team-roots` */
  teamRoot?: string
}

const has = (s: FilesState, c: string) => s.run.declaration.capabilities.includes(c)

function requires(t: TestContext, s: FilesState, ...caps: string[]) {
  for (const c of caps) if (!has(s, c)) t.skip(`needs the capability ${c}, which the server does not declare`)
}

const b64 = (x: string | Buffer) => (typeof x === 'string' ? Buffer.from(x, 'utf8') : x).toString('base64')

async function create(
  t: TestContext,
  s: FilesState,
  name: string,
  content: { text: string } | { base64: string },
  more: Json = {},
  session: Session = s.A,
  root = s.run.first
): Promise<Json> {
  const out = t.success(await session.call('files_create', { root, name, content, ...more }), `files_create ${name}`)
  const item = out.item as Json
  if (root === s.run.first) s.created.add(String(item.ref))
  return item
}

async function folder(
  t: TestContext,
  s: FilesState,
  name: string,
  parent?: string,
  root = s.run.first,
  session = s.A
): Promise<Json> {
  const out = t.success(
    await session.call('files_create_folder', { root, name, ...(parent ? { folder: parent } : {}) }),
    `files_create_folder ${name}`
  )
  const item = out.item as Json
  if (root === s.run.first) s.created.add(String(item.ref))
  return item
}

async function listAll(t: TestContext, session: Session, args: Json): Promise<Json[]> {
  const out: Json[] = []
  let cursor: string | undefined
  do {
    const page = t.success(await session.call('files_list', { ...args, ...(cursor ? { cursor } : {}) }), 'files_list')
    out.push(...((page.items as Json[]) ?? []))
    cursor = page.nextCursor as string | undefined
  } while (cursor && out.length < 10000)
  return out
}

async function readText(
  t: TestContext,
  s: FilesState,
  ref: string,
  more: Json = {},
  session = s.A,
  root = s.run.first
): Promise<Json> {
  return t.success(await session.call('files_read', { root, ref, ...more }), 'files_read')
}

/** The adapter of the common tests for Files. */
export function filesRun(
  state: RunState,
  declaration: Declared,
  files: FilesConformance,
  created: Set<string>
): ProfileRun {
  const names = new Map<string, string>()
  return {
    profile: FILES_PROFILE,
    declaration,
    ...(files.expect ? { expect: files.expect } : {}),
    first: files.first.ref,
    second: files.second.ref,
    unknownRef: `${state.token}-no-such-item`,
    async make(s, name) {
      const out = await s.call('files_create', {
        root: files.first.ref,
        name: `${state.token}-${name}.txt`,
        content: { text: `made by the conformance kit: ${name}` },
      })
      if (!out.ok) throw new Error(`files_create answered ${out.error.code}: ${out.error.message}`)
      const item = out.content.item as Json
      created.add(String(item.ref))
      names.set(String(item.ref), String(item.name))
      return { ref: String(item.ref), version: String(item.version) }
    },
    read: (s, location, ref) => s.call('files_get', { root: location, ref }),
    async change(s, location, ref, ifVersion, n) {
      return s.call('files_replace', { root: location, ref, ifVersion, content: { text: `change ${n}` } })
    },
    async many(n) {
      let parent: string | undefined
      if (declaration.capabilities.includes('folders')) {
        const out = await state.A.call('files_create_folder', {
          root: files.first.ref,
          name: `${state.token}-many-${n}`,
        })
        if (!out.ok) throw new Error(`files_create_folder answered ${out.error.code}`)
        parent = String((out.content.item as Json).ref)
        created.add(parent)
      }
      const refs: string[] = []
      for (let i = 0; i < n; i++) {
        const out = await state.A.call('files_create', {
          root: files.first.ref,
          ...(parent ? { folder: parent } : {}),
          name: `${state.token}-page-${n}-${String(i).padStart(3, '0')}.txt`,
          content: { text: String(i) },
        })
        if (!out.ok) throw new Error(`files_create answered ${out.error.code}`)
        const ref = String((out.content.item as Json).ref)
        refs.push(ref)
        created.add(ref)
      }
      return {
        tool: 'files_list',
        args: { root: files.first.ref, ...(parent ? { folder: parent } : {}) },
        member: 'items',
        refs,
      }
    },
    listCall: (location) => ({ tool: 'files_list', args: { root: location }, member: 'items' }),
    nameOf: (ref) => names.get(ref),
  }
}

export const FILES_TESTS: Test<FilesState>[] = [
  {
    id: 'FEAT-FILES-001',
    capability: null,
    async run(t: TestContext, s) {
      const listed = new Set((await s.A.listTools()).map((x) => String(x.name)))
      for (const n of ['files_roots', 'files_list', 'files_get', 'files_read', 'files_create', 'files_replace'])
        t.ok(listed.has(n), `${n} is not listed`)
      t.success(await s.A.call('files_roots', {}), 'files_roots')
      t.success(await s.A.call('files_list', { root: s.run.first }), 'files_list')
      const item = await create(t, s, `${s.token}-001.md`, { text: '# one' })
      t.success(await s.A.call('files_get', { root: s.run.first, ref: item.ref }), 'files_get')
      t.success(await s.A.call('files_read', { root: s.run.first, ref: item.ref }), 'files_read')
      t.success(
        await s.A.call('files_replace', {
          root: s.run.first,
          ref: item.ref,
          ifVersion: item.version,
          content: { text: '# two' },
        }),
        'files_replace'
      )
    },
  },
  {
    id: 'FEAT-FILES-002',
    capability: null,
    late: true,
    async run(t: TestContext, s) {
      const root = t.success(
        await s.A.call('files_get', { root: s.run.first, ref: s.run.first }),
        'files_get of the root'
      )
      t.equal((root.item as Json).path, '/', "the root's path")
      const tally = s.observer.result(FILES_PROFILE.id, 'FEAT-FILES-002')
      t.ok(tally.violations.length === 0, tally.violations.join(' | '))
      t.note(`${tally.seen} items checked`)
    },
  },
  {
    id: 'FEAT-FILES-003',
    capability: null,
    async run(t: TestContext, s) {
      const top = t.success(await s.A.call('files_roots', {}), 'files_roots')
      t.equal((top.roots as Json[])[0]?.path, '/', 'the path of the first root of the top of the account')
      const path = s.files.first.path
      if (!path) t.skip("the run gives no path of the first location in A's tree")
      requires(t, s, 'folders')
      const projects = await folder(t, s, `${s.token}-Projects`)
      await folder(t, s, 'Alpha', String(projects.ref))
      await folder(t, s, 'Beta', String(projects.ref))
      const base = `${path === '/' ? '' : path}/${s.token}-Projects`
      const found = t.success(await s.A.call('files_roots', { query: `${base}/Al` }), 'files_roots with a query')
      const paths = ((found.roots as Json[]) ?? []).map((r) => String(r.path))
      t.ok(paths.includes(`${base}/Alpha`), `${base}/Al answers no ${base}/Alpha: ${paths.join(', ')}`)
      t.ok(!paths.includes(`${base}/Beta`), `${base}/Al answers ${base}/Beta`)
    },
  },
  {
    id: 'FEAT-FILES-004',
    capability: null,
    async run(t: TestContext, s) {
      requires(t, s, 'folders')
      const f = await folder(t, s, `${s.token}-004`)
      await create(t, s, 'one.txt', { text: '1' }, { folder: f.ref })
      await create(t, s, 'two.txt', { text: '2' }, { folder: f.ref })
      const sub = await folder(t, s, 'sub', String(f.ref))
      await create(t, s, 'three.txt', { text: '3' }, { folder: sub.ref })
      const items = await listAll(t, s.A, { root: s.run.first, folder: f.ref, limit: 1 })
      t.equal(
        items.map((i) => i.name).sort(),
        ['one.txt', 'sub', 'two.txt'],
        'the items of a folder, one level, over pages of one'
      )
    },
  },
  {
    id: 'FEAT-FILES-005',
    capability: null,
    async run(t: TestContext, s) {
      const md = await create(t, s, `${s.token}-notes.md`, { text: '# Notes\n\nÀ bientôt.' })
      const r = await readText(t, s, String(md.ref))
      t.equal(
        r.content,
        { kind: 'text', text: '# Notes\n\nÀ bientôt.', mediaType: 'text/markdown' },
        'a markdown file read back'
      )
      const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
      const image = await create(t, s, `${s.token}-pixel.png`, { base64: b64(png) })
      const ri = await readText(t, s, String(image.ref))
      t.equal(ri.content, { kind: 'bytes', base64: b64(png), mediaType: 'image/png' }, 'a PNG read back')
      const native = s.files.fixtures?.native
      if (!native) {
        t.note('no fixture native: the document of the store is not tested')
        return
      }
      const rn = await readText(t, s, native)
      t.equal((rn.content as Json).kind, 'text', 'a native document reads as text')
      t.equal((rn.item as Json).native, true, 'native of a native document')
    },
  },
  {
    id: 'FEAT-FILES-006',
    capability: null,
    async run(t: TestContext, s) {
      const text = 'é'.repeat(1500)
      const f = await create(t, s, `${s.token}-long.txt`, { text })
      const r = await readText(t, s, String(f.ref), { maxBytes: 1000 })
      const got = String((r.content as Json).text)
      t.ok(Buffer.byteLength(got, 'utf8') <= 1000, `${Buffer.byteLength(got, 'utf8')} bytes answered for maxBytes 1000`)
      t.ok(got.length > 0 && text.startsWith(got), 'the text is not the start of the file, cut at a character')
      t.equal(r.truncated, true, 'truncated')
      const whole = await readText(t, s, String(f.ref))
      t.ok(whole.truncated === undefined, 'truncated present on a text read whole')
    },
  },
  {
    id: 'FEAT-FILES-007',
    capability: null,
    async run(t: TestContext, s) {
      const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255])
      const name = `${s.token}-007.bin`
      const f = await create(t, s, name, { base64: b64(bytes) })
      const r = await readText(t, s, String(f.ref))
      t.equal((r.content as Json).base64, b64(bytes), 'a created file read back byte for byte')
      t.refused(
        await s.A.call('files_create', { root: s.run.first, name, content: { text: 'other' } }),
        'already-exists',
        'a second create of the name'
      )
      const again = await readText(t, s, String(f.ref))
      t.equal((again.content as Json).base64, b64(bytes), 'the first content after a refused second create')
    },
  },
  {
    id: 'FEAT-FILES-008',
    capability: null,
    async run(t: TestContext, s) {
      for (const name of ['a/b.txt', '', 'x'.repeat(256), '.', '..', 'tab\there.txt'])
        t.refused(
          await s.A.call('files_create', { root: s.run.first, name, content: { text: 'x' } }),
          'invalid-argument',
          `the name ${JSON.stringify(name.slice(0, 20))}`,
          'name'
        )
      const name = `${s.token}-008.txt`
      t.refused(
        await s.A.call('files_create', {
          root: s.run.first,
          folder: `${s.token}-no-such-folder`,
          name,
          content: { text: 'x' },
        }),
        'not-found',
        'a create in a folder that does not exist'
      )
      const items = await listAll(t, s.A, { root: s.run.first })
      t.ok(!items.some((i) => i.name === name), 'a create in a folder that does not exist created something')
    },
  },
  {
    id: 'FEAT-FILES-009',
    capability: null,
    async run(t: TestContext, s) {
      const f = await create(t, s, `${s.token}-009.txt`, { text: 'before' })
      const done = t.success(
        await s.A.call('files_replace', {
          root: s.run.first,
          ref: f.ref,
          ifVersion: f.version,
          content: { text: 'after' },
        }),
        'a replace'
      )
      const item = done.item as Json
      t.ok(item.version !== f.version, 'a replace answers no new version')
      const r = await readText(t, s, String(f.ref))
      t.equal((r.content as Json).text, 'after', 'the content after a replace')
      t.equal((r.item as Json).path, f.path, 'the path after a replace')
      t.refused(
        await s.A.call('files_replace', { root: s.run.first, ref: f.ref, content: { text: 'x' } }),
        'invalid-argument',
        'a replace with no ifVersion',
        'ifVersion'
      )
    },
  },
  {
    id: 'FEAT-FILES-010',
    capability: null,
    async run(t: TestContext, s) {
      const before = (await listAll(t, s.A, { root: s.run.first })).length
      t.refused(
        await s.A.call('files_replace', {
          root: s.run.first,
          ref: `${s.token}-nothing`,
          ifVersion: 'v',
          content: { text: 'x' },
        }),
        'not-found',
        'a replace of a reference that names nothing'
      )
      t.equal((await listAll(t, s.A, { root: s.run.first })).length, before, 'the items of the folder after')
    },
  },
  {
    id: 'FEAT-FILES-012',
    capability: null,
    async run(t: TestContext, s) {
      const link = s.files.fixtures?.link
      if (!link) t.skip('needs the fixture link: a shortcut in the first location to a file of the second')
      const items = await listAll(t, s.A, { root: s.run.first })
      t.equal(items.find((i) => i.ref === link)?.kind, 'link', 'the kind of the shortcut, listed')
      t.refused(
        await s.A.call('files_read', { root: s.run.first, ref: link }),
        ['not-supported', 'not-found'],
        'a read of a link'
      )
      t.refused(
        await s.A.call('files_list', { root: s.run.first, folder: link }),
        ['not-supported', 'not-found'],
        'a list through a link'
      )
      t.refused(
        await s.A.call('files_replace', { root: s.run.first, ref: link, ifVersion: 'v', content: { text: 'x' } }),
        ['not-supported', 'not-found'],
        'a write through a link'
      )
    },
  },
  {
    id: 'FEAT-FILES-013',
    capability: null,
    async run(t: TestContext, s) {
      const f = await create(t, s, `${s.token}-013.txt`, { text: 'x' })
      t.refused(
        await s.A.call('files_list', { root: s.run.first, folder: f.ref }),
        'not-supported',
        'files_list of a file'
      )
      const root = (t.success(
        await s.A.call('files_get', { root: s.run.first, ref: s.run.first }),
        'files_get of the root'
      ).item ?? {}) as Json
      t.equal([root.kind, root.path, root.parent], ['folder', '/', undefined], 'the root: kind, path, parent')
    },
  },
  {
    id: 'FEAT-FILES-014',
    capability: null,
    async run(t: TestContext, s) {
      const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello', 'utf8')])
      const f = await create(t, s, `${s.token}-bom.txt`, { base64: b64(bom) })
      t.equal(((await readText(t, s, String(f.ref))).content as Json).text, 'hello', 'a text with a byte order mark')
      const cases: [string, Json, string][] = [
        [`${s.token}-notes.md`.replace('.md', '-014.md'), { text: '#' }, 'text/markdown'],
        [`${s.token}-notes`, { text: 'n' }, 'text/plain'],
        [`${s.token}-blob`, { base64: b64(Buffer.from([1, 2])) }, 'application/octet-stream'],
      ]
      for (const [name, content, type] of cases) {
        const item = await create(t, s, name, content as { text: string })
        t.equal(item.mediaType, type, `the type of ${name}`)
      }
    },
  },
  {
    id: 'FEAT-FILES-015',
    capability: null,
    late: true,
    async run(t: TestContext, s) {
      const native = s.files.fixtures?.native
      if (native) {
        const got = t.success(
          await s.A.call('files_get', { root: s.run.first, ref: native }),
          'files_get of the native document'
        )
        t.equal((got.item as Json).native, true, 'native of a document of the store')
      } else t.note('no fixture native: native: true is not tested')
      const tally = s.observer.result(FILES_PROFILE.id, 'FEAT-FILES-015')
      t.ok(tally.violations.length === 0, tally.violations.join(' | '))
    },
  },
  {
    id: 'FEAT-FILES-016',
    capability: null,
    async run(t: TestContext, s) {
      if (has(s, 'folders')) {
        const f = await folder(t, s, `${s.token}-016`)
        t.refused(
          await s.A.call('files_replace', {
            root: s.run.first,
            ref: f.ref,
            ifVersion: String(f.version ?? 'v'),
            content: { text: 'x' },
          }),
          'not-supported',
          'a replace of a folder'
        )
      } else {
        t.refused(
          await s.A.call('files_replace', {
            root: s.run.first,
            ref: s.run.first,
            ifVersion: 'v',
            content: { text: 'x' },
          }),
          'not-supported',
          'a replace of the root, a folder'
        )
      }
      const csv = await create(t, s, `${s.token}-016.csv`, { text: 'a,b' })
      const done = t.success(
        await s.A.call('files_replace', {
          root: s.run.first,
          ref: csv.ref,
          ifVersion: csv.version,
          content: { text: 'c,d' },
        }),
        'a replace with no mediaType'
      )
      t.equal((done.item as Json).mediaType, csv.mediaType, 'the type of a file replaced with no mediaType')
      const native = s.files.fixtures?.nativeNotConvertible
      if (!native) {
        t.note('no fixture nativeNotConvertible: the refusal of a document the store does not convert is not tested')
        return
      }
      const got = (t.success(await s.A.call('files_get', { root: s.run.first, ref: native }), 'files_get').item ??
        {}) as Json
      t.refused(
        await s.A.call('files_replace', {
          root: s.run.first,
          ref: native,
          ifVersion: got.version,
          content: { text: 'x' },
        }),
        'not-supported',
        'a replace of a document the store does not convert'
      )
      const after = (t.success(await s.A.call('files_get', { root: s.run.first, ref: native }), 'files_get').item ??
        {}) as Json
      t.equal(after.version, got.version, 'the version of the document after')
    },
  },
  {
    id: 'FEAT-FILES-017',
    capability: null,
    async run(t: TestContext, s) {
      const dup = s.files.fixtures?.duplicates
      if (!dup)
        t.skip(
          'needs the fixture duplicates: a folder with two items named a.txt, made by other means where the store allows it'
        )
      const items = (await listAll(t, s.A, { root: s.run.first, folder: dup })).filter((i) => i.name === 'a.txt')
      t.equal(items.length, 2, 'the items named a.txt listed')
      t.ok(items[0]?.ref !== items[1]?.ref, 'the two items of one name have one reference')
      t.refused(
        await s.A.call('files_create', { root: s.run.first, folder: dup, name: 'a.txt', content: { text: 'x' } }),
        'already-exists',
        'a create of a.txt there'
      )
    },
  },
  // search
  {
    id: 'FEAT-FILES-020',
    capability: 'search',
    async run(t: TestContext, s) {
      const second = await listAll(t, s.A, { root: s.run.second })
      const file = second.find((i) => i.kind === 'file')
      if (!file) t.skip('needs a file in the second location, whose name gives a word')
      const word = String(file.name)
        .split(/[^\p{L}\p{N}]+/u)
        .find((w) => w.length >= 3)
      if (!word) t.skip(`the name of the second location's file ${String(file.name)} has no word of three letters`)
      const mine = await create(t, s, `${s.token} ${word} 020.txt`, { text: 'x' })
      const found = t.success(
        await s.A.call('files_search', { root: s.run.first, query: word, in: 'name' }),
        'files_search'
      )
      const refs = ((found.items as Json[]) ?? []).map((i) => i.ref)
      t.ok(refs.includes(mine.ref), 'the file of the first location is not found')
      t.ok(!refs.includes(file.ref), 'the file of the second location is found from the first')
      for (const operator of [
        `'${s.run.second}' in parents`,
        `parent:${s.run.second}`,
        `path:${s.files.second.path ?? '/'}`,
      ]) {
        const out = await s.A.call('files_search', { root: s.run.first, query: `${word} ${operator}` })
        if (out.ok)
          t.ok(
            !((out.content.items as Json[]) ?? []).some((i) => i.ref === file.ref),
            `the query ${operator} reaches the second location`
          )
      }
      if ((s.run.declaration.search as Json | undefined)?.content === false)
        t.refused(
          await s.A.call('files_search', { root: s.run.first, query: word, in: 'content' }),
          'not-supported',
          'in content where content is false',
          'in'
        )
    },
  },
  {
    id: 'FEAT-FILES-021',
    capability: 'search',
    async run(t: TestContext, s) {
      requires(t, s, 'folders')
      const word = `${s.token}kiwi`
      const a = await folder(t, s, `${s.token}-021-A`)
      const b = await folder(t, s, `${s.token}-021-B`)
      const inA = await create(t, s, `${word}.txt`, { text: 'one' }, { folder: a.ref })
      await create(t, s, `${word}.txt`, { text: 'two' }, { folder: b.ref })
      const found = t.success(
        await s.A.call('files_search', { root: s.run.first, query: word, folder: a.ref }),
        'files_search in /A'
      )
      t.equal(
        ((found.items as Json[]) ?? []).map((i) => i.ref),
        [inA.ref],
        'a search with folder /A'
      )
      for (const i of (found.items as Json[]) ?? [])
        t.ok(i.snippet === undefined, 'an item found by its name carries a snippet')
      if ((s.run.declaration.search as Json | undefined)?.content === false) {
        t.note('the server does not search contents: in name against a word of a text is not tested')
        return
      }
      const textWord = `${s.token}mango`
      await create(t, s, `${s.token}-021-plain.txt`, { text: `a word ${textWord} in the text` })
      const byName = t.success(
        await s.A.call('files_search', { root: s.run.first, query: textWord, in: 'name' }),
        'files_search in name'
      )
      t.equal(((byName.items as Json[]) ?? []).length, 0, 'a word found only in a text, searched in names')
      const byContent = t.success(
        await s.A.call('files_search', { root: s.run.first, query: textWord, in: 'content' }),
        'files_search in content'
      )
      const hit = ((byContent.items as Json[]) ?? [])[0]
      t.ok(hit && typeof hit.snippet === 'string', 'an item found by its content without a snippet')
    },
  },
  // folders
  {
    id: 'FEAT-FILES-030',
    capability: 'folders',
    async run(t: TestContext, s) {
      const from = await folder(t, s, `${s.token}-030-from`)
      const to = await folder(t, s, `${s.token}-030-to`)
      t.refused(
        await s.A.call('files_create_folder', { root: s.run.first, name: `${s.token}-030-from` }),
        'already-exists',
        'a second folder of one name'
      )
      const f = await create(t, s, 'moved.txt', { text: 'moved' }, { folder: from.ref })
      const moved = (t.success(
        await s.A.call('files_move', { root: s.run.first, ref: f.ref, toFolder: to.ref, newName: 'renamed.txt' }),
        'files_move'
      ).item ?? {}) as Json
      s.created.add(String(moved.ref))
      t.equal(
        ((await readText(t, s, String(moved.ref))).content as Json).text,
        'moved',
        'the file read by the reference the move answered'
      )
      const left = await listAll(t, s.A, { root: s.run.first, folder: from.ref })
      t.ok(
        !left.some((i) => i.ref === f.ref || i.name === 'moved.txt'),
        'the file is still listed in the folder it left'
      )
    },
  },
  {
    id: 'FEAT-FILES-031',
    capability: 'folders',
    async run(t: TestContext, s) {
      const a = await folder(t, s, `${s.token}-031`)
      const inner = await folder(t, s, 'inner', String(a.ref))
      const f = await create(t, s, `${s.token}-031.txt`, { text: 'x' })
      await create(t, s, 'taken.txt', { text: 'x' }, { folder: a.ref })
      const second = await listAll(t, s.A, { root: s.run.second })
      const elsewhere = second.find((i) => i.kind === 'folder')?.ref ?? s.run.second
      t.refused(
        await s.A.call('files_move', { root: s.run.first, ref: f.ref, toFolder: elsewhere }),
        'not-found',
        'a toFolder the root does not hold'
      )
      t.note('no argument of Files 1.0 gives a destination by path: outside-location is not tested')
      t.refused(
        await s.A.call('files_move', { root: s.run.first, ref: a.ref, toFolder: inner.ref }),
        'invalid-argument',
        'a folder moved into itself'
      )
      t.refused(
        await s.A.call('files_move', { root: s.run.first, ref: f.ref, toFolder: a.ref, newName: 'taken.txt' }),
        'already-exists',
        'a name the destination holds'
      )
      const still = t.success(await s.A.call('files_get', { root: s.run.first, ref: f.ref }), 'files_get after')
      t.equal((still.item as Json).path, f.path, 'the path of a file not moved')
    },
  },
  {
    id: 'FEAT-FILES-032',
    capability: 'folders',
    async run(t: TestContext, s) {
      t.refused(
        await s.A.call('files_create_folder', { root: s.run.first, name: '..' }),
        'invalid-argument',
        'a folder named ..',
        'name'
      )
      const f = await create(t, s, `${s.token}-032.txt`, { text: 'one' })
      t.refused(
        await s.A.call('files_move', { root: s.run.first, ref: f.ref }),
        'invalid-argument',
        'a move with no destination'
      )
      t.refused(
        await s.A.call('files_move', { root: s.run.first, ref: s.run.first, newName: `${s.token}-root` }),
        'not-supported',
        'a move of the root'
      )
      t.success(
        await s.A.call('files_replace', {
          root: s.run.first,
          ref: f.ref,
          ifVersion: f.version,
          content: { text: 'two' },
        }),
        'a replace'
      )
      t.refused(
        await s.A.call('files_move', {
          root: s.run.first,
          ref: f.ref,
          newName: `${s.token}-032-b.txt`,
          ifVersion: f.version,
        }),
        'version-mismatch',
        'a move with the version before a replace'
      )
      const still = t.success(await s.A.call('files_get', { root: s.run.first, ref: f.ref }), 'files_get after')
      t.equal((still.item as Json).name, f.name, 'the name of the file after')
    },
  },
  {
    id: 'FEAT-FILES-033',
    capability: 'folders',
    async run(t: TestContext, s) {
      const a = await folder(t, s, `${s.token}-033-A`)
      const b = await folder(t, s, `${s.token}-033-B`)
      await create(t, s, 'x.md', { text: 'inside A' }, { folder: a.ref })
      t.success(
        await s.A.call('files_move', { root: s.run.first, ref: a.ref, toFolder: b.ref }),
        'the move of /A into /B'
      )
      const inB = await listAll(t, s.A, { root: s.run.first, folder: b.ref })
      const movedA = inB.find((i) => i.name === a.name)
      t.ok(movedA, 'A is not listed in B')
      const inA = await listAll(t, s.A, { root: s.run.first, folder: movedA.ref })
      const movedX = inA.find((i) => i.name === 'x.md')
      t.ok(movedX, 'x.md is not listed in the moved A')
      t.ok(
        String(movedX.path).endsWith(`/${String(b.name)}/${String(a.name)}/x.md`),
        `the path of x.md is ${String(movedX.path)}`
      )
      t.equal(((await readText(t, s, String(movedX.ref))).content as Json).text, 'inside A', 'the content of x.md')
    },
  },
  // trash
  {
    id: 'FEAT-FILES-040',
    capability: 'trash',
    async run(t: TestContext, s) {
      const f = await create(t, s, `${s.token}-040.txt`, { text: 'kept' })
      t.success(await s.A.call('files_trash', { root: s.run.first, ref: f.ref }), 'files_trash')
      t.ok(
        !(await listAll(t, s.A, { root: s.run.first })).some((i) => i.ref === f.ref),
        'a trashed file is still in its folder'
      )
      const trash = t.success(await s.A.call('files_list_trash', { root: s.run.first, limit: 100 }), 'files_list_trash')
      t.ok(
        ((trash.items as Json[]) ?? []).some((i) => i.ref === f.ref),
        'a trashed file is not in the trash list'
      )
      const back = (t.success(await s.A.call('files_restore', { root: s.run.first, ref: f.ref }), 'files_restore')
        .item ?? {}) as Json
      t.equal(back.path, f.path, 'the path of the restored file')
      t.equal(
        ((await readText(t, s, String(back.ref))).content as Json).text,
        'kept',
        'the content of the restored file'
      )
    },
  },
  {
    id: 'FEAT-FILES-041',
    capability: 'trash',
    async run(t: TestContext, s) {
      t.refused(
        await s.A.call('files_trash', { root: s.run.first, ref: s.run.first }),
        'not-supported',
        'trashing the root'
      )
      const f = await create(t, s, `${s.token}-041.txt`, { text: 'one' })
      t.success(
        await s.A.call('files_replace', {
          root: s.run.first,
          ref: f.ref,
          ifVersion: f.version,
          content: { text: 'two' },
        }),
        'a replace'
      )
      t.refused(
        await s.A.call('files_trash', { root: s.run.first, ref: f.ref, ifVersion: f.version }),
        'version-mismatch',
        'a trash with an old version'
      )
      if (has(s, 'folders')) {
        const a = await folder(t, s, `${s.token}-041-A`)
        const inner = await create(t, s, 'inner.txt', { text: 'inner' }, { folder: a.ref })
        t.success(await s.A.call('files_trash', { root: s.run.first, ref: a.ref }), 'trashing /A')
        t.refused(
          await s.A.call('files_get', { root: s.run.first, ref: inner.ref }),
          'not-found',
          'the file of a trashed folder'
        )
        t.success(await s.A.call('files_restore', { root: s.run.first, ref: a.ref }), 'restoring /A')
        t.success(await s.A.call('files_get', { root: s.run.first, ref: inner.ref }), 'the file of a restored folder')
      } else t.note('no folders: a folder trashed with what it holds is not tested')
      const name = `${s.token}-041-b.txt`
      const g = await create(t, s, name, { text: 'first' })
      t.success(await s.A.call('files_trash', { root: s.run.first, ref: g.ref }), 'files_trash')
      await create(t, s, name, { text: 'second' })
      t.refused(
        await s.A.call('files_restore', { root: s.run.first, ref: g.ref }),
        'already-exists',
        'a restore where the name is taken again'
      )
    },
  },
  {
    id: 'FEAT-FILES-042',
    capability: 'trash',
    async run(t: TestContext, s) {
      const f = await create(t, s, `${s.token}-042.txt`, { text: 'x' })
      t.success(await s.A.call('files_trash', { root: s.run.first, ref: f.ref }), 'files_trash')
      const trash = t.success(await s.A.call('files_list_trash', { root: s.run.first, limit: 100 }), 'files_list_trash')
      for (const i of (trash.items as Json[]) ?? [])
        t.ok(typeof i.trashedAt === 'string', 'an item of the trash without trashedAt')
      t.success(await s.A.call('files_restore', { root: s.run.first, ref: f.ref }), 'files_restore')
      const again = t.success(await s.A.call('files_list_trash', { root: s.run.first, limit: 100 }), 'files_list_trash')
      t.ok(!((again.items as Json[]) ?? []).some((i) => i.ref === f.ref), 'a restored item still in the trash list')
    },
  },
  // share
  ...shareTests(),
  // versions, export
  {
    id: 'FEAT-FILES-060',
    capability: 'versions',
    async run(t: TestContext, s) {
      const f = await create(t, s, `${s.token}-060.txt`, { text: 'first' })
      const two = (t.success(
        await s.A.call('files_replace', {
          root: s.run.first,
          ref: f.ref,
          ifVersion: f.version,
          content: { text: 'second' },
        }),
        'a replace'
      ).item ?? {}) as Json
      t.success(
        await s.A.call('files_replace', {
          root: s.run.first,
          ref: f.ref,
          ifVersion: two.version,
          content: { text: 'third' },
        }),
        'a replace'
      )
      const v = t.success(await s.A.call('files_versions', { root: s.run.first, ref: f.ref }), 'files_versions')
      const versions = (v.versions as Json[]) ?? []
      t.equal(versions.length, 3, 'the versions after two replaces')
      const times = versions.map((x) => Date.parse(String(x.modifiedAt)))
      t.ok(
        times.every((x, i) => i === 0 || x <= (times[i - 1] as number)),
        'the versions are not newest first'
      )
      const oldest = versions[versions.length - 1] as Json
      t.equal(
        ((await readText(t, s, String(f.ref), { version: oldest.version })).content as Json).text,
        'first',
        'the oldest version read back'
      )
    },
  },
  {
    id: 'FEAT-FILES-062',
    capability: 'versions',
    async run(t: TestContext, s) {
      const f = await create(t, s, `${s.token}-062.txt`, { text: '0' })
      t.refused(
        await s.A.call('files_read', { root: s.run.first, ref: f.ref, version: `${s.token}-never` }),
        'not-found',
        'a made-up version'
      )
      let version = String(f.version)
      for (let i = 1; i <= 60; i++) {
        const out = t.success(
          await s.A.call('files_replace', {
            root: s.run.first,
            ref: f.ref,
            ifVersion: version,
            content: { text: String(i) },
          }),
          `replace ${i}`
        )
        version = String((out.item as Json).version)
      }
      const seen: string[] = []
      let cursor: string | undefined
      let pages = 0
      do {
        const page = t.success(
          await s.A.call('files_versions', { root: s.run.first, ref: f.ref, limit: 50, ...(cursor ? { cursor } : {}) }),
          'files_versions'
        )
        seen.push(...((page.versions as Json[]) ?? []).map((x) => String(x.version)))
        cursor = page.nextCursor as string | undefined
        pages++
      } while (cursor && pages < 100)
      t.equal(new Set(seen).size, seen.length, 'each version once over the pages')
      t.ok(seen.length > 50, `${seen.length} versions of a file replaced sixty times: not two pages of 50`)
      t.equal(
        pages,
        Math.ceil(seen.length / Math.min(50, limitsOf(s.run.declaration).page)),
        'the pages of the versions'
      )
    },
  },
  {
    id: 'FEAT-FILES-061',
    capability: 'export',
    async run(t: TestContext, s) {
      const native = s.files.fixtures?.native
      if (!native) t.skip('needs the fixture native: a document of the store that lists its exportTypes')
      const got = (t.success(await s.A.call('files_get', { root: s.run.first, ref: native }), 'files_get').item ??
        {}) as Json
      const types = (got.exportTypes as string[] | undefined) ?? []
      t.ok(types.length > 0, 'the native document lists no exportTypes')
      const type = types.includes('application/pdf') ? 'application/pdf' : (types[0] as string)
      const out = t.success(
        await s.A.call('files_export', { root: s.run.first, ref: native, mediaType: type }),
        `files_export as ${type}`
      )
      t.equal((out.content as Json).mediaType, type, 'the type of the export')
      if (!types.includes('image/gif'))
        t.refused(
          await s.A.call('files_export', { root: s.run.first, ref: native, mediaType: 'image/gif' }),
          'not-supported',
          'an export to a type not listed'
        )
    },
  },
  {
    id: 'FEAT-FILES-063',
    capability: 'export',
    late: true,
    async run(t: TestContext, s) {
      const tally = s.observer.result(FILES_PROFILE.id, 'FEAT-FILES-063')
      t.ok(tally.violations.length === 0, tally.violations.join(' | '))
      t.note('the export larger than readBytes needs a stub service: not tested by the kit')
      if (tally.seen === 0) t.skip('no native document was read in the run: give the fixture native')
    },
  },
  ...teamRootTests(),
  {
    id: 'FEAT-FILES-011',
    capability: null,
    late: true,
    async run(t: TestContext, s) {
      for (const m of s.made)
        t.success(
          await s.A.call('files_get', { root: s.run.first, ref: m.ref }),
          `the item ${m.ref}, made by a core test`
        )
      t.note(`${s.made.length} items of the core tests still there at the end of the run`)
    },
  },
]

function shareTests(): Test<FilesState>[] {
  const bAddress = (t: TestContext, s: FilesState) => {
    const a = s.options.accounts.B.address
    if (!a) t.skip("needs B's address at the service (accounts.B.address)")
    return a
  }
  /** a folder of the first location to share, holding a file: a new folder with `folders`, the root itself otherwise */
  const place = async (t: TestContext, s: FilesState, label: string) => {
    const where = has(s, 'folders') ? await folder(t, s, `${s.token}-${label}`) : undefined
    const root = s.run.first
    const target = where ? String(where.ref) : root
    const file = await create(t, s, `${s.token}-${label}.txt`, { text: label }, where ? { folder: target } : {})
    return { target, file, isRoot: !where }
  }
  return [
    {
      id: 'FEAT-FILES-050',
      capability: 'share',
      async run(t: TestContext, s) {
        const address = bAddress(t, s)
        const { target, file } = await place(t, s, '050')
        const made = t.success(
          await s.A.call('files_share', {
            root: s.run.first,
            ref: target,
            role: 'reader',
            recipients: [{ address }],
            ...(s.run.declaration.share && (s.run.declaration.share as Json).notify ? { notify: false } : {}),
          }),
          'files_share'
        )
        const share = ((made.shares as Json[]) ?? [])[0]
        t.ok(share && share.role === 'reader', 'files_share answers no share of the role asked')
        t.success(await s.B.call('files_read', { root: target, ref: file.ref }), "B's read after a reader share")
        const read = (t.success(await s.B.call('files_get', { root: target, ref: file.ref }), "B's look").item ??
          {}) as Json
        t.refused(
          await s.B.call('files_replace', {
            root: target,
            ref: file.ref,
            ifVersion: read.version,
            content: { text: 'B' },
          }),
          'permission-denied',
          "B's replace after a reader share"
        )
        t.success(await s.A.call('files_unshare', { root: s.run.first, ref: target, share: share.id }), 'files_unshare')
        t.refused(
          await s.B.call('files_read', { root: target, ref: file.ref }),
          ['not-found', 'permission-denied'],
          "B's read after the share ended"
        )
        t.refused(
          await s.A.call('files_share', {
            root: s.run.first,
            ref: target,
            role: 'reader',
            recipients: [{ address }],
            audience: 'organization',
          }),
          'invalid-argument',
          'recipients and audience together'
        )
      },
    },
    {
      id: 'FEAT-FILES-051',
      capability: 'share',
      async run(t: TestContext, s) {
        const address = bAddress(t, s)
        const declared = ((s.run.declaration.share as Json | undefined)?.audiences as string[] | undefined) ?? []
        const missing = ['organization', 'anyone'].find((a) => !declared.includes(a))
        const f = await create(t, s, `${s.token}-051.txt`, { text: 'x' })
        if (missing)
          t.refused(
            await s.A.call('files_share', { root: s.run.first, ref: f.ref, role: 'reader', audience: missing }),
            'not-supported',
            `the audience ${missing}, not declared`
          )
        else t.note('the server declares both audiences: the refusal of one not declared is not tested')
        const before =
          (t.success(await s.A.call('files_shares', { root: s.run.first, ref: f.ref }), 'files_shares')
            .shares as Json[]) ?? []
        const made = t.success(
          await s.A.call('files_share', { root: s.run.first, ref: f.ref, role: 'reader', recipients: [{ address }] }),
          'files_share'
        )
        const after =
          (t.success(await s.A.call('files_shares', { root: s.run.first, ref: f.ref }), 'files_shares')
            .shares as Json[]) ?? []
        const added = after.filter((x) => !before.some((y) => y.id === x.id))
        t.equal(added.length, 1, 'the shares added by a share to B')
        t.equal(
          String((added[0]?.recipient as Json | undefined)?.address ?? '').toLowerCase(),
          address.toLowerCase(),
          'the recipient of the new share'
        )
        for (const x of (made.shares as Json[]) ?? [])
          await s.A.call('files_unshare', { root: s.run.first, ref: f.ref, share: x.id })
      },
    },
    {
      id: 'FEAT-FILES-052',
      capability: 'share',
      async run(t: TestContext, s) {
        requires(t, s, 'folders')
        const address = bAddress(t, s)
        const { target, file } = await place(t, s, '052')
        const made = t.success(
          await s.A.call('files_share', { root: s.run.first, ref: target, role: 'reader', recipients: [{ address }] }),
          'files_share of the folder'
        )
        const id = ((made.shares as Json[])[0] as Json).id
        const shares =
          (t.success(await s.A.call('files_shares', { root: s.run.first, ref: file.ref }), "the file's shares")
            .shares as Json[]) ?? []
        const inherited = shares.find(
          (x) => String((x.recipient as Json | undefined)?.address ?? '').toLowerCase() === address.toLowerCase()
        )
        t.ok(inherited?.inherited === true, "the file's share from its folder is not inherited: true")
        t.refused(
          await s.A.call('files_unshare', { root: s.run.first, ref: file.ref, share: inherited.id }),
          'not-supported',
          'unsharing an inherited share on the file'
        )
        t.success(await s.B.call('files_read', { root: target, ref: file.ref }), "B's read while the folder is shared")
        t.success(
          await s.A.call('files_unshare', { root: s.run.first, ref: target, share: id }),
          'unsharing on the folder'
        )
        t.refused(
          await s.B.call('files_read', { root: target, ref: file.ref }),
          ['not-found', 'permission-denied'],
          "B's read of the file after"
        )
        t.refused(
          await s.B.call('files_list', { root: target }),
          ['not-found', 'permission-denied'],
          "B's list of the folder after"
        )
      },
    },
    {
      id: 'FEAT-FILES-053',
      capability: 'share',
      async run(t: TestContext, s) {
        const address = bAddress(t, s)
        const notify = (s.run.declaration.share as Json | undefined)?.notify === true
        const f = await create(t, s, `${s.token}-053.txt`, { text: 'x' })
        if (!notify) {
          t.refused(
            await s.A.call('files_share', {
              root: s.run.first,
              ref: f.ref,
              role: 'reader',
              recipients: [{ address }],
              notify: true,
            }),
            'not-supported',
            'notify where the server declares notify false'
          )
          return
        }
        const messages = s.options.hooks?.messages
        if (!messages) t.skip('needs the hook messages, to read what B receives')
        const before = (await messages(address)).length
        t.success(
          await s.A.call('files_share', {
            root: s.run.first,
            ref: f.ref,
            role: 'reader',
            recipients: [{ address }],
            notify: false,
          }),
          'a share with notify false'
        )
        t.equal((await messages(address)).length, before, 'the messages B received after a share with notify false')
        const g = await create(t, s, `${s.token}-053-b.txt`, { text: 'x' })
        t.success(
          await s.A.call('files_share', {
            root: s.run.first,
            ref: g.ref,
            role: 'reader',
            recipients: [{ address }],
            message: 'Q3',
          }),
          'a share with a message'
        )
        const got = (await messages(address)).slice(before)
        t.ok(
          got.some((m) => m.text.includes('Q3')),
          'no message to B holds the message of the share'
        )
      },
    },
    {
      id: 'FEAT-FILES-054',
      capability: 'share',
      async run(t: TestContext, s) {
        const address = bAddress(t, s)
        const f = await create(t, s, `${s.token}-054.txt`, { text: 'x' })
        const made = t.success(
          await s.A.call('files_share', { root: s.run.first, ref: f.ref, role: 'reader', recipients: [{ address }] }),
          'files_share'
        )
        const shared = (t.success(await s.A.call('files_get', { root: s.run.first, ref: f.ref }), 'files_get').item ??
          {}) as Json
        t.equal(shared.shared, true, 'shared of a shared file')
        for (const x of (made.shares as Json[]) ?? [])
          t.success(await s.A.call('files_unshare', { root: s.run.first, ref: f.ref, share: x.id }), 'files_unshare')
        const after = (t.success(await s.A.call('files_get', { root: s.run.first, ref: f.ref }), 'files_get').item ??
          {}) as Json
        t.ok(after.shared === undefined, 'shared after the share ended')
        const rootShare = await s.A.call('files_share', {
          root: s.run.first,
          ref: s.run.first,
          role: 'reader',
          recipients: [{ address }],
        })
        if (!rootShare.ok) {
          t.note(
            `the first location itself could not be shared (${rootShare.error.code}): a share on the root is not tested`
          )
          return
        }
        const g = await create(t, s, `${s.token}-054-b.txt`, { text: 'x' })
        t.ok(g.shared === undefined, 'a file of a root shared with B carries shared')
        for (const x of (rootShare.content.shares as Json[]) ?? [])
          await s.A.call('files_unshare', { root: s.run.first, ref: s.run.first, share: x.id })
      },
    },
    {
      id: 'FEAT-FILES-055',
      capability: 'share',
      async run(t: TestContext, s) {
        const f = await create(t, s, `${s.token}-055.txt`, { text: 'x' })
        const many = Array.from({ length: 21 }, (_, i) => ({ address: `person${i}@example.org` }))
        t.refused(
          await s.A.call('files_share', { root: s.run.first, ref: f.ref, role: 'reader', recipients: many }),
          'invalid-argument',
          '21 addresses',
          'recipients'
        )
        t.refused(
          await s.A.call('files_share', { root: s.run.first, ref: f.ref, role: 'reader', recipients: [] }),
          'invalid-argument',
          'no address',
          'recipients'
        )
        t.refused(
          await s.A.call('files_share', {
            root: s.run.first,
            ref: f.ref,
            role: 'manager',
            recipients: [{ address: 'person@example.org' }],
          }),
          'not-supported',
          'role manager on an item that is not a team root'
        )
      },
    },
  ]
}

function teamRootTests(): Test<FilesState>[] {
  const needM = (t: TestContext, s: FilesState): Session => {
    if (!s.M) t.skip('needs the account M, which may create a team root')
    return s.M
  }
  const address = (t: TestContext, s: FilesState, who: 'A' | 'B') => {
    const a = s.options.accounts[who].address
    if (!a) t.skip(`needs ${who}'s address at the service`)
    return a
  }
  const make = async (t: TestContext, s: FilesState, M: Session): Promise<string> => {
    if (s.teamRoot) return s.teamRoot
    const out = t.success(
      await M.call('files_create_team_root', { name: `Project Alpha ${s.token}`, requestId: `${s.token}-alpha` }),
      'files_create_team_root'
    )
    s.teamRoot = String((out.root as Json).ref)
    return s.teamRoot
  }
  const rootsOf = async (t: TestContext, session: Session) => {
    const out: Json[] = []
    let cursor: string | undefined
    do {
      const page = t.success(await session.call('files_roots', cursor ? { cursor } : {}), 'files_roots')
      out.push(...((page.roots as Json[]) ?? []))
      cursor = page.nextCursor as string | undefined
    } while (cursor && out.length < 5000)
    return out
  }
  return [
    {
      id: 'FEAT-FILES-070',
      capability: 'team-roots',
      async run(t: TestContext, s) {
        t.ok(s.run.declaration.capabilities.includes('share'), 'team-roots declared without share')
        const M = needM(t, s)
        const ref = await make(t, s, M)
        const again = t.success(
          await M.call('files_create_team_root', { name: `Project Alpha ${s.token}`, requestId: `${s.token}-alpha` }),
          'the same request again'
        )
        t.equal((again.root as Json).ref, ref, 'the root of the same request')
        const roots = (await rootsOf(t, M)).filter((r) => r.title === `Project Alpha ${s.token}`)
        t.equal(roots.length, 1, "the team roots of that name in M's list")
        t.equal([roots[0]?.team, roots[0]?.portable], [true, true], 'team and portable of the team root')
      },
    },
    {
      id: 'FEAT-FILES-071',
      capability: 'team-roots',
      async run(t: TestContext, s) {
        const M = needM(t, s)
        const root = await make(t, s, M)
        const a = address(t, s, 'A')
        const b = address(t, s, 'B')
        t.success(
          await M.call('files_share', { root, ref: root, role: 'editor', recipients: [{ address: a }] }),
          'A as editor'
        )
        t.success(
          await M.call('files_share', { root, ref: root, role: 'reader', recipients: [{ address: b }] }),
          'B as reader'
        )
        const members =
          (t.success(await M.call('files_shares', { root, ref: root }), 'files_shares of the root').shares as Json[]) ??
          []
        for (const who of [a, b])
          t.equal(
            members.filter(
              (m) => String((m.recipient as Json | undefined)?.address ?? '').toLowerCase() === who.toLowerCase()
            ).length,
            1,
            `the lines of ${who} among the members`
          )
        const made = (t.success(
          await s.A.call('files_create', { root, name: `${s.token}-071.txt`, content: { text: 'by A' } }),
          "A's create"
        ).item ?? {}) as Json
        t.success(await s.B.call('files_read', { root, ref: made.ref }), "B's read")
        t.refused(
          await s.B.call('files_create', { root, name: `${s.token}-071-b.txt`, content: { text: 'by B' } }),
          'permission-denied',
          "B's create as a reader"
        )
        t.success(
          await M.call('files_share', { root, ref: root, role: 'editor', recipients: [{ address: b }] }),
          'B again, as editor'
        )
        t.success(
          await s.B.call('files_create', { root, name: `${s.token}-071-c.txt`, content: { text: 'by B' } }),
          "B's create as an editor"
        )
        const bLine = (
          (t.success(await M.call('files_shares', { root, ref: root }), 'files_shares').shares as Json[]) ?? []
        ).find((m) => String((m.recipient as Json | undefined)?.address ?? '').toLowerCase() === b.toLowerCase())
        t.ok(bLine, 'B is not among the members')
        t.success(await M.call('files_unshare', { root, ref: root, share: bLine.id }), 'files_unshare of B')
        t.ok(!(await rootsOf(t, s.B)).some((r) => r.ref === root), "B's files_roots still lists the root")
        t.refused(await s.B.call('files_read', { root, ref: made.ref }), 'not-found', "B's read after")
        t.refused(
          await M.call('files_share', { root, ref: root, role: 'reader', audience: 'organization' }),
          'not-supported',
          'an audience on a team root'
        )
      },
    },
    {
      id: 'FEAT-FILES-072',
      capability: 'team-roots',
      async run(t: TestContext, s) {
        const M = needM(t, s)
        const root = await make(t, s, M)
        const before =
          (t.success(await M.call('files_shares', { root, ref: root }), 'files_shares').shares as Json[]) ?? []
        const nobody = s.options.organization?.noAccount ?? `nobody-${s.token}@example.org`
        const e = t.refused(
          await M.call('files_share', { root, ref: root, role: 'reader', recipients: [{ address: nobody }] }),
          'recipient-refused',
          'an address that is no account of the store'
        )
        t.equal(e.error.reason, 'no-account', 'the reason')
        const outside = s.options.organization?.outside
        if (outside) {
          const o = await M.call('files_share', { root, ref: root, role: 'reader', recipients: [{ address: outside }] })
          if (o.ok) t.note('the store takes the outside address: not-allowed is not tested')
          else t.equal([o.error.code, o.error.reason], ['recipient-refused', 'not-allowed'], 'an address outside')
        } else t.note('no organization.outside: not-allowed is not tested')
        const after =
          (t.success(await M.call('files_shares', { root, ref: root }), 'files_shares').shares as Json[]) ?? []
        t.equal(after.map((x) => x.id).sort(), before.map((x) => x.id).sort(), 'the members after the refusals')
      },
    },
    {
      id: 'FEAT-FILES-073',
      capability: 'team-roots',
      async run(t: TestContext, s) {
        const M = needM(t, s)
        const root = await make(t, s, M)
        const a = address(t, s, 'A')
        t.success(
          await M.call('files_share', { root, ref: root, role: 'editor', recipients: [{ address: a }] }),
          'A as editor'
        )
        const name = `Alpha ${s.token}`
        t.success(await M.call('files_rename_root', { root, name }), "M's rename")
        const listed = (await rootsOf(t, s.A)).find((r) => r.ref === root)
        t.equal(listed?.title, name, "the title of the root in A's list after the rename")
        t.refused(
          await s.A.call('files_rename_root', { root, name: `${name} 2` }),
          'permission-denied',
          "A's rename as an editor"
        )
        const own = (await rootsOf(t, s.A)).find((r) => r.path === '/')
        if (own)
          t.refused(
            await s.A.call('files_rename_root', { root: own.ref, name: 'x' }),
            'not-supported',
            "renaming A's own folder"
          )
      },
    },
    {
      id: 'FEAT-FILES-074',
      capability: 'team-roots',
      async run(t: TestContext, s) {
        const M = needM(t, s)
        const root = await make(t, s, M)
        const a = address(t, s, 'A')
        const manager = (s.run.declaration['team-roots'] as Json | undefined)?.manager === true
        const out = await M.call('files_share', { root, ref: root, role: 'manager', recipients: [{ address: a }] })
        if (!manager) {
          t.refused(out, 'not-supported', 'role manager where the server declares manager false')
          return
        }
        t.success(out, 'A as manager')
        const b = address(t, s, 'B')
        t.success(
          await s.A.call('files_share', { root, ref: root, role: 'reader', recipients: [{ address: b }] }),
          "A's share of B, as a manager"
        )
        t.success(
          await s.A.call('files_rename_root', { root, name: `Alpha ${s.token} by A` }),
          "A's rename, as a manager"
        )
      },
    },
  ]
}
