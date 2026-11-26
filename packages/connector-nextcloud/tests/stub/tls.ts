/**
 * A certificate authority of a test run and a server certificate it signs, made in memory with `node:crypto` (X.509 v3
 * in DER, ECDSA P-256 with SHA-256): the stub serves HTTPS under names of its own, and the connector checks them
 * against this authority alone. Nothing is written to disk; a second authority, never trusted, tests the refusal.
 */
import { createPrivateKey, generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto'
import { isIP } from 'node:net'

const tlv = (tag: number, content: Buffer): Buffer => {
  const n = content.length
  const len =
    n < 0x80
      ? Buffer.from([n])
      : n < 0x100
        ? Buffer.from([0x81, n])
        : n < 0x10000
          ? Buffer.from([0x82, n >> 8, n & 0xff])
          : Buffer.from([0x83, n >> 16, (n >> 8) & 0xff, n & 0xff])
  return Buffer.concat([Buffer.from([tag]), len, content])
}
const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items))
const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items))
const int = (bytes: Buffer) => tlv(0x02, (bytes[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes)
const bool = (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0]))
const octets = (b: Buffer) => tlv(0x04, b)
const bits = (b: Buffer, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), b]))
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'))
const explicit = (n: number, content: Buffer) => tlv(0xa0 + n, content)

function oid(text: string): Buffer {
  const arcs = text.split('.').map(Number)
  const out: number[] = [(arcs[0] as number) * 40 + (arcs[1] as number)]
  for (const a of arcs.slice(2)) {
    const stack: number[] = [a & 0x7f]
    let v = a >> 7
    while (v > 0) {
      stack.unshift((v & 0x7f) | 0x80)
      v >>= 7
    }
    out.push(...stack)
  }
  return tlv(0x06, Buffer.from(out))
}

function utcTime(d: Date): Buffer {
  const p = (n: number) => String(n).padStart(2, '0')
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  return tlv(0x17, Buffer.from(s, 'ascii'))
}

const name = (cn: string) => seq(set(seq(oid('2.5.4.3'), utf8(cn))))
const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'))

function ext(id: string, critical: boolean, value: Buffer): Buffer {
  return seq(oid(id), ...(critical ? [bool(true)] : []), octets(value))
}

function certificate(opts: {
  subject: string
  issuer: string
  publicKey: KeyObject
  signer: KeyObject
  ca: boolean
  names?: string[]
}): string {
  const now = Date.now()
  const extensions: Buffer[] = [
    ext('2.5.29.19', true, seq(...(opts.ca ? [bool(true)] : []))),
    // keyCertSign and cRLSign for the authority, digitalSignature for the server
    ext('2.5.29.15', true, opts.ca ? bits(Buffer.from([0x06]), 1) : bits(Buffer.from([0x80]), 7)),
  ]
  if (opts.names?.length) {
    const general = opts.names.map((n) =>
      isIP(n) === 4 ? tlv(0x87, Buffer.from(n.split('.').map(Number))) : tlv(0x82, Buffer.from(n, 'ascii'))
    )
    extensions.push(ext('2.5.29.17', false, seq(...general)))
    extensions.push(ext('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))))
  }
  const tbs = seq(
    explicit(0, int(Buffer.from([2]))),
    int(randomBytes(12)),
    ECDSA_SHA256,
    name(opts.issuer),
    seq(utcTime(new Date(now - 3_600_000)), utcTime(new Date(now + 7 * 86_400_000))),
    name(opts.subject),
    opts.publicKey.export({ type: 'spki', format: 'der' }),
    explicit(3, seq(...extensions))
  )
  const signature = sign('sha256', tbs, opts.signer)
  const der = seq(tbs, ECDSA_SHA256, bits(signature))
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n')
  return `-----BEGIN CERTIFICATE-----\n${b64}${b64.endsWith('\n') ? '' : '\n'}-----END CERTIFICATE-----\n`
}

export interface TestPki {
  /** the authority's certificate, which the connector is told to trust */
  ca: string
  /** the server's certificate and key */
  cert: string
  key: string
}

/** An authority and a server certificate for the names given (host names and IPv4 addresses). */
export function makePki(names: string[], label = 'Ayni test'): TestPki {
  const ca = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const leaf = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const caCert = certificate({
    subject: `${label} authority`,
    issuer: `${label} authority`,
    publicKey: ca.publicKey,
    signer: ca.privateKey,
    ca: true,
  })
  const cert = certificate({
    subject: names[0] ?? 'localhost',
    issuer: `${label} authority`,
    publicKey: leaf.publicKey,
    signer: ca.privateKey,
    ca: false,
    names,
  })
  const key = createPrivateKey(leaf.privateKey.export({ type: 'pkcs8', format: 'pem' })).export({
    type: 'pkcs8',
    format: 'pem',
  }) as string
  return { ca: caCert, cert, key }
}
