#!/usr/bin/env node
/**
 * Runs the Google connector, configured by its environment: `RESOURCE_URL` (required: the MCP address as the agent
 * reaches it), `PORT` (8000), `HOST` (0.0.0.0), `LOG_LEVEL` (info), `ALLOWED_HOSTS` (the `Host` values answered,
 * comma-separated; all when absent) and `CURSOR_SECRET` (the key of cursors, for several replicas; random per process
 * when absent). It reaches Google's interfaces only: no variable changes where a token is sent.
 */
import { isLogLevel, jsonLogger, NAME, startGoogleConnector, VERSION } from './index.js'

function fail(message: string): never {
  process.stderr.write(`${NAME}: ${message}\n`)
  process.exit(2)
}

const env = process.env
const resourceUrl = env.RESOURCE_URL
if (!resourceUrl) fail('RESOURCE_URL is required: the address of /mcp as the agent reaches it')
try {
  const u = new URL(resourceUrl)
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme')
} catch {
  fail('RESOURCE_URL is not an http(s) address')
}
const level = env.LOG_LEVEL ?? 'info'
if (!isLogLevel(level)) fail('LOG_LEVEL is one of debug, info, warn, error')
const port = Number(env.PORT ?? 8000)
if (!Number.isInteger(port) || port < 0 || port > 65535) fail('PORT is not a port')
const allowedHosts = env.ALLOWED_HOSTS?.split(',')
  .map((h) => h.trim())
  .filter(Boolean)

const logger = jsonLogger(level)
const connector = await startGoogleConnector({
  resourceUrl,
  port,
  host: env.HOST ?? '0.0.0.0',
  logger,
  ...(env.CURSOR_SECRET ? { cursorSecret: env.CURSOR_SECRET } : {}),
  ...(allowedHosts?.length ? { allowedHosts } : {}),
})
logger.info({ version: VERSION, listen: connector.url, resource: resourceUrl }, `${NAME} started`)

const stop = () => {
  void connector.running.close().then(() => process.exit(0))
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
