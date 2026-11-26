/**
 * Where the connector may send an account's credentials (providers §1, FEAT-DAV-002 and 003): an `https` address of
 * the request, at a host that resolves to a public address unless the operator lists it, resolved once per request
 * and reached at the address that was checked.
 *
 * A person who types an address could point the connector at a machine of the operator's network: an address whose
 * host is, or resolves to, a loopback, private, link-local or otherwise special address is refused before anything is
 * sent, unless the operator lists that host (`DAV_HOSTS`). An operator may also take listed hosts only
 * (`DAV_HOSTS_ONLY`), the narrowest setting, for a deployment whose people reach one Nextcloud.
 */
import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { errors, type ProfileError } from '@ayni.org/ayni-provider-kit'

/** An address a host resolves to. */
export interface Resolved {
  address: string
  family: 4 | 6
}

/** Resolves a host name to its addresses (the system's resolver; a test's own). */
export type Resolve = (host: string) => Promise<Resolved[]>

export const systemResolve: Resolve = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => ({
    address: a.address,
    family: a.family === 6 ? 6 : 4,
  }))

/** What the operator allows. */
export interface HostPolicy {
  /** hosts the operator lists: reached even when they resolve to a private address (lower-case names, IP literals) */
  listed: ReadonlySet<string>
  /** reach listed hosts only */
  only: boolean
}

export const OPEN_POLICY: HostPolicy = { listed: new Set(), only: false }

/** A policy from the operator's lists, as the command line reads them. */
export function hostPolicy(listed: readonly string[] = [], only = false): HostPolicy {
  return { listed: new Set(listed.map((h) => normalizeHost(h)).filter(Boolean)), only }
}

/** A host as it is compared: lower case, without the brackets of an IPv6 literal. */
export function normalizeHost(host: string): string {
  const h = host.trim().toLowerCase()
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h
}

// Every range that is not a public unicast address: loopback, private, link-local, shared, documentation,
// benchmarking, multicast, reserved, and the IPv6 forms that carry an IPv4 address (checked through it, or refused).
const SPECIAL = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  SPECIAL.addSubnet(net, prefix, 'ipv4')
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['5f00::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const)
  SPECIAL.addSubnet(net, prefix, 'ipv6')

/** The IPv4 address an IPv4-mapped IPv6 address carries (`::ffff:10.0.0.5`, `::ffff:a00:5`). */
function mappedIpv4(address: string): string | undefined {
  const a = address.toLowerCase()
  const dotted = /^(?:0{0,4}:){0,4}:?:ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a)
  if (dotted?.[1]) return dotted[1]
  const hex = /^(?:0{0,4}:){0,4}:?:ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a)
  if (hex?.[1] && hex[2]) {
    const hi = Number.parseInt(hex[1], 16)
    const lo = Number.parseInt(hex[2], 16)
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
  }
  return undefined
}

/** Whether an address is a public unicast address, the only kind reached for a host the operator does not list. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !SPECIAL.check(address, 'ipv4')
  if (family === 6) {
    const v4 = mappedIpv4(address)
    if (v4) return isIP(v4) === 4 && !SPECIAL.check(v4, 'ipv4')
    return !SPECIAL.check(address, 'ipv6')
  }
  return false
}

/** The header that names an address, as an error names it (`field`). */
export type AddressHeader = 'Ayni-Nextcloud' | 'Ayni-Dav-Files' | 'Ayni-Dav-Calendars'

/**
 * An address of a request, checked for its form (FEAT-DAV-002): `https`, with a host, no user name or password in it,
 * no query and no fragment. Refused with `invalid-argument` naming the header; the message names no address.
 */
export function parseAddress(value: string, header: AddressHeader): URL | ProfileError {
  const refuse = (why: string) => errors.invalidArgument(header, `The address in ${header} ${why}.`)
  const text = value.trim()
  if (!text || text.length > 2048) return refuse('is empty or too long')
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return refuse('is not an address')
  }
  if (url.protocol !== 'https:') return refuse('is not an https address')
  if (!url.hostname) return refuse('has no host')
  if (url.username || url.password) return refuse('holds a user name or a password')
  if (url.search || url.hash || text.includes('?') || text.includes('#')) return refuse('holds a query or a fragment')
  return url
}

/**
 * The checked address of each host a request reaches, resolved once for the whole request (FEAT-DAV-003): every
 * address a host resolves to must be public, unless the operator lists the host; the connection then goes to the
 * first address that was checked, so that a second resolution cannot point it elsewhere.
 */
export class Pins {
  private readonly pinned = new Map<string, Promise<Resolved>>()

  public constructor(
    private readonly policy: HostPolicy,
    private readonly resolve: Resolve
  ) {}

  /** The address to connect to for a host of the request, or `invalid-argument` for a host the policy refuses. */
  public addressOf(host: string, header: AddressHeader): Promise<Resolved> {
    const h = normalizeHost(host)
    let p = this.pinned.get(h)
    if (!p) {
      p = this.check(h, header)
      this.pinned.set(h, p)
    }
    return p
  }

  private async check(host: string, header: AddressHeader): Promise<Resolved> {
    const refuse = () =>
      errors.invalidArgument(header, `The host of the address in ${header} is not one this connector may reach.`)
    const listed = this.policy.listed.has(host)
    if (this.policy.only && !listed) throw refuse()
    const literal = isIP(host)
    let addresses: Resolved[]
    if (literal) addresses = [{ address: host, family: literal === 6 ? 6 : 4 }]
    else {
      try {
        addresses = await this.resolve(host)
      } catch {
        throw errors.unavailable('The server of the account cannot be reached.')
      }
    }
    if (!addresses.length) throw errors.unavailable('The server of the account cannot be reached.')
    if (!listed && addresses.some((a) => !isPublicAddress(a.address))) throw refuse()
    return addresses[0] as Resolved
  }
}
