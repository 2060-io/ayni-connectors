/**
 * The connector's log: one JSON line per entry on standard output, at a level. What reaches it are the kit's fields
 * (a tool, an outcome, a time) and the connector's (an API, a method, a status, Google's reason): never a token, an
 * argument, an address or a content (FEAT-CORE-021, TOOL-OAUTH-018).
 */
import type { Logger } from '@ayni.org/ayni-provider-kit'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export function isLogLevel(value: string): value is LogLevel {
  return value in ORDER
}

export function jsonLogger(
  level: LogLevel = 'info',
  write: (line: string) => void = (line) => {
    process.stdout.write(`${line}\n`)
  }
): Logger {
  const at = (l: LogLevel) => (fields: Record<string, unknown>, message: string) => {
    if (ORDER[l] < ORDER[level]) return
    write(JSON.stringify({ time: new Date().toISOString(), level: l, message, ...fields }))
  }
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }
}
