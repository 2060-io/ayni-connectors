#!/usr/bin/env node
/**
 * Runs the in-memory provider on HTTP, with the fictional accounts of `demoUsers`, and prints the endpoint and each
 * account's bearer token: a provider of Files and Calendar to point a client at, or the conformance kit's CLI.
 */
import { parseArgs } from 'node:util'
import { startMemoryProvider } from './index.js'

const { values } = parseArgs({ options: { port: { type: 'string' }, host: { type: 'string' } } })
const provider = await startMemoryProvider({ port: Number(values.port ?? 8000), host: values.host ?? '127.0.0.1' })
process.stdout.write(`ayni-provider-memory on ${provider.url}\n`)
for (const u of provider.service.users) process.stdout.write(`  ${u.email}  Authorization: Bearer ${u.token}\n`)
const stop = () => {
  void provider.running.close().then(() => process.exit(0))
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
