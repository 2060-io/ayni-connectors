/**
 * A stub of the servers the connector reaches, over HTTPS on 127.0.0.1 under names of its own: a Nextcloud
 * (`/remote.php/dav/`, OCS, the Team folders app) or a plain WebDAV and CalDAV server (`/dav/`), each part switched on
 * or off as a test needs. It records every request it receives, with its credentials, so that a test sees what was
 * sent and to whom; it can be stopped (every request answered 503) and made to redirect a path elsewhere.
 */
import { createServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { StubCalDav } from './caldav.js'
import { askedProps, StubFiles } from './files.js'
import { authenticate, davError, enc, key, multistatus, NS, type StubRequest, type StubResponse } from './http.js'
import { StubOcs } from './ocs.js'
import { Store, type User } from './store.js'
import { makePki, type TestPki } from './tls.js'

export interface StubOptions {
  /** a Nextcloud, or a plain WebDAV and CalDAV server */
  nextcloud?: boolean
  /** the names the stub is reached by, in its certificate */
  names?: string[]
  trashbin?: boolean
  versions?: boolean
  sharing?: boolean
  publicLinks?: boolean
  shareByMail?: boolean
  groupfolders?: boolean
  scheduling?: boolean
  noTimezone?: boolean
  /** a plain server: entity tags given and compared */
  etags?: boolean
  /** a plain server: SEARCH (RFC 5323) served */
  dasl?: boolean
  /** an authority and certificate of another run (a second stub that the same authority signs) */
  pki?: TestPki
}

export interface Recorded {
  method: string
  path: string
  host: string
  authorization?: string
  depth?: string
  ifMatch?: string
  ifNoneMatch?: string
  scheduleReply?: string
  body: string
}

export class DavStub {
  public readonly store = new Store()
  public readonly requests: Recorded[] = []
  public available = true
  /** a path whose request is answered with a redirection to an address elsewhere */
  public redirects = new Map<string, string>()
  /** the next writes of files answered `423 Locked`, as Nextcloud answers a write of a file another one holds */
  public lockedWrites = 0
  public readonly pki: TestPki
  public readonly o: Required<Omit<StubOptions, 'pki'>>
  private server?: Server
  private files: StubFiles
  private cal: StubCalDav
  private ocs: StubOcs
  public port = 0

  public constructor(options: StubOptions = {}) {
    const nc = options.nextcloud ?? true
    this.o = {
      nextcloud: nc,
      names: options.names ?? (nc ? ['cloud.test'] : ['dav.test']),
      trashbin: options.trashbin ?? nc,
      versions: options.versions ?? nc,
      sharing: options.sharing ?? nc,
      publicLinks: options.publicLinks ?? nc,
      shareByMail: options.shareByMail ?? nc,
      groupfolders: options.groupfolders ?? nc,
      scheduling: options.scheduling ?? nc,
      noTimezone: options.noTimezone ?? false,
      etags: options.etags ?? true,
      dasl: options.dasl ?? false,
    }
    this.pki = options.pki ?? makePki([...this.o.names, 'other.test', '127.0.0.1'])
    const dav = nc ? '/remote.php/dav/' : '/dav/'
    this.files = new StubFiles(
      this.store,
      {
        nextcloud: nc,
        trashbin: this.o.trashbin,
        versions: this.o.versions,
        etags: nc || this.o.etags,
        dasl: this.o.dasl,
      },
      `${dav}files/`
    )
    this.cal = new StubCalDav(this.store, {
      scheduling: this.o.scheduling,
      noTimezone: this.o.noTimezone,
      dav,
      principals: nc ? `${dav}principals/users/` : `${dav}principals/`,
    })
    this.ocs = new StubOcs(this.store, {
      trashbin: this.o.trashbin,
      versions: this.o.versions,
      sharing: this.o.sharing,
      publicLinks: this.o.publicLinks,
      shareByMail: this.o.shareByMail,
      groupfolders: this.o.groupfolders,
      origin: () => `${this.o.names[0]}:${this.port}`,
    })
  }

  /** The address of the stub under its first name, or another. */
  public origin(name = this.o.names[0] as string): string {
    return `https://${name}:${this.port}`
  }

  public async start(port = 0): Promise<void> {
    this.server = createServer({ key: this.pki.key, cert: this.pki.cert }, (req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const body = Buffer.concat(chunks)
        const headers: Record<string, string> = {}
        for (const [k, v] of Object.entries(req.headers))
          if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v
        const url = new URL(req.url ?? '/', `https://${headers.host ?? 'stub.invalid'}`)
        this.requests.push({
          method: req.method ?? 'GET',
          path: url.pathname,
          host: url.hostname,
          ...(headers.authorization ? { authorization: headers.authorization } : {}),
          ...(headers.depth ? { depth: headers.depth } : {}),
          ...(headers['if-match'] ? { ifMatch: headers['if-match'] } : {}),
          ...(headers['if-none-match'] ? { ifNoneMatch: headers['if-none-match'] } : {}),
          ...(headers['schedule-reply'] ? { scheduleReply: headers['schedule-reply'] } : {}),
          body: body.toString('utf8'),
        })
        let out: StubResponse
        try {
          out = this.route({ method: req.method ?? 'GET', url, parts: [], headers, body })
        } catch (e) {
          out = davError(500, 'ServiceUnavailable', String((e as Error).message))
        }
        res.writeHead(out.status, out.headers ?? {})
        res.end(out.body ?? '')
      })
    })
    await new Promise<void>((resolve) => this.server?.listen(port, '127.0.0.1', () => resolve()))
    this.port = (this.server.address() as AddressInfo).port
  }

  public async stop(): Promise<void> {
    if (!this.server) return
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server?.close(() => resolve()))
  }

  /** The requests with credentials, for the tests of where they went (FEAT-DAV-002, FEAT-CORE-021). */
  public credentialed(): Recorded[] {
    return this.requests.filter((r) => r.authorization)
  }

  private route(req: StubRequest): StubResponse {
    if (!this.available) return davError(503, 'ServiceUnavailable', 'The server is stopped')
    const path = req.url.pathname
    const redirect = this.redirects.get(path)
    if (redirect) return { status: 302, headers: { location: redirect } }
    const dav = this.o.nextcloud ? '/remote.php/dav/' : '/dav/'
    if (path === '/.well-known/caldav') return { status: 301, headers: { location: `${this.origin()}${dav}` } }
    const signedIn = authenticate(this.store, req.headers.authorization)
    if (!signedIn)
      return { ...davError(401, 'NotAuthenticated'), headers: { 'www-authenticate': 'Basic realm="Stub"' } }
    const user = signedIn.user
    req.user = user
    req.appPassword = signedIn.appPassword
    if (this.o.nextcloud && (path.startsWith('/ocs/') || path.startsWith('/index.php/'))) {
      const out = this.ocs.handle(req)
      if (out) return out
      return davError(404, 'NotFound')
    }
    if (!path.startsWith(dav) && `${path}/` !== dav) return davError(404, 'NotFound')
    const parts = path
      .slice(dav.length)
      .split('/')
      .filter(Boolean)
      .map((p) => decodeURIComponent(p))
    if (!parts.length) return this.root(req, user)
    const [area, owner, ...below] = parts
    if (area === 'files' && this.lockedWrites > 0 && ['PUT', 'MOVE', 'DELETE'].includes(req.method)) {
      this.lockedWrites--
      return davError(423, 'Locked', 'The file is locked')
    }
    if (area === 'files' && owner === user.id) return this.files.handle(req, below)
    if (area === 'calendars' && owner === user.id) return this.cal.handle(req, user, below)
    if (this.o.nextcloud && area === 'principals' && owner === 'users' && below[0] === user.id)
      return this.principal(req, user)
    if (!this.o.nextcloud && area === 'principals' && owner === user.id) return this.principal(req, user)
    if (this.o.nextcloud && area === 'trashbin' && owner === user.id && this.o.trashbin)
      return this.files.trashbin(req, user, below)
    if (this.o.nextcloud && area === 'versions' && owner === user.id && this.o.versions)
      return this.files.versions(req, user, below)
    return davError(404, 'NotFound')
  }

  /** The DAV root: the principal of the user, and Nextcloud's SEARCH. */
  private root(req: StubRequest, user: User): StubResponse {
    if (req.method === 'SEARCH' && this.o.nextcloud) return this.files.search(req, user)
    if (req.method === 'OPTIONS')
      return {
        status: 200,
        headers: {
          dav: '1, 3, access-control, calendar-access',
          ...(this.o.nextcloud ? { dasl: '<DAV:basicsearch>' } : {}),
        },
      }
    if (req.method !== 'PROPFIND') return davError(405, 'MethodNotAllowed')
    const dav = this.o.nextcloud ? '/remote.php/dav/' : '/dav/'
    const principal = this.o.nextcloud ? `${dav}principals/users/${enc(user.id)}/` : `${dav}principals/${enc(user.id)}/`
    return multistatus(
      [
        {
          href: dav,
          values: new Map([
            [key(NS.D, 'current-user-principal'), `<d:href>${principal}</d:href>`],
            [key(NS.D, 'resourcetype'), '<d:collection/>'],
          ]),
        },
      ],
      askedProps(req.body)
    )
  }

  private principal(req: StubRequest, user: User): StubResponse {
    if (req.method !== 'PROPFIND') return davError(405, 'MethodNotAllowed')
    const dav = this.o.nextcloud ? '/remote.php/dav/' : '/dav/'
    const href = this.o.nextcloud ? `${dav}principals/users/${enc(user.id)}/` : `${dav}principals/${enc(user.id)}/`
    return multistatus([{ href, values: this.cal.principalProps(user) }], askedProps(req.body))
  }

  // ---- seeding, for the tests ---------------------------------------------------------------------------------

  public addUser(u: { id: string; email?: string; name: string; password: string; groups?: string[] }): User {
    const user = this.store.addUser(u)
    this.store.calendar(u.id, 'personal', 'Personal')
    return user
  }

  public folder(uid: string, parts: string[]): number {
    let e = this.store.resolve(uid, [])
    for (const p of parts) {
      const next = this.store.resolve(uid, [...(e?.parts ?? []), p])
      if (next) e = next
      else if (e) {
        this.store.node(p, true, e.node.owner, e.node)
        e = this.store.resolve(uid, [...e.parts, p])
      }
    }
    if (!e) throw new Error('no such user')
    return e.node.id
  }

  public file(uid: string, parts: string[], content: string | Buffer): number {
    const parent = this.store.resolve(uid, parts.slice(0, -1))
    if (!parent) throw new Error('no such folder')
    const n = this.store.node(parts[parts.length - 1] as string, false, parent.node.owner, parent.node)
    n.content = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    this.store.touch(n)
    return n.id
  }

  /** A share of an item of a user's tree with another user, as made at the server. */
  public shareWith(owner: string, parts: string[], to: string, permissions: number): void {
    const e = this.store.resolve(owner, parts)
    if (!e) throw new Error('no such item')
    this.store.share({
      owner,
      node: e.node,
      type: 0,
      shareWith: to,
      permissions,
      note: '',
      mailSend: false,
      target: [e.node.name],
    })
  }

  public messagesTo(address: string) {
    return this.store.messages.filter((m) => m.to.toLowerCase() === address.toLowerCase())
  }
}
