/**
 * The stub's WebDAV of files (RFC 4918), as a Nextcloud answers it under `/remote.php/dav/files/{user}/` (its file ids,
 * permissions, mounts, shares, trash bin, versions and SEARCH, RFC 5323, under `/remote.php/dav/`) or as a plain server
 * answers it under `/dav/files/{user}/` (entity tags and SEARCH as configured). What Nextcloud 35 was seen to do is done
 * here: a PUT into a missing folder answers 404, a type comes from the name's extension, a DELETE goes to the trash bin,
 * a restore whose name is taken renames the item, and two changes within a second keep one version.
 */
import { childOf, childrenOf, parseXml, textOf, type XmlElement } from '../../src/xml.js'
import {
  davError,
  enc,
  hrefOf,
  httpDate,
  key,
  multistatus,
  NS,
  type Prop,
  type PropResource,
  type StubRequest,
  type StubResponse,
} from './http.js'
import type { Entry, FNode, Store, TrashItem, User } from './store.js'

export interface FilesOptions {
  nextcloud: boolean
  trashbin: boolean
  versions: boolean
  /** a plain server: whether it gives entity tags and compares them */
  etags: boolean
  /** a plain server: whether it serves SEARCH */
  dasl: boolean
}

const TYPES: Record<string, string> = {
  md: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
  csv: 'text/csv',
  html: 'text/html',
  xml: 'application/xml',
  ics: 'text/calendar',
  png: 'image/png',
  jpg: 'image/jpeg',
  pdf: 'application/pdf',
  bin: 'application/octet-stream',
}

/** Nextcloud's type of a name: from its extension alone (a name with none is `application/octet-stream`). */
export function typeByName(name: string): string {
  const dot = name.lastIndexOf('.')
  return (dot > 0 && TYPES[name.slice(dot + 1).toLowerCase()]) || 'application/octet-stream'
}

function permString(e: Entry): string {
  const p = e.perms
  let s = ''
  if (e.mount?.type === 'shared') s += 'S'
  if (e.mount?.type === 'group') s += 'M'
  if (p & 16) s += 'R'
  s += 'G'
  if (p & 8) s += 'D'
  if (p & 2) s += 'NV'
  if (e.node.folder) {
    if (p & 4) s += 'CK'
  } else if (p & 2) s += 'W'
  return s
}

/** The properties of an entry of a user's tree. */
export function fileProps(store: Store, user: User, e: Entry, o: FilesOptions): Map<string, string> {
  const n = e.node
  const v = new Map<string, string>()
  v.set(key(NS.D, 'resourcetype'), n.folder ? '<d:collection/>' : '')
  v.set(key(NS.D, 'displayname'), xmlEscape(e.parts[e.parts.length - 1] ?? user.id))
  v.set(key(NS.D, 'getlastmodified'), httpDate(n.mtime))
  if (o.nextcloud) v.set(key(NS.D, 'creationdate'), '1970-01-01T00:00:00+00:00')
  else v.set(key(NS.D, 'creationdate'), new Date(n.ctime).toISOString().replace('.000Z', 'Z'))
  if (o.nextcloud || o.etags) v.set(key(NS.D, 'getetag'), xmlEscape(n.etag))
  if (!n.folder) {
    v.set(key(NS.D, 'getcontentlength'), String(n.content.length))
    v.set(key(NS.D, 'getcontenttype'), o.nextcloud ? typeByName(n.name) : (n.type ?? 'application/octet-stream'))
  }
  if (o.nextcloud) {
    v.set(key(NS.OC, 'fileid'), String(n.id))
    v.set(key(NS.OC, 'permissions'), permString(e))
    v.set(key(NS.NC, 'mount-type'), e.mount ? e.mount.type : '')
    v.set(key(NS.NC, 'is-mount-root'), e.mountRoot ? 'true' : 'false')
    const types = store.shares.filter((s) => s.owner === user.id && s.node === n).map((s) => s.type)
    v.set(key(NS.OC, 'share-types'), [...new Set(types)].map((t) => `<oc:share-type>${t}</oc:share-type>`).join(''))
    v.set(key(NS.NC, 'creation_time'), '0')
    v.set(key(NS.OC, 'owner-display-name'), xmlEscape(store.users.get(n.owner)?.name ?? ''))
  } else {
    const privs = [
      'read',
      ...(e.perms & 2 ? ['write', 'write-content', 'write-properties'] : []),
      ...(e.perms & 4 ? ['bind', 'unbind'] : []),
    ]
    v.set(key(NS.D, 'current-user-privilege-set'), privs.map((p) => `<d:privilege><d:${p}/></d:privilege>`).join(''))
  }
  return v
}

function xmlEscape(s: string): string {
  return s.replace(/[<>&"']/g, (c) => `&${{ '<': 'lt', '>': 'gt', '&': 'amp', '"': 'quot', "'": 'apos' }[c]};`)
}

/** The properties a PROPFIND asks, or `all`. */
export function askedProps(body: Buffer): Prop[] | 'all' {
  if (!body.length) return 'all'
  const root = parseXml(body.toString('utf8'))
  const prop = childOf(root, NS.D, 'prop')
  if (!prop) return 'all'
  return childrenOf(prop).map((p) => [p.ns, p.name] as const)
}

/** Whether a request's preconditions hold (RFC 7232): `If-Match` and `If-None-Match` against an entity tag. */
export function preconditions(req: StubRequest, current: string | undefined, compare: boolean): boolean {
  if (!compare) return true
  const ifMatch = req.headers['if-match']
  const ifNone = req.headers['if-none-match']
  if (ifMatch !== undefined) {
    if (current === undefined) return false
    if (
      ifMatch.trim() !== '*' &&
      !ifMatch
        .split(',')
        .map((x) => x.trim())
        .includes(current)
    )
      return false
  }
  if (ifNone !== undefined) {
    if (ifNone.trim() === '*' && current !== undefined) return false
    if (
      current !== undefined &&
      ifNone
        .split(',')
        .map((x) => x.trim())
        .includes(current)
    )
      return false
  }
  return true
}

export class StubFiles {
  public constructor(
    private readonly store: Store,
    private readonly o: FilesOptions,
    /** the path of the files of a user (`/remote.php/dav/files/` or `/dav/files/`), the user id after it */
    private readonly base: string
  ) {}

  private home(user: User): string {
    return `${this.base}${enc(user.id)}/`
  }

  private resource(user: User, e: Entry): PropResource {
    return { href: hrefOf(this.home(user), e.parts, e.node.folder), values: fileProps(this.store, user, e, this.o) }
  }

  /** A request under `{base}{user}/`: the parts below the user's folder, or a refusal. */
  public handle(req: StubRequest, below: string[]): StubResponse {
    const user = req.user as User
    const m = req.method
    if (m === 'OPTIONS')
      return {
        status: 200,
        headers: {
          dav: '1, 3, extended-mkcol',
          allow: 'OPTIONS, GET, HEAD, DELETE, PROPFIND, PUT, PROPPATCH, COPY, MOVE, REPORT',
          ...(this.o.dasl || this.o.nextcloud ? { dasl: '<DAV:basicsearch>' } : {}),
        },
      }
    if (m === 'PROPFIND') return this.propfind(req, user, below)
    if (m === 'GET' || m === 'HEAD') return this.get(user, below, m === 'HEAD')
    if (m === 'PUT') return this.put(req, user, below)
    if (m === 'MKCOL') return this.mkcol(user, below)
    if (m === 'DELETE') return this.delete(req, user, below)
    if (m === 'MOVE') return this.move(req, user, below)
    if (m === 'SEARCH' && !this.o.nextcloud && this.o.dasl) return this.search(req, user)
    return davError(405, 'MethodNotAllowed')
  }

  private propfind(req: StubRequest, user: User, parts: string[]): StubResponse {
    const depth = req.headers.depth ?? 'infinity'
    if (depth !== '0' && depth !== '1') return davError(403, 'Forbidden', 'Depth infinity is not served')
    const e = this.store.resolve(user.id, parts)
    if (!e) return davError(404, 'NotFound')
    const asked = askedProps(req.body)
    const out = [this.resource(user, e)]
    if (depth === '1' && e.node.folder)
      for (const c of this.store.children(user.id, e)) out.push(this.resource(user, c))
    return multistatus(out, asked)
  }

  private get(user: User, parts: string[], head: boolean): StubResponse {
    const e = this.store.resolve(user.id, parts)
    if (!e) return davError(404, 'NotFound')
    if (e.node.folder) return davError(501, 'NotImplemented')
    return {
      status: 200,
      headers: {
        'content-type': this.o.nextcloud ? typeByName(e.node.name) : (e.node.type ?? 'application/octet-stream'),
        ...(this.o.nextcloud || this.o.etags ? { etag: e.node.etag } : {}),
      },
      body: head ? '' : e.node.content,
    }
  }

  private nameRefused(name: string): boolean {
    return this.o.nextcloud && (/[\\\n]/.test(name) || name === '.htaccess' || /\.(part|filepart)$/.test(name))
  }

  private put(req: StubRequest, user: User, parts: string[]): StubResponse {
    if (!parts.length) return davError(405, 'MethodNotAllowed')
    const name = parts[parts.length - 1] as string
    if (this.nameRefused(name)) return davError(400, 'BadRequest', 'This name is not allowed')
    const parent = this.store.resolve(user.id, parts.slice(0, -1))
    if (!parent?.node.folder) return davError(this.o.nextcloud ? 404 : 409, this.o.nextcloud ? 'NotFound' : 'Conflict')
    const e = this.store.resolve(user.id, parts)
    if (e?.node.folder) return davError(405, 'MethodNotAllowed')
    const compare = this.o.nextcloud || this.o.etags
    if (!preconditions(req, e?.node.etag, compare)) return davError(412, 'PreconditionFailed')
    if (e ? !(e.perms & 2) : !(parent.perms & 4)) return davError(403, 'Forbidden')
    const mtime =
      req.headers['x-oc-mtime'] && /^\d+$/.test(req.headers['x-oc-mtime'])
        ? Number(req.headers['x-oc-mtime']) * 1000
        : Date.now()
    let node: FNode
    if (e) {
      node = e.node
      if (this.o.nextcloud && this.o.versions) {
        const ts = Math.floor(node.mtime / 1000)
        node.versions = node.versions.filter((x) => x.ts !== ts)
        node.versions.push({ ts, content: node.content, author: user.id })
      }
    } else node = this.store.node(name, false, parent.node.owner, parent.node)
    node.content = req.body
    const type = req.headers['content-type']?.split(';')[0]?.trim()
    if (type) node.type = type
    this.store.touch(node, mtime)
    return {
      status: e ? 204 : 201,
      headers: {
        ...(compare ? { etag: node.etag } : {}),
        ...(this.o.nextcloud ? { 'oc-fileid': `${String(node.id).padStart(8, '0')}ocstub`, 'oc-etag': node.etag } : {}),
      },
    }
  }

  private mkcol(user: User, parts: string[]): StubResponse {
    if (!parts.length) return davError(405, 'MethodNotAllowed')
    const name = parts[parts.length - 1] as string
    if (this.nameRefused(name)) return davError(400, 'BadRequest')
    if (this.store.resolve(user.id, parts))
      return davError(405, 'MethodNotAllowed', 'The resource you tried to create already exists')
    const parent = this.store.resolve(user.id, parts.slice(0, -1))
    if (!parent?.node.folder) return davError(409, 'Conflict')
    if (!(parent.perms & 4)) return davError(403, 'Forbidden')
    const n = this.store.node(name, true, parent.node.owner, parent.node)
    this.store.touch(n)
    return { status: 201 }
  }

  private delete(req: StubRequest, user: User, parts: string[]): StubResponse {
    const e = this.store.resolve(user.id, parts)
    if (!e || !parts.length) return davError(404, 'NotFound')
    if (!preconditions(req, e.node.etag, this.o.nextcloud || this.o.etags)) return davError(412, 'PreconditionFailed')
    if (e.mountRoot) return davError(403, 'Forbidden')
    if (!(e.perms & 8)) return davError(403, 'Forbidden')
    const n = e.node
    n.parent?.children.delete(n.name)
    if (n.parent) this.store.touch(n.parent)
    if (this.o.nextcloud && this.o.trashbin) {
      const ts = Math.floor(Date.now() / 1000)
      this.store.trash.push({ node: n, user: user.id, place: [...parts], deletedAt: ts, name: `${n.name}.d${ts}` })
    }
    return { status: 204 }
  }

  /** The parts below the user's folder of a `Destination` (an absolute URL of this server). */
  private destination(req: StubRequest, user: User): string[] | undefined {
    const d = req.headers.destination
    if (!d) return undefined
    let u: URL
    try {
      u = new URL(d)
    } catch {
      return undefined
    }
    if (u.host !== req.url.host) return undefined
    const all = u.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const home = this.home(user).split('/').filter(Boolean).map(decodeURIComponent)
    if (!home.every((p, i) => p === all[i])) return undefined
    return all.slice(home.length)
  }

  private move(req: StubRequest, user: User, parts: string[]): StubResponse {
    const e = this.store.resolve(user.id, parts)
    if (!e || !parts.length) return davError(404, 'NotFound')
    const dest = this.destination(req, user)
    if (!dest?.length) return davError(502, 'BadGateway')
    if (!preconditions(req, e.node.etag, this.o.nextcloud || this.o.etags)) return davError(412, 'PreconditionFailed')
    const name = dest[dest.length - 1] as string
    if (this.nameRefused(name)) return davError(400, 'BadRequest')
    const existing = this.store.resolve(user.id, dest)
    if (existing && (req.headers.overwrite ?? 'T').toUpperCase() === 'F') return davError(412, 'PreconditionFailed')
    if (existing) return davError(403, 'Forbidden')
    const destParent = this.store.resolve(user.id, dest.slice(0, -1))
    if (!destParent?.node.folder) return davError(409, 'Conflict')
    // a person moving or renaming the mount of a share made with them, in their own tree
    if (e.mountRoot && e.mount?.type === 'shared') {
      const share = this.store.shares.find((s) => s.type === 0 && s.shareWith === user.id && s.node === e.node)
      if (!share || destParent.mount) return davError(403, 'Forbidden')
      share.target = dest
      return { status: 201 }
    }
    if (e.mountRoot) return davError(403, 'Forbidden')
    const sameFolder = dest.slice(0, -1).join('/') === parts.slice(0, -1).join('/')
    if (sameFolder ? !(e.perms & 2) : !(e.perms & 8) || !(destParent.perms & 4)) return davError(403, 'Forbidden')
    if (e.node.folder && dest.length > parts.length && parts.every((p, i) => p === dest[i]))
      return davError(409, 'Conflict', 'A folder cannot move into itself')
    const n = e.node
    const from = n.parent
    from?.children.delete(n.name)
    n.name = name
    n.parent = destParent.node
    destParent.node.children.set(name, n)
    if (from) this.store.touch(from)
    this.store.touch(destParent.node)
    n.etag = `"${n.etag.slice(1, -1)}m"`
    return { status: 201 }
  }

  // ---- SEARCH (RFC 5323) -----------------------------------------------------------------------------------

  /** A `SEARCH` of names and file ids, under a scope of the user's tree. */
  public search(req: StubRequest, user: User): StubResponse {
    let root: XmlElement
    try {
      root = parseXml(req.body.toString('utf8'))
    } catch {
      return davError(400, 'BadRequest')
    }
    const basic = childOf(root, NS.D, 'basicsearch')
    const select = childrenOf(childOf(childOf(basic, NS.D, 'select'), NS.D, 'prop')).map((p) => [p.ns, p.name] as const)
    const scope = childOf(childOf(basic, NS.D, 'from'), NS.D, 'scope')
    const href = textOf(childOf(scope, NS.D, 'href')).trim()
    let parts: string[]
    if (this.o.nextcloud) {
      // Nextcloud reads the scope as a path of its own, decoded: an encoded one finds nothing (seen on Nextcloud 35)
      const all = href.split('/').filter(Boolean)
      if (all[0] !== 'files' || all[1] !== user.id) return multistatus([], select)
      parts = all.slice(2)
    } else {
      const all = href.split('/').filter(Boolean).map(decodeURIComponent)
      const home = this.home(user).split('/').filter(Boolean).map(decodeURIComponent)
      if (!home.every((p, i) => p === all[i])) return multistatus([], select)
      parts = all.slice(home.length)
    }
    const at = this.store.resolve(user.id, parts)
    if (!at) return multistatus([], select)
    const where = childrenOf(childOf(basic, NS.D, 'where'))[0]
    const limit = Number(textOf(childOf(childOf(basic, NS.D, 'limit'), NS.D, 'nresults')) || 0)
    let found = this.store.below(user.id, at).filter((e) => (where ? matches(where, e) : true))
    found.sort((a, b) => (a.node.name < b.node.name ? -1 : a.node.name > b.node.name ? 1 : 0))
    if (limit > 0) found = found.slice(0, limit)
    return multistatus(
      found.map((e) => this.resource(user, e)),
      select
    )
  }

  // ---- the trash bin (Nextcloud) ------------------------------------------------------------------------------

  public trashbin(req: StubRequest, user: User, below: string[]): StubResponse {
    const base = `/remote.php/dav/trashbin/${enc(user.id)}/`
    const items = this.store.trash.filter((t) => t.user === user.id)
    if (req.method === 'PROPFIND' && below[0] === 'trash' && below.length <= 2) {
      const asked = askedProps(req.body)
      const values = (t: TrashItem) => {
        const v = new Map<string, string>()
        v.set(key(NS.D, 'resourcetype'), t.node.folder ? '<d:collection/>' : '')
        v.set(key(NS.NC, 'trashbin-filename'), xmlEscape(t.node.name))
        v.set(key(NS.NC, 'trashbin-original-location'), xmlEscape(t.place.join('/')))
        v.set(key(NS.NC, 'trashbin-deletion-time'), String(t.deletedAt))
        v.set(key(NS.OC, 'fileid'), String(t.node.id))
        v.set(key(NS.D, 'getetag'), String(t.deletedAt))
        v.set(key(NS.D, 'getlastmodified'), httpDate(t.node.mtime))
        if (!t.node.folder) {
          v.set(key(NS.D, 'getcontentlength'), String(t.node.content.length))
          v.set(key(NS.D, 'getcontenttype'), typeByName(t.node.name))
        }
        return v
      }
      if (below.length === 2) {
        const t = items.find((x) => x.name === below[1])
        if (!t) return davError(404, 'NotFound')
        return multistatus([{ href: `${base}trash/${enc(t.name)}`, values: values(t) }], asked)
      }
      const self = new Map([[key(NS.D, 'resourcetype'), '<d:collection/>']])
      return multistatus(
        [
          { href: `${base}trash/`, values: self },
          ...items.map((t) => ({ href: `${base}trash/${enc(t.name)}`, values: values(t) })),
        ],
        asked
      )
    }
    if (req.method === 'MOVE' && below[0] === 'trash' && below.length === 2) {
      const t = items.find((x) => x.name === below[1])
      if (!t) return davError(404, 'NotFound')
      const d = req.headers.destination ? new URL(req.headers.destination).pathname : ''
      if (!d.startsWith(`${base}restore/`)) return davError(502, 'BadGateway')
      // as Nextcloud: into the account's own folder when the folder is gone, under another name when it is taken
      let parent = this.store.resolve(user.id, t.place.slice(0, -1))
      let place = t.place
      if (!parent?.node.folder) {
        parent = this.store.resolve(user.id, [])
        place = [t.node.name]
      }
      if (!parent) return davError(500, 'ServiceUnavailable')
      let name = t.node.name
      if (parent.node.children.has(name)) {
        const dot = name.lastIndexOf('.')
        name = dot > 0 ? `${name.slice(0, dot)} (restored)${name.slice(dot)}` : `${name} (restored)`
      }
      t.node.name = name
      t.node.parent = parent.node
      parent.node.children.set(name, t.node)
      this.store.touch(parent.node)
      this.store.trash.splice(this.store.trash.indexOf(t), 1)
      void place
      return { status: 201 }
    }
    return davError(405, 'MethodNotAllowed')
  }

  // ---- versions (Nextcloud) -----------------------------------------------------------------------------------

  /** The entry of a file id in a user's tree, for the versions of a file the user reaches. */
  private byId(user: User, id: number): Entry | undefined {
    const home = this.store.resolve(user.id, [])
    if (!home) return undefined
    return this.store.below(user.id, home).find((e) => e.node.id === id)
  }

  public versions(req: StubRequest, user: User, below: string[]): StubResponse {
    if (below[0] !== 'versions' || !below[1] || !/^\d+$/.test(below[1])) return davError(404, 'NotFound')
    const e = this.byId(user, Number(below[1]))
    if (!e || e.node.folder) return davError(404, 'NotFound')
    const n = e.node
    const current = { ts: Math.floor(n.mtime / 1000), content: n.content, author: user.id }
    const all = [...n.versions.filter((v) => v.ts !== current.ts), current]
    const base = `/remote.php/dav/versions/${enc(user.id)}/versions/${n.id}/`
    if (req.method === 'PROPFIND' && below.length === 2) {
      const asked = askedProps(req.body)
      return multistatus(
        [
          { href: base, values: new Map([[key(NS.D, 'resourcetype'), '<d:collection/>']]) },
          ...all.map((v) => ({
            href: `${base}${v.ts}`,
            values: new Map([
              [key(NS.D, 'resourcetype'), ''],
              [key(NS.D, 'getlastmodified'), httpDate(v.ts * 1000)],
              [key(NS.D, 'getcontentlength'), String(v.content.length)],
              [key(NS.D, 'getcontenttype'), typeByName(n.name)],
              [key(NS.D, 'getetag'), String(v.ts)],
              [key(NS.NC, 'version-author'), xmlEscape(v.author)],
            ]),
          })),
        ],
        asked
      )
    }
    if (req.method === 'GET' && below.length === 3) {
      const v = all.find((x) => String(x.ts) === below[2])
      if (!v) return davError(404, 'NotFound')
      return { status: 200, headers: { 'content-type': typeByName(n.name) }, body: v.content }
    }
    return davError(405, 'MethodNotAllowed')
  }
}

/** Whether an entry matches a `where` of basicsearch: `eq` of a file id, `like` of a name, `and`, `or`, `not`. */
function matches(w: XmlElement, e: Entry): boolean {
  if (w.name === 'and') return childrenOf(w).every((c) => matches(c, e))
  if (w.name === 'or') return childrenOf(w).some((c) => matches(c, e))
  if (w.name === 'not') return !childrenOf(w).every((c) => matches(c, e))
  const p = childrenOf(childOf(w, NS.D, 'prop'))[0]
  const literal = textOf(childOf(w, NS.D, 'literal'))
  if (!p) return false
  const value =
    p.ns === NS.OC && p.name === 'fileid'
      ? String(e.node.id)
      : p.ns === NS.D && p.name === 'displayname'
        ? e.node.name
        : undefined
  if (value === undefined) return false
  if (w.name === 'eq') return value === literal
  if (w.name === 'like') {
    // SQL's LIKE as Nextcloud runs it: % any run, _ one character, without regard to case
    const re = new RegExp(
      `^${literal
        .split('')
        .map((c) => (c === '%' ? '.*' : c === '_' ? '.' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        .join('')}$`,
      'is'
    )
    return re.test(value)
  }
  return false
}
