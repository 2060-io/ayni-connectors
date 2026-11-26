/**
 * The account of a request (providers §1, FEAT-DAV-001): the headers `Ayni-Nextcloud`, `Ayni-Dav-Files`,
 * `Ayni-Dav-Calendars`, `Ayni-Dav-Username` and `Ayni-Dav-Password`, and nothing else of the request. Files is declared
 * to a request that names a Nextcloud or a WebDAV folder, Calendar to one that names a Nextcloud or a CalDAV server;
 * what the request lacks or gets wrong is answered by every call (`account-refused`, `invalid-argument`).
 */
import { type Account, type AccountReader, errors, headerAccount, type ProfileError } from '@ayni.org/ayni-provider-kit'
import type { Credentials } from './http.js'
import { type AddressHeader, parseAddress } from './net.js'

export const ACCOUNT_HEADERS = [
  'Ayni-Nextcloud',
  'Ayni-Dav-Files',
  'Ayni-Dav-Calendars',
  'Ayni-Dav-Username',
  'Ayni-Dav-Password',
] as const

/** The password is the secret: kept out of every answer and log. The addresses and the user name are the account's key. */
export const SECRET_HEADERS = ['Ayni-Dav-Password'] as const

export type DavAccountData = Record<string, string>

/** The reader of the kit for these headers. */
export function davAccount(): AccountReader<DavAccountData> {
  return headerAccount(ACCOUNT_HEADERS, SECRET_HEADERS)
}

export type FilesTarget = { kind: 'nextcloud'; base: URL } | { kind: 'webdav'; folder: URL }
export type CalendarTarget = { kind: 'nextcloud'; base: URL } | { kind: 'caldav'; address: URL }

/** What a request reaches, as its headers say. */
export interface Target {
  /** present when the request names a store of files: Files is declared */
  files?: FilesTarget
  /** present when the request names a calendar server: Calendar is declared */
  calendar?: CalendarTarget
  credentials?: Credentials
  /** the origins credentials may go to, each with the header that named it */
  origins: { origin: string; header: AddressHeader }[]
  /** what every call answers instead of acting: no credentials, an address refused */
  problem?: ProfileError
}

const header = (data: DavAccountData, name: string) => {
  const v = data[name.toLowerCase()]
  return v === undefined ? undefined : v.trim()
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
const CONTROL = /[\u0000-\u001f\u007f]/

/** A Nextcloud's base address: its path without a final `/` (`https://example.org/cloud`). */
function nextcloudBase(url: URL): URL {
  const u = new URL(url.toString())
  u.pathname = u.pathname.replace(/\/+$/, '')
  return u
}

/** A collection's address: its path with a final `/`. */
function collection(url: URL): URL {
  const u = new URL(url.toString())
  if (!u.pathname.endsWith('/')) u.pathname = `${u.pathname}/`
  return u
}

/** Reads what a request reaches from the account's headers. */
export function targetOf(account: Account<DavAccountData> | undefined): Target {
  const data = account?.data ?? {}
  const nc = header(data, 'Ayni-Nextcloud')
  const files = header(data, 'Ayni-Dav-Files')
  const cals = header(data, 'Ayni-Dav-Calendars')
  const out: Target = { origins: [] }
  let problem: ProfileError | undefined
  const note = (e: ProfileError) => {
    problem ??= e
  }

  const parse = (value: string, name: AddressHeader): URL | undefined => {
    const u = parseAddress(value, name)
    if (u instanceof URL) {
      out.origins.push({ origin: u.origin, header: name })
      return u
    }
    note(u)
    return undefined
  }

  // the credentials first: a call without them is refused whatever else it carries (FEAT-DAV-001)
  const username = header(data, 'Ayni-Dav-Username')
  const password = data['ayni-dav-password']
  if (!username || !password)
    note(errors.accountRefused('The request carries no user name or no password of the account.'))
  else if (username.includes(':') || CONTROL.test(username) || CONTROL.test(password))
    note(errors.accountRefused('The user name or the password of the request cannot be sent to the server.'))
  else out.credentials = { username, password }

  if (nc !== undefined) {
    if (files !== undefined || cals !== undefined)
      note(
        errors.invalidArgument(
          files !== undefined ? 'Ayni-Dav-Files' : 'Ayni-Dav-Calendars',
          'Give Ayni-Nextcloud, or the addresses of Ayni-Dav-Files and Ayni-Dav-Calendars, not both.'
        )
      )
    const u = parse(nc, 'Ayni-Nextcloud')
    const base = u ? nextcloudBase(u) : new URL('https://nextcloud.invalid')
    out.files = { kind: 'nextcloud', base }
    out.calendar = { kind: 'nextcloud', base }
  } else {
    if (files !== undefined) {
      const u = parse(files, 'Ayni-Dav-Files')
      out.files = { kind: 'webdav', folder: u ? collection(u) : new URL('https://webdav.invalid/') }
    }
    if (cals !== undefined) {
      const u = parse(cals, 'Ayni-Dav-Calendars')
      out.calendar = { kind: 'caldav', address: u ? collection(u) : new URL('https://caldav.invalid/') }
    }
  }
  if (problem) out.problem = problem
  return out
}
