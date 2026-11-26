#!/usr/bin/env node
/**
 * Runs the Nextcloud connector, configured by its environment (README): `PORT` (8000), `HOST` (0.0.0.0), `LOG_LEVEL`
 * (info), `ALLOWED_HOSTS` (the `Host` values answered, comma-separated; all when absent), `CURSOR_SECRET` (the key of
 * cursors, for several replicas), `DAV_HOSTS` (the hosts the operator lists, reached even at a private address,
 * comma-separated), `DAV_HOSTS_ONLY` (`true`: those hosts alone) and `DAV_TIMEOUT_MS` (30000). A server of the
 * operator's own certificate authority is trusted with Node's `NODE_EXTRA_CA_CERTS`. No variable holds an account.
 */
import { hostPolicy, isLogLevel, jsonLogger, NAME, startNextcloudConnector, VERSION } from './index.js'

function fail(message: string): never {
  process.stderr.write(`${NAME}: ${message}\n`)
  process.exit(2)
}

const env = process.env
const list = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
const level = env.LOG_LEVEL ?? 'info'
if (!isLogLevel(level)) fail('LOG_LEVEL is one of debug, info, warn, error')
const port = Number(env.PORT ?? 8000)
if (!Number.isInteger(port) || port < 0 || port > 65535) fail('PORT is not a port')
const only = (env.DAV_HOSTS_ONLY ?? 'false').toLowerCase()
if (only !== 'true' && only !== 'false') fail('DAV_HOSTS_ONLY is true or false')
const davHosts = list(env.DAV_HOSTS)
if (only === 'true' && davHosts.length === 0) fail('DAV_HOSTS_ONLY is true but DAV_HOSTS lists no host')
const timeoutMs = Number(env.DAV_TIMEOUT_MS ?? 30000)
if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) fail('DAV_TIMEOUT_MS is a number of milliseconds, 1000 or more')
const allowedHosts = list(env.ALLOWED_HOSTS)

const logger = jsonLogger(level)
const connector = await startNextcloudConnector({
  port,
  host: env.HOST ?? '0.0.0.0',
  logger,
  policy: hostPolicy(davHosts, only === 'true'),
  timeoutMs,
  ...(env.CURSOR_SECRET ? { cursorSecret: env.CURSOR_SECRET } : {}),
  ...(allowedHosts.length ? { allowedHosts } : {}),
})
logger.info(
  { version: VERSION, listen: connector.url, listedHosts: davHosts.length, hostsOnly: only === 'true' },
  `${NAME} started`
)

const stop = () => {
  void connector.running.close().then(() => process.exit(0))
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
