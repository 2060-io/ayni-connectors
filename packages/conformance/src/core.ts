/**
 * The tests of the common part (common §15, FEAT-CORE-001 to 026), run once for each profile the server declares,
 * through a profile's adapter: how to make, read, change and list an item of its locations.
 */
import {
  annotationsOf,
  capabilityNames,
  coreTools,
  inputSchemaFor,
  isCompatibleVersion,
  LEAST_LIMITS,
  limitsOf,
  type ProfileDefinition,
  parseVersion,
  validateDeclaration,
  validateSchema,
} from '@ayni.org/ayni-feature-profiles'
import { type RunState, sampleOf, type Test, type TestContext } from './harness.js'
import { CallFailed, type Json, type Outcome, type Session } from './session.js'

export interface Declared {
  version: string
  capabilities: string[]
  limits?: { page?: number; readBytes?: number; writeBytes?: number }
  atomicWrites?: boolean
  [member: string]: unknown
}

/** How the common tests reach one profile's items. */
export interface ProfileRun {
  profile: ProfileDefinition
  declaration: Declared
  /** the capabilities the runner expects, exactly, when given */
  expect?: string[]
  first: string
  second: string
  /** a reference that names no item */
  unknownRef: string
  make(s: Session, name: string): Promise<{ ref: string; version: string }>
  read(s: Session, location: string, ref: string): Promise<Outcome>
  change(s: Session, location: string, ref: string, ifVersion: string, n: number): Promise<Outcome>
  /** the arguments of a listing of `n` items made for paging, and their references */
  many(n: number): Promise<{ tool: string; args: Json; member: string; refs: string[] }>
  /** a call of a tool that lists, in a location: for the tests of arguments and accounts */
  listCall(location: string): { tool: string; args: Json; member: string }
  /** a name that an answer must not hold: the name of an item the call cannot reach */
  nameOf(ref: string): string | undefined
}

export interface CoreState extends RunState {
  run: ProfileRun
  /** the items made by the tests of the run, to read again at the end (FEAT-CORE-008, FEAT-FILES-011) */
  made: { ref: string; at: number }[]
}

const has = (run: ProfileRun, capability: string) => run.declaration.capabilities.includes(capability)

async function pages(t: TestContext, s: Session, tool: string, args: Json, member: string, limit: number) {
  const seen: string[] = []
  let cursor: string | undefined
  let count = 0
  do {
    const page = t.success(
      await s.call(tool, { ...args, limit, ...(cursor ? { cursor } : {}) }),
      `${tool} page ${count + 1}`
    )
    const items = (page[member] as Json[]) ?? []
    t.ok(items.length <= limit, `a page of ${tool} holds ${items.length} items, more than ${limit}`)
    for (const i of items) seen.push(String(i.ref))
    cursor = page.nextCursor as string | undefined
    count++
    t.ok(count < 1000, `${tool} answers nextCursor without end`)
  } while (cursor)
  return { seen, count }
}

export const CORE_TESTS: Test<CoreState>[] = [
  {
    id: 'FEAT-CORE-001',
    capability: null,
    async run(t: TestContext, s) {
      const id = s.run.profile.id
      const d = s.run.declaration
      const problems = validateDeclaration(s.run.profile, d)
      t.ok(problems.length === 0, `the declaration is not the profile's: ${problems.join('; ')}`)
      t.ok(
        isCompatibleVersion(s.run.profile.version, d.version),
        `version ${d.version} is not of ${s.run.profile.version}'s major`
      )
      const known = capabilityNames(s.run.profile)
      if (parseVersion(d.version)?.minor === parseVersion(s.run.profile.version)?.minor)
        for (const c of d.capabilities) t.ok(known.includes(c), `capability ${c} is not a name of the profile`)
      if (s.run.expect) t.equal([...d.capabilities].sort(), [...s.run.expect].sort(), 'the capabilities declared')
      // the same declaration in the result of `initialize`, for a client of an earlier revision (common §3)
      const legacy = await s.A.initializeRaw()
      t.ok(legacy.extensions[id] !== undefined, `initialize does not declare ${id}`)
      t.equal(
        legacy.extensions[id],
        s.run.declaration,
        `the declaration of initialize and of ${s.A.era === 'modern' ? 'server/discover' : 'initialize'}`
      )
      t.note(
        `declared ${d.version} with [${d.capabilities.join(', ')}] in ${s.A.era === 'modern' ? 'server/discover and initialize' : 'initialize'}`
      )
    },
  },
  {
    id: 'FEAT-CORE-002',
    capability: null,
    async run(t: TestContext, s) {
      const p = s.run.profile
      const listed = (await s.A.listTools()).map((x) => String(x.name)).filter((n) => n.startsWith(p.prefix))
      const expected = p.tools.filter((x) => x.capability === null || has(s.run, x.capability)).map((x) => x.name)
      const known = new Set(p.tools.map((x) => x.name))
      // a later minor version may add tools of its own capabilities: only the names of this version are compared
      t.equal(listed.filter((n) => known.has(n)).sort(), [...expected].sort(), 'the tools listed with the prefix')
    },
  },
  {
    id: 'FEAT-CORE-003',
    capability: null,
    async run(t: TestContext, s) {
      const p = s.run.profile
      const known = new Set(p.tools.map((x) => x.name))
      const listed = (await s.A.listTools()).map((x) => String(x.name)).filter((n) => n.startsWith(p.prefix))
      const unknown = listed.filter((n) => !known.has(n))
      if (unknown.length && parseVersion(s.run.declaration.version)?.minor !== parseVersion(p.version)?.minor)
        t.notApplicable(
          `the server declares ${s.run.declaration.version}, whose tools ${unknown.join(', ')} this kit does not know`
        )
      t.equal(unknown, [], 'tools with the prefix that the profile does not have')
    },
  },
  {
    id: 'FEAT-CORE-004',
    capability: null,
    async run(t: TestContext, s) {
      const p = s.run.profile
      const listed = new Map((await s.A.listTools()).map((x) => [String(x.name), x]))
      for (const tool of p.tools.filter((x) => x.capability === null || has(s.run, x.capability))) {
        const schema = listed.get(tool.name)?.inputSchema as Json | undefined
        t.ok(schema, `${tool.name} is not listed`)
        const ours = inputSchemaFor(tool, s.run.declaration.capabilities) as {
          properties: Record<string, Json>
          required?: string[]
        }
        const full = Object.fromEntries(Object.entries(ours.properties).map(([k, v]) => [k, sampleOf(v, k)]))
        const required = Object.fromEntries((ours.required ?? []).map((k) => [k, full[k]]))
        for (const [label, input] of [
          ['every argument', full],
          ['the required arguments', required],
        ] as const) {
          const problems = validateSchema(schema as Json, input)
          t.ok(
            problems.length === 0,
            `${tool.name}: an input with ${label} does not validate against the listed schema (${problems[0]?.instancePath} ${problems[0]?.message})`
          )
        }
      }
    },
  },
  {
    id: 'FEAT-CORE-005',
    capability: null,
    async run(t: TestContext, s) {
      const call = s.run.listCall(s.run.first)
      t.refused(
        await s.A.call(call.tool, { ...call.args, colour: 'red' }),
        'invalid-argument',
        `${call.tool} with colour`,
        'colour'
      )
      // an argument of a capability the server did not declare
      const p = s.run.profile
      for (const tool of coreTools(p)) {
        const arg = tool.arguments.find((a) => a.capability && !has(s.run, a.capability))
        if (!arg) continue
        const ours = inputSchemaFor(tool, [...s.run.declaration.capabilities, arg.capability as string]) as {
          properties: Record<string, Json>
          required?: string[]
        }
        const args: Json = Object.fromEntries(
          (ours.required ?? []).map((k) => [k, sampleOf(ours.properties[k] ?? {}, k)])
        )
        if (tool.located) args[p.location.argument] = s.run.first
        args[arg.name] = sampleOf(ours.properties[arg.name] ?? {}, arg.name)
        t.refused(
          await s.A.call(tool.name, args),
          'not-supported',
          `${tool.name} with ${arg.name} of ${arg.capability}`,
          arg.name
        )
        t.note(`${tool.name}.${arg.name} of ${arg.capability}, not declared, answers not-supported`)
        return
      }
      t.note('every capability is declared: the half of not-supported does not apply')
    },
  },
  {
    id: 'FEAT-CORE-007',
    capability: null,
    async run(t: TestContext, s) {
      const out = await s.run.read(s.A, s.run.first, s.run.unknownRef)
      t.refused(out, 'not-found', 'a read of an unknown reference')
      const hooks = s.options.hooks
      if (!hooks?.stopService || !hooks.startService) {
        t.note('no hook stops the service: the case of unavailable is not tested')
        return
      }
      await hooks.stopService()
      try {
        const call = s.run.listCall(s.run.first)
        t.refused(await s.A.call(call.tool, call.args), 'unavailable', 'a call with the service stopped')
      } finally {
        await hooks.startService()
      }
    },
  },
  {
    id: 'FEAT-CORE-009',
    capability: null,
    async run(t: TestContext, s) {
      const item = await s.run.make(s.A, 'core-009')
      s.made.push({ ref: item.ref, at: Date.now() })
      const a = t.success(await s.run.read(s.A, s.run.first, item.ref), 'a read')
      const b = t.success(await s.run.read(s.A, s.run.first, item.ref), 'a second read')
      const va = versionOf(a)
      t.equal(versionOf(b), va, 'two reads with no change')
      const changed = t.success(await s.run.change(s.A, s.run.first, item.ref, va, 1), 'a change')
      t.ok(versionOf(changed) !== va, 'a change answers the same version as before')
    },
  },
  {
    id: 'FEAT-CORE-010',
    capability: null,
    async run(t: TestContext, s) {
      const item = await s.run.make(s.A, 'core-010')
      s.made.push({ ref: item.ref, at: Date.now() })
      t.success(await s.run.change(s.A, s.run.first, item.ref, item.version, 1), 'the first change')
      const stale = t.refused(
        await s.run.change(s.A, s.run.first, item.ref, item.version, 2),
        'version-mismatch',
        'a change with the version read before another'
      )
      t.ok(typeof stale.error.currentVersion === 'string', 'version-mismatch without currentVersion')
      const now = t.success(await s.run.read(s.A, s.run.first, item.ref), 'a read after')
      t.equal(versionOf(now), stale.error.currentVersion, 'currentVersion and the version read after')
    },
  },
  {
    id: 'FEAT-CORE-011',
    capability: null,
    async run(t: TestContext, s) {
      if (s.run.declaration.atomicWrites !== true) t.notApplicable('the server declares atomicWrites false')
      const item = await s.run.make(s.A, 'core-011')
      s.made.push({ ref: item.ref, at: Date.now() })
      let version = item.version
      for (let i = 0; i < 50; i++) {
        const [x, y] = await Promise.all([
          s.run.change(s.A, s.run.first, item.ref, version, 2 * i),
          s.run.change(s.A, s.run.first, item.ref, version, 2 * i + 1),
        ])
        const ok = [x, y].filter((o) => o.ok)
        const mismatch = [x, y].filter((o) => !o.ok && o.error.code === 'version-mismatch')
        t.ok(
          ok.length === 1 && mismatch.length === 1,
          `attempt ${i + 1}: ${ok.length} of two changes with one version succeeded`
        )
        version = versionOf((ok[0] as { content: Json }).content)
      }
    },
  },
  {
    id: 'FEAT-CORE-012',
    capability: null,
    async run(t: TestContext, s) {
      const p = s.run.profile
      const listed = new Map((await s.A.listTools()).map((x) => [String(x.name), x]))
      for (const tool of p.tools.filter((x) => x.located && (x.capability === null || has(s.run, x.capability)))) {
        const required =
          ((listed.get(tool.name)?.inputSchema as Json | undefined)?.required as string[] | undefined) ?? []
        t.ok(required.includes(p.location.argument), `${tool.name} does not require ${p.location.argument}`)
      }
      const item = await s.run.make(s.A, 'core-012')
      s.made.push({ ref: item.ref, at: Date.now() })
      const elsewhere = await s.run.read(s.A, s.run.second, item.ref)
      const nothing = await s.run.read(s.A, s.run.second, s.run.unknownRef)
      t.refused(nothing, 'not-found', 'a reference to no item')
      const e = t.refused(elsewhere, 'not-found', 'a reference of the first location, with the second as the location')
      const name = s.run.nameOf(item.ref)
      if (name) t.ok(!JSON.stringify(e.raw).includes(name), 'the error names the item')
    },
  },
  {
    id: 'FEAT-CORE-015',
    capability: null,
    async run(t: TestContext, s) {
      const p = s.run.profile
      const listOf = async (session: Session) => {
        const all: Json[] = []
        let cursor: string | undefined
        do {
          const page = t.success(await session.call(p.location.listTool, cursor ? { cursor } : {}), p.location.listTool)
          const member = Object.keys(page).find((k) => Array.isArray(page[k])) as string
          all.push(...((page[member] as Json[]) ?? []))
          cursor = page.nextCursor as string | undefined
        } while (cursor && all.length < 5000)
        return all
      }
      const mine = await listOf(s.A)
      for (const l of mine)
        for (const k of ['ref', 'title', 'writable', 'portable']) t.ok(l[k] !== undefined, `a location lacks ${k}`)
      const refs = new Set(mine.map((l) => l.ref))
      for (const [label, ref] of [
        ['the first location', s.run.first],
        ['the second location', s.run.second],
      ] as const) {
        if (refs.has(ref)) continue
        const path = label === 'the first location' ? locationPath(s, 'first') : locationPath(s, 'second')
        if (!path) t.ok(false, `${label} is not in A's list, and the run gives no path to look for it`)
        const found = t.success(
          await s.A.call(p.location.listTool, { query: path }),
          `${p.location.listTool} with a query`
        )
        const member = Object.keys(found).find((k) => Array.isArray(found[k])) as string
        t.ok(
          ((found[member] as Json[]) ?? []).some((l) => l.ref === ref),
          `${label} is not in A's list`
        )
      }
      const theirs = await listOf(s.B)
      const bOwn = theirs.find((l) => l.path === '/' || l.primary === true)
      if (bOwn) t.ok(!refs.has(bOwn.ref), "A's list holds B's own location")
      else t.note("B's own location was not found in B's list: its absence from A's is not tested")
    },
  },
  {
    id: 'FEAT-CORE-016',
    capability: null,
    async run(t: TestContext, s) {
      const limits = limitsOf(s.run.declaration)
      const many = await s.run.many(120)
      const size = Math.min(50, limits.page)
      const { seen, count } = await pages(t, s.A, many.tool, many.args, many.member, 50)
      for (const r of many.refs) t.equal(seen.filter((x) => x === r).length, 1, `item ${r} over the pages`)
      t.equal(
        count,
        Math.ceil(seen.length / size),
        `the pages of ${seen.length} items with limit 50 and page ${limits.page}`
      )
      const first = t.success(await s.A.call(many.tool, { ...many.args, limit: 50 }), 'the first page')
      const cursor = first.nextCursor as string | undefined
      t.ok(cursor, 'the first page of more than 50 items has no nextCursor')
      const other = s.run.listCall(s.run.second)
      t.refused(
        await s.A.call(other.tool, { ...other.args, cursor }),
        'bad-cursor',
        "the first page's cursor with another location"
      )
      t.refused(
        await s.A.call(many.tool, { ...many.args, cursor: 'not-a-cursor-of-this-server' }),
        'bad-cursor',
        'a cursor the server never gave'
      )
    },
  },
  {
    id: 'FEAT-CORE-018',
    capability: null,
    async run(t: TestContext, s) {
      const p = s.run.profile
      for (const x of await s.A.listTools()) {
        const tool = p.tools.find((y) => y.name === x.name)
        if (!tool) continue
        const hints = (x.annotations as Json | undefined) ?? {}
        const want = annotationsOf(tool.effect)
        t.equal(hints.readOnlyHint === true, want.readOnlyHint, `readOnlyHint of ${tool.name}`)
        if (tool.effect !== 'read')
          t.equal(hints.destructiveHint === true, want.destructiveHint, `destructiveHint of ${tool.name}`)
        if (tool.effect === 'write' || tool.effect === 'delete')
          t.ok(hints.destructiveHint !== undefined, `${tool.name} gives no destructiveHint`)
      }
    },
  },
  {
    id: 'FEAT-CORE-019',
    capability: null,
    async run(t: TestContext, s) {
      const p = s.run.profile
      const a = t.success(await s.A.call(p.location.listTool, {}), `${p.location.listTool} as A`)
      const b = t.success(await s.B.call(p.location.listTool, {}), `${p.location.listTool} as B`)
      t.ok(
        JSON.stringify(a) !== JSON.stringify(b),
        'A and B read the same list of locations: the call does not act for each account'
      )
      const call = s.run.listCall(s.run.first)
      t.refused(
        await s.A.call(call.tool, { ...call.args, password: 'not-a-real-password' }),
        'invalid-argument',
        'a credential given as an argument',
        'password'
      )
    },
  },
  {
    id: 'FEAT-CORE-020',
    capability: null,
    async run(t: TestContext, s) {
      const item = await s.run.make(s.A, 'core-020')
      s.made.push({ ref: item.ref, at: Date.now() })
      t.success(await s.run.read(s.A, s.run.first, item.ref), "A's read")
      const read = await s.run.read(s.B, s.run.first, item.ref)
      t.ok(!read.ok, 'B reads an item only A may read, right after A read it')
      t.ok(
        ['not-found', 'permission-denied'].includes(read.ok ? '' : read.error.code),
        `B's read answers ${read.ok ? 'ok' : read.error.code}`
      )
      const call = s.run.listCall(s.run.first)
      const list = await s.B.call(call.tool, call.args)
      if (list.ok) {
        const items = (list.content[call.member] as Json[]) ?? []
        t.ok(!items.some((i) => i.ref === item.ref), "B's list holds an item only A may read")
      }
    },
  },
  {
    id: 'FEAT-CORE-021',
    capability: null,
    async run(t: TestContext, s) {
      const logs = s.options.hooks?.logs
      if (!logs) t.manual('a connector keeps credentials out of its logs and stores: give the hook logs to test it')
      const text = await logs()
      for (const secret of secretsOf(s.options))
        t.ok(!text.includes(secret), 'a credential of the run is in what the provider logged or stored')
    },
  },
  {
    id: 'FEAT-CORE-022',
    capability: null,
    async run(t: TestContext, s) {
      if (s.run.profile.id !== 'org.ayni/files') t.notApplicable('Calendar 1.0 reads and writes no content of bytes')
      const limits = limitsOf(s.run.declaration)
      const big = Buffer.alloc(limits.writeBytes + 1, 0x41).toString('base64')
      const name = `${s.token}-too-large.bin`
      const out = t.refused(
        await s.A.call('files_create', { root: s.run.first, name, content: { base64: big } }),
        'too-large',
        'a create of writeBytes plus one byte'
      )
      t.equal(out.error.limitBytes, limits.writeBytes, 'limitBytes of the create')
      const list = t.success(await s.A.call('files_list', { root: s.run.first, limit: 100 }), 'a list after')
      t.ok(
        !((list.items as Json[]) ?? []).some((i) => i.name === name),
        'a create refused as too-large created the file'
      )
      if (limits.writeBytes <= limits.readBytes) {
        t.note(
          'writeBytes is not above readBytes: a file of readBytes plus one byte cannot be made through the profile, the read is not tested'
        )
        return
      }
      const image = Buffer.alloc(limits.readBytes + 1, 0)
      image.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      const made = t.success(
        await s.A.call('files_create', {
          root: s.run.first,
          name: `${s.token}-large.png`,
          content: { base64: image.toString('base64') },
        }),
        'a create of readBytes plus one byte'
      )
      const ref = String((made.item as Json).ref)
      s.made.push({ ref, at: Date.now() })
      const read = t.refused(
        await s.A.call('files_read', { root: s.run.first, ref }),
        'too-large',
        'a read of an image of readBytes plus one byte'
      )
      t.equal(read.error.limitBytes, limits.readBytes, 'limitBytes of the read')
    },
  },
  {
    id: 'FEAT-CORE-023',
    capability: null,
    async run(t: TestContext, s) {
      const v = parseVersion(s.run.declaration.version)
      const ours = parseVersion(s.run.profile.version)
      t.ok(v && ours && v.major === ours.major, `the server declares ${s.run.declaration.version}`)
      if (v && ours && v.minor > ours.minor)
        t.note(`the tests of ${s.run.profile.version} ran against a server of ${s.run.declaration.version}`)
      else
        t.note(
          `the server declares ${s.run.declaration.version}: the tests of ${s.run.profile.version} are those of its own version`
        )
    },
  },
  {
    id: 'FEAT-CORE-024',
    capability: null,
    async run(t: TestContext, s) {
      const hook = s.options.hooks?.askBeforeWrite
      t.ok(s.A.asked.length === 0, `the service asked ${s.A.asked.length} questions in a run where it asks nothing`)
      if (!hook) {
        t.note('no hook makes the service ask: the input request of a write is not tested')
        return
      }
      if (s.A.era === 'legacy')
        t.skip('an input request rides the multi-round-trip results of MCP 2026-07-28: run the kit with era modern')
      const item = await s.run.make(s.A, 'core-024')
      s.made.push({ ref: item.ref, at: Date.now() })
      await hook(true)
      try {
        s.A.answer = 'decline'
        const declined = await s.run.change(s.A, s.run.first, item.ref, item.version, 1)
        t.ok(s.A.asked.length > 0, 'a write against a service that asks answered no input request')
        t.refused(declined, 'permission-denied', 'a write whose question was declined')
        const after = t.success(await s.run.read(s.A, s.run.first, item.ref), 'a read after the decline')
        t.equal(versionOf(after), item.version, 'the version of an item after a declined write')
        s.A.answer = 'accept'
        t.success(
          await s.run.change(s.A, s.run.first, item.ref, item.version, 2),
          'a write whose question was accepted'
        )
      } finally {
        s.A.answer = 'decline'
        await hook(false)
        s.A.asked.length = 0
      }
    },
  },
  {
    id: 'FEAT-CORE-025',
    capability: null,
    async run(t: TestContext, s) {
      const id = s.run.profile.id
      const first = JSON.stringify((await s.A.extensions())[id])
      for (let i = 0; i < 9; i++)
        t.equal(JSON.stringify((await s.A.extensions())[id]), first, `declaration ${i + 2} of ten with A's credentials`)
      const b = (await s.B.extensions())[id] as Declared | undefined
      const a = JSON.parse(first) as Declared
      if (!b) {
        t.note('B is declared no such profile')
        return
      }
      const strip = (d: Declared) => {
        const { capabilities: _c, ...rest } = d
        const own = Object.fromEntries(
          Object.entries(rest).filter(([k]) => !capabilityNames(s.run.profile).includes(k))
        )
        return JSON.stringify(own)
      }
      t.equal(strip(b), strip(a), 'the declarations of A and B, but for their capabilities')
    },
  },
  {
    id: 'FEAT-CORE-026',
    capability: null,
    async run(t: TestContext, s) {
      const l = limitsOf(s.run.declaration)
      t.ok(
        l.page >= LEAST_LIMITS.page && l.readBytes >= LEAST_LIMITS.readBytes && l.writeBytes >= LEAST_LIMITS.writeBytes,
        `limits ${JSON.stringify(l)} below the least`
      )
      const call = s.run.listCall(s.run.first)
      for (const limit of [0, 101])
        t.refused(await s.A.call(call.tool, { ...call.args, limit }), 'invalid-argument', `limit ${limit}`, 'limit')
      if (l.page >= 50) {
        t.note(`limits.page is ${l.page}: the case of a page smaller than limit is not tested`)
        return
      }
      const many = await s.run.many(l.page + 10)
      const page = t.success(await s.A.call(many.tool, { ...many.args, limit: 50 }), 'a list with limit 50')
      t.equal(((page[many.member] as Json[]) ?? []).length, l.page, `a page with limit 50 and limits.page ${l.page}`)
      t.ok(page.nextCursor, 'no nextCursor on a page cut at limits.page')
    },
  },
  // the rules that hold for every answer of the run: read at the end from what the observer saw
  ...(['FEAT-CORE-006', 'FEAT-CORE-013', 'FEAT-CORE-017'] as const).map(
    (id): Test<CoreState> => ({
      id,
      capability: null,
      late: true,
      async run(t: TestContext, s) {
        const tally = s.observer.result(s.run.profile.id, id)
        t.ok(tally.violations.length === 0, tally.violations.join(' | '))
        t.ok(tally.seen > 0, 'no answer of the run was checked')
        t.note(`${tally.seen} answers checked`)
      },
    })
  ),
  {
    id: 'FEAT-CORE-008',
    capability: null,
    late: true,
    async run(t: TestContext, s) {
      t.ok(s.made.length > 0, 'the run made no item to read again')
      for (const m of s.made) {
        const out = await s.run.read(s.A, s.run.first, m.ref)
        t.success(out, `item ${m.ref}, read ${Math.round((Date.now() - m.at) / 1000)} s after it was made`)
        for (const secret of secretsOf(s.options)) t.ok(!m.ref.includes(secret), 'a reference holds a credential')
        t.ok(!/[?&](sig|signature|x-amz-signature|token|key)=/i.test(m.ref), 'a reference holds a signed address')
      }
      t.note('references read again at the end of the run, not an hour later')
    },
  },
  {
    id: 'FEAT-CORE-014',
    capability: null,
    async run(t: TestContext, s) {
      if (s.run.profile.id !== 'org.ayni/files') t.notApplicable('Calendar 1.0 has no destination and no link')
      const fixtures = s.options.files?.fixtures
      t.note('no argument of Files 1.0 gives a destination by path: the case of outside-location does not arise')
      if (has(s.run, 'folders')) {
        const item = await s.run.make(s.A, 'core-014')
        const secondList = t.success(
          await s.A.call('files_list', { root: s.run.second }),
          'a list of the second location'
        )
        const folder = ((secondList.items as Json[]) ?? []).find((i) => i.kind === 'folder')?.ref ?? s.run.second
        t.refused(
          await s.A.call('files_move', { root: s.run.first, ref: item.ref, toFolder: folder }),
          'not-found',
          'a move to a folder of the second location'
        )
        t.refused(
          await s.A.call('files_get', { root: s.run.first, ref: folder }),
          'not-found',
          'a read of that folder in the first location'
        )
        s.made.push({ ref: item.ref, at: Date.now() })
      } else t.note('no folders: the move is not tested')
      if (!fixtures?.link) {
        t.note('no fixture link: the shortcut is not tested')
        return
      }
      const got = t.success(
        await s.A.call('files_get', { root: s.run.first, ref: fixtures.link }),
        'a look at the link'
      )
      t.equal((got.item as Json).kind, 'link', 'the kind of a shortcut')
      t.refused(
        await s.A.call('files_read', { root: s.run.first, ref: fixtures.link }),
        ['not-found', 'not-supported'],
        'a read of a link'
      )
    },
  },
  {
    id: 'FEAT-CORE-019',
    capability: null,
    late: true,
    async run(t: TestContext, s) {
      const tally = s.observer.result(s.run.profile.id, 'FEAT-CORE-019')
      t.ok(tally.violations.length === 0, tally.violations.join(' | '))
      t.note(`${tally.seen} answers looked at for credentials`)
    },
  },
  {
    id: 'FEAT-CORE-007',
    capability: null,
    late: true,
    async run(t: TestContext, s) {
      const tally = s.observer.result(s.run.profile.id, 'FEAT-CORE-007')
      t.ok(tally.violations.length === 0, tally.violations.join(' | '))
      t.ok(tally.seen > 0, 'no error of the run was checked')
      t.note(`${tally.seen} checks of errors`)
    },
  },
]

function versionOf(content: Json): string {
  const x = (content.item ?? content.event ?? content) as Json
  return String(x.version)
}

function locationPath(s: CoreState, which: 'first' | 'second'): string | undefined {
  const files = s.options.files
  const calendar = s.options.calendar
  if (s.run.profile.id === 'org.ayni/files') return files?.[which].path
  return calendar?.[which].path
}

export function secretsOf(options: { accounts: RunState['options']['accounts'] }): string[] {
  const out = new Set<string>()
  for (const acc of [options.accounts.A, options.accounts.B, options.accounts.M]) {
    if (!acc) continue
    for (const v of Object.values(acc.headers)) {
      if (v.length >= 8) out.add(v)
      const parts = v.split(/\s+/)
      const last = parts[parts.length - 1]
      if (parts.length > 1 && last && last.length >= 8) out.add(last)
    }
    for (const v of acc.secrets ?? []) if (v.length >= 4) out.add(v)
  }
  return [...out]
}

/** Whether an exception is a call that answered no tool result. */
export function isCallFailed(error: unknown): boolean {
  return error instanceof CallFailed
}
