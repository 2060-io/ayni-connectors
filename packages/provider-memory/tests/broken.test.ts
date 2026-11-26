/**
 * The conformance kit against a provider broken on purpose: it must fail the requirements the provider breaks, so
 * that a pass of a real provider means something.
 */
import { runConformance } from '@ayni.org/ayni-conformance'
import { bearerAccount, createProviderHandler, type FilesProvider, serve } from '@ayni.org/ayni-provider-kit'
import { MemoryFiles, MemoryService, type MemoryUser } from '@ayni.org/ayni-provider-memory'
import { expect, it } from 'vitest'
import { demoUsers } from '../src/index.js'
import { conformanceSetup } from '../src/setup.js'

it('fails a provider that drops cursors, writes instants with an offset and ignores ifVersion', async () => {
  const service = new MemoryService(demoUsers())
  const files = new MemoryFiles(service, { capabilities: ['folders'] })
  const broken = (): FilesProvider<MemoryUser> => {
    const p = files.provider()
    return {
      ...p,
      list: async (args, ctx) => {
        const { nextCursor: _dropped, ...rest } = await p.list(args, ctx)
        return rest
      },
      get: async (args, ctx) => {
        const r = await p.get(args, ctx)
        return { item: { ...r.item, modifiedAt: '2027-01-01T10:00:00+01:00' } }
      },
      replace: async (args, ctx) => {
        const current = await p.get({ root: args.root, ref: args.ref }, ctx)
        return p.replace({ ...args, ifVersion: current.item.version as string }, ctx)
      },
    }
  }
  const bearer = bearerAccount()
  const handler = createProviderHandler<MemoryUser>({
    name: 'broken',
    version: '0.0.0',
    validateResults: false,
    readAccount: async (request) => {
      const b = await bearer(request)
      const user = b ? service.userByToken(b.data.token) : undefined
      return b && user ? { id: b.id, secrets: b.secrets, data: user } : undefined
    },
    files: () => broken(),
  })
  const running = await serve(handler)
  try {
    const options = conformanceSetup({ handler, service, files }, running.url)
    const report = await runConformance(options)
    const failed = new Set(report.results.filter((r) => r.status === 'fail').map((r) => r.id))
    expect(report.passed).toBe(false)
    for (const id of ['FEAT-CORE-010', 'FEAT-CORE-011', 'FEAT-CORE-016', 'FEAT-CORE-017'])
      expect(failed, id).toContain(id)
    // what the provider does not break still passes
    for (const id of ['FEAT-CORE-002', 'FEAT-CORE-005', 'FEAT-CORE-018', 'FEAT-FILES-007'])
      expect(failed, id).not.toContain(id)
  } finally {
    await running.close()
  }
})
