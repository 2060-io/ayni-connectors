/**
 * Files 1.0 over WebDAV (providers §3), and over a Nextcloud's WebDAV with its own interfaces (§5).
 *
 * Plain WebDAV: a reference is the item's path under the account's folder (FEAT-WEBDAV-002), an item is inside a root
 * by its path (003), creates carry `If-None-Match: *` and replaces `If-Match` (004), `search` only with `DASL` (005),
 * roots are not portable (006). Nextcloud: a reference is the file id (`oc:fileid`), found in the account's own tree by
 * a `SEARCH` under the root's folder (FEAT-NC-002), roots are portable (003), names are searched (004), the trash bin
 * (005) and versions are Nextcloud's.
 */
import { createHash } from 'node:crypto'
import type {
  Content,
  FilesCreateArgs,
  FilesCreateFolderArgs,
  FilesDeclaration,
  FilesGetArgs,
  FilesListArgs,
  FilesListTrashArgs,
  FilesMoveArgs,
  FilesReadArgs,
  FilesReplaceArgs,
  FilesRestoreArgs,
  FilesRootsArgs,
  FilesSearchArgs,
  FilesTrashArgs,
  FilesVersionsArgs,
  Item,
  Root,
  VersionEntry,
} from '@ayni.org/ayni-feature-profiles'
import { type CallContext, errors, type Logger, type PagedContext, pageByKey } from '@ayni.org/ayni-provider-kit'
import type { DavAccountData } from './account.js'
import {
  type DavResource,
  isCollection,
  NS,
  type PropName,
  parseMultistatus,
  prop,
  propfind,
  propText,
  qname,
  statusError,
  timeOf,
  xmlns,
} from './dav.js'
import type { DavRequest, DavResponse, HttpClient } from './http.js'
import type { NextcloudInfo } from './nextcloud.js'
import { partsBelow, refOf, refParts, urlBelow, within } from './paths.js'
import { childrenOf, escapeXml, textOf } from './xml.js'

type Ctx = CallContext<DavAccountData, FilesDeclaration>
type Paged = PagedContext<DavAccountData, FilesDeclaration>

/** Whether a media type is read as text (files §1, Content). */
export function isTextType(type: string): boolean {
  const t = type.toLowerCase()
  return (
    t.startsWith('text/') ||
    t === 'application/json' ||
    t === 'application/xml' ||
    t.endsWith('+json') ||
    t.endsWith('+xml')
  )
}

const EXTENSIONS: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  ics: 'text/calendar',
  json: 'application/json',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  js: 'text/javascript',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
}

/** The media type of a name's extension (FEAT-FILES-014). */
export function mediaTypeOfName(name: string): string | undefined {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? EXTENSIONS[name.slice(dot + 1).toLowerCase()] : undefined
}

/** A media type without its parameters (`text/plain; charset=utf-8` is `text/plain`), when it is one. */
export function bareType(type: string | undefined): string | undefined {
  const t = type?.split(';')[0]?.trim().toLowerCase()
  return t && /^[^/\s]+\/[^/\s]+$/.test(t) ? t : undefined
}

/** UTF-8 with a byte order mark removed (FEAT-FILES-014). */
export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes)
}

/** An entity tag a client gave back, when it is one to send in `If-Match` (no other header can be made of it). */
export function entityTag(version: string): string | undefined {
  return /^(W\/)?"[\x21\x23-\x7e\x80-\xff]*"$/.test(version) ? version : undefined
}

const BASE_PROPS: PropName[] = [
  [NS.D, 'resourcetype'],
  [NS.D, 'displayname'],
  [NS.D, 'getcontentlength'],
  [NS.D, 'getcontenttype'],
  [NS.D, 'getlastmodified'],
  [NS.D, 'creationdate'],
  [NS.D, 'getetag'],
]
const PLAIN_PROPS: PropName[] = [...BASE_PROPS, [NS.D, 'current-user-privilege-set']]
const NC_PROPS: PropName[] = [
  ...BASE_PROPS,
  [NS.OC, 'fileid'],
  [NS.OC, 'permissions'],
  [NS.NC, 'mount-type'],
  [NS.NC, 'is-mount-root'],
  [NS.OC, 'share-types'],
  [NS.NC, 'creation_time'],
]
const TRASH_PROPS: PropName[] = [
  ...BASE_PROPS,
  [NS.OC, 'fileid'],
  [NS.NC, 'trashbin-filename'],
  [NS.NC, 'trashbin-original-location'],
  [NS.NC, 'trashbin-deletion-time'],
]

/** A resource of the account's tree: its parts below the account's folder, and what the server said of it. */
export interface Entry {
  parts: string[]
  res: DavResource
}

/** The root of a call: its reference and its folder. */
export interface Located {
  ref: string
  entry: Entry
}

export const isFolder = (e: Entry) => isCollection(e.res)
export const fileIdOf = (e: Entry) => propText(e.res, NS.OC, 'fileid')
const etagOf = (e: Entry) => propText(e.res, NS.D, 'getetag')
const sizeOf = (e: Entry) => {
  const t = propText(e.res, NS.D, 'getcontentlength')
  return t && /^\d+$/.test(t) ? Number(t) : undefined
}
const modifiedOf = (e: Entry) => timeOf(propText(e.res, NS.D, 'getlastmodified'))
function createdOf(e: Entry): number | undefined {
  const nc = propText(e.res, NS.NC, 'creation_time')
  if (nc && /^\d+$/.test(nc) && Number(nc) > 0) return Number(nc) * 1000
  const t = timeOf(propText(e.res, NS.D, 'creationdate'))
  return t !== undefined && t > 0 ? t : undefined
}
const utc = (ms: number) => `${new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19)}Z`
const shareTypesOf = (e: Entry) =>
  childrenOf(prop(e.res, NS.OC, 'share-types'), NS.OC, 'share-type').map((x) => textOf(x).trim())

/** What one request of the connector knows of the store of files it reaches. */
export interface FilesSession {
  http: HttpClient
  /** the account's own folder: the WebDAV address of the request, or a Nextcloud's `files/{user}/` */
  home: URL
  nc?: NextcloudInfo
  /** a plain server that gives entity tags: writes are compared and made in one step */
  etags: boolean
  /** a plain server that answers `DASL` with `<DAV:basicsearch>` */
  dasl: boolean
  logger: Logger
  /** the title of the account's own folder */
  ownTitle: string
}

/** The Files store of one request, its tools' work. */
export class DavFiles {
  public readonly mode: 'webdav' | 'nextcloud'
  public readonly props: PropName[]

  public constructor(public readonly s: FilesSession) {
    this.mode = s.nc ? 'nextcloud' : 'webdav'
    this.props = s.nc ? NC_PROPS : PLAIN_PROPS
  }

  public get atomic(): boolean {
    return this.mode === 'nextcloud' || this.s.etags
  }

  public url(parts: readonly string[], folder = false): URL {
    return urlBelow(this.s.home, parts, folder)
  }

  public entriesOf(resources: DavResource[]): Entry[] {
    const out: Entry[] = []
    for (const res of resources) {
      const parts = partsBelow(res.href, this.s.home)
      if (parts) out.push({ parts, res })
    }
    return out
  }

  /** The resource at a path of the account's tree; `not-found` when there is none. */
  public async at(parts: readonly string[], signal?: AbortSignal): Promise<Entry> {
    const [res] = this.entriesOf(
      await propfind(this.s.http, this.url(parts, parts.length === 0), '0', this.props, signal)
    )
    if (!res) throw errors.notFound()
    return { parts: [...parts], res: res.res }
  }

  /** The resource at a path, or `undefined` when there is none. */
  public async maybeAt(parts: readonly string[], signal?: AbortSignal): Promise<Entry | undefined> {
    try {
      return await this.at(parts, signal)
    } catch (e) {
      if ((e as { code?: string }).code === 'not-found') return undefined
      throw e
    }
  }

  /** What a folder holds, one level: `PROPFIND` of depth 1, the folder itself left out. */
  public async children(parts: readonly string[], signal?: AbortSignal): Promise<Entry[]> {
    const all = this.entriesOf(await propfind(this.s.http, this.url(parts, true), '1', this.props, signal))
    return all.filter((e) => e.parts.length === parts.length + 1 && within(parts, e.parts))
  }

  // ---- references ---------------------------------------------------------------------------------------------

  /** A Nextcloud's `SEARCH` for a file id under a folder of the account's tree (the folder itself is not searched). */
  public async searchId(id: string, scope: readonly string[], signal?: AbortSignal): Promise<Entry | undefined> {
    const found = await this.search(
      scope,
      `<d:eq><d:prop><oc:fileid/></d:prop><d:literal>${escapeXml(id)}</d:literal></d:eq>`,
      2,
      signal
    )
    return found.find((e) => fileIdOf(e) === id)
  }

  /** A `SEARCH` (RFC 5323) under a folder, at any depth, with a `where` of the connector's own making. */
  public async search(scope: readonly string[], where: string, limit: number, signal?: AbortSignal): Promise<Entry[]> {
    const nc = this.s.nc
    // Nextcloud reads the scope as a path of its own, decoded (seen on Nextcloud 35); RFC 5323 gives a URI
    const scopeHref = nc ? `/files/${[nc.userId, ...scope].join('/')}` : this.url(scope, true).pathname
    const body =
      `<?xml version="1.0" encoding="UTF-8"?><d:searchrequest ${xmlns()}><d:basicsearch>` +
      `<d:select><d:prop>${this.props.map((p) => `<${qname(p)}/>`).join('')}</d:prop></d:select>` +
      `<d:from><d:scope><d:href>${escapeXml(scopeHref)}</d:href><d:depth>infinity</d:depth></d:scope></d:from>` +
      `<d:where>${where}</d:where>` +
      '<d:orderby><d:order><d:prop><d:displayname/></d:prop><d:ascending/></d:order></d:orderby>' +
      `<d:limit><d:nresults>${limit}</d:nresults></d:limit>` +
      '</d:basicsearch></d:searchrequest>'
    const res = await this.s.http.send(
      {
        method: 'SEARCH',
        url: nc ? nc.dav : this.url(scope, true),
        headers: { 'content-type': 'text/xml; charset=utf-8' },
        body,
      },
      signal
    )
    if (res.status !== 207) throw statusError(res)
    return this.entriesOf(parseMultistatus(res.body)).filter(
      (e) => e.parts.length > scope.length && within(scope, e.parts)
    )
  }

  /** The root of a call (FEAT-NC-002, FEAT-WEBDAV-002): `not-found` when it names no folder the account reaches. */
  public async root(ref: string, signal?: AbortSignal): Promise<Located> {
    if (this.mode === 'webdav') {
      const parts = refParts(ref, 'root')
      const entry = await this.at(parts, signal)
      if (!isFolder(entry)) throw errors.notFound()
      return { ref: refOf(parts), entry }
    }
    if (!/^\d{1,20}$/.test(ref)) throw errors.notFound()
    const [home, found] = await Promise.all([this.at([], signal), this.searchId(ref, [], signal)])
    if (fileIdOf(home) === ref) return { ref, entry: home }
    if (!found || !isFolder(found)) throw errors.notFound()
    return { ref, entry: found }
  }

  /** An item of a root by its reference; `not-found` when the root does not hold it, as when it names nothing. */
  public async item(root: Located, ref: string, field: string, signal?: AbortSignal): Promise<Entry> {
    if (this.mode === 'webdav') {
      const parts = refParts(ref, field)
      if (!within(root.entry.parts, parts)) throw errors.notFound()
      return this.at(parts, signal)
    }
    if (ref === root.ref) return root.entry
    if (!/^\d{1,20}$/.test(ref)) throw errors.notFound()
    const found = await this.searchId(ref, root.entry.parts, signal)
    if (!found) throw errors.notFound()
    return found
  }

  /** A folder of a root given as an argument: the root when absent; `not-supported` for a file. */
  public async folderOf(root: Located, ref: string | undefined, field: string, signal?: AbortSignal): Promise<Entry> {
    const e = ref === undefined ? root.entry : await this.item(root, ref, field, signal)
    if (!isFolder(e)) throw errors.notSupported(`"${field}" is a file, not a folder.`, field)
    return e
  }

  public refOf(e: Entry): string {
    if (this.mode === 'webdav') return refOf(e.parts)
    const id = fileIdOf(e)
    if (!id) throw errors.unavailable('The server gave an item no file id.')
    return id
  }

  /** The reference of the folder that holds an item of a root, `undefined` for the root itself. */
  public async parentRef(
    root: Located,
    e: Entry,
    cache: Map<string, string> = new Map(),
    signal?: AbortSignal
  ): Promise<string | undefined> {
    if (e.parts.length <= root.entry.parts.length) return undefined
    const parent = e.parts.slice(0, -1)
    if (this.mode === 'webdav') return refOf(parent)
    if (parent.length === root.entry.parts.length) return root.ref
    const k = parent.join('/')
    const known = cache.get(k)
    if (known) return known
    const ref = this.refOf(await this.at(parent, signal))
    cache.set(k, ref)
    return ref
  }

  /**
   * Whether a folder between the root and an item (both left out) carries a share (FEAT-FILES-054): a Nextcloud's
   * `oc:share-types` of each folder on the way, read once per call.
   */
  public async sharedAbove(
    root: Located,
    parts: readonly string[],
    cache: Map<string, boolean>,
    signal?: AbortSignal
  ): Promise<boolean> {
    for (let n = root.entry.parts.length + 1; n < parts.length; n++) {
      const k = parts.slice(0, n).join('/')
      let v = cache.get(k)
      if (v === undefined) {
        v = shareTypesOf(await this.at(parts.slice(0, n), signal)).length > 0
        cache.set(k, v)
      }
      if (v) return true
    }
    return false
  }

  public get sharing(): boolean {
    return !!this.s.nc?.sharing
  }

  /** An item as the profile answers it (files §1). */
  public toItem(root: Located, e: Entry, parent: string | undefined, sharedAbove = false): Item {
    const rel = e.parts.slice(root.entry.parts.length)
    const folder = isFolder(e)
    const name = rel.length
      ? (rel[rel.length - 1] as string)
      : (e.parts[e.parts.length - 1] ?? propText(e.res, NS.D, 'displayname') ?? this.s.ownTitle)
    const item: Item = {
      ref: this.refOf(e),
      root: root.ref,
      kind: folder ? 'folder' : 'file',
      name,
      path: `/${rel.join('/')}`,
    }
    if (rel.length && parent !== undefined) item.parent = parent
    if (!folder) {
      item.mediaType = this.typeOf(e)
      const size = sizeOf(e)
      if (size !== undefined) item.sizeBytes = size
      item.version = this.versionOf(e)
    }
    const created = createdOf(e)
    if (created !== undefined) item.createdAt = utc(created)
    const modified = modifiedOf(e)
    if (modified !== undefined) item.modifiedAt = utc(modified)
    if (this.sharing && rel.length && (shareTypesOf(e).length > 0 || sharedAbove)) item.shared = true
    if (this.s.nc) item.webUrl = this.webUrlOf(e)
    return item
  }

  public webUrlOf(e: Entry): string {
    const nc = this.s.nc as NextcloudInfo
    const u = new URL(nc.base.toString())
    u.pathname = `${nc.base.pathname.replace(/\/+$/, '')}/index.php/f/${encodeURIComponent(this.refOf(e))}`
    return u.toString()
  }

  public typeOf(e: Entry): string {
    return bareType(propText(e.res, NS.D, 'getcontenttype')) ?? 'application/octet-stream'
  }

  /** A file's version: its entity tag; for a server that gives none, the last change and the length (FEAT-WEBDAV-004). */
  public versionOf(e: Entry): string {
    const tag = etagOf(e)
    if (tag) return tag.length <= 255 ? tag : `h:${createHash('sha256').update(tag).digest('base64url')}`
    return `m:${modifiedOf(e) ?? 0}:${sizeOf(e) ?? 0}`
  }

  public writable(e: Entry): boolean {
    if (this.mode === 'nextcloud') {
      const p = propText(e.res, NS.OC, 'permissions') ?? ''
      return isFolder(e) ? /[CK]/.test(p) : p.includes('W')
    }
    const set = prop(e.res, NS.D, 'current-user-privilege-set')
    if (!set) return true
    const names = childrenOf(set, NS.D, 'privilege').flatMap((p) => childrenOf(p).map((x) => x.name))
    return names.some((n) => ['all', 'write', 'write-content', 'bind'].includes(n))
  }

  public isTeamRoot(e: Entry): boolean {
    return (
      this.mode === 'nextcloud' &&
      propText(e.res, NS.NC, 'mount-type') === 'group' &&
      propText(e.res, NS.NC, 'is-mount-root') === 'true'
    )
  }

  public toRoot(e: Entry): Root {
    const own = e.parts.length === 0
    const root: Root = {
      ref: this.refOf(e),
      title: own ? this.s.ownTitle : (e.parts[e.parts.length - 1] as string),
      path: refOf(e.parts),
      writable: this.writable(e),
      portable: this.mode === 'nextcloud',
    }
    if (this.isTeamRoot(e)) root.team = true
    return root
  }

  /**
   * A write, waited for while the server holds the item's lock for another request: Nextcloud answers `423 Locked`
   * to a second write of a file being written, and to both of two writes that took the lock together (seen on Nextcloud
   * 35), and the precondition then decides. Five tries within some three seconds, each after a wait of its own so that
   * two writes do not meet again, then the `423` is answered as providers §3 says (`unavailable`).
   */
  private async write(req: DavRequest, signal?: AbortSignal): Promise<DavResponse> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.s.http.send(req, signal)
      if (res.status !== 423 || attempt >= 5) return res
      const wait = 50 * 2 ** attempt
      await new Promise((resolve) => setTimeout(resolve, wait + Math.floor(Math.random() * wait * 2)))
    }
  }

  /** An answer of a write: `412` and the others of providers §3. */
  private writeError(res: DavResponse, ctx: Ctx, on412: () => Error): Error {
    if (res.status === 412) return on412()
    if (res.status === 409) return errors.notFound('The folder is not there.')
    if (res.status === 400) return errors.invalidArgument('name', 'The server does not take this name.')
    return statusError(res, { limitBytes: ctx.limits.writeBytes })
  }

  // ---- the core -------------------------------------------------------------------------------------------------

  public async roots(args: Omit<FilesRootsArgs, 'limit' | 'cursor'>, ctx: Paged) {
    const own = await this.at([], ctx.signal)
    let found: Entry[]
    if (args.query === undefined) {
      found = [own]
      if (this.mode === 'nextcloud')
        for (const e of await this.children([], ctx.signal))
          if (
            isFolder(e) &&
            propText(e.res, NS.NC, 'is-mount-root') === 'true' &&
            ['shared', 'group'].includes(propText(e.res, NS.NC, 'mount-type') ?? '')
          )
            found.push(e)
    } else {
      const q = args.query.startsWith('/') ? args.query : `/${args.query}`
      const cut = q.lastIndexOf('/')
      const dir = q.slice(1, cut).split('/').filter(Boolean)
      const last = q.slice(cut + 1).toLowerCase()
      let kids: Entry[] = []
      if (dir.every((p) => p !== '.' && p !== '..'))
        try {
          kids = await this.children(dir, ctx.signal)
        } catch (e) {
          if ((e as { code?: string }).code !== 'not-found') throw e
        }
      found = kids.filter((e) => isFolder(e) && (e.parts[e.parts.length - 1] ?? '').toLowerCase().startsWith(last))
      if (q === '/') found.unshift(own)
    }
    const roots = found.map((e) => this.toRoot(e))
    const page = pageByKey(roots, (r) => (r.path === '/' ? '\u0000' : `\u0001${r.path}\u0000${r.ref}`), ctx.page)
    return { roots: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }
  }

  public async list(args: Omit<FilesListArgs, 'limit' | 'cursor'>, ctx: Paged) {
    const root = await this.root(args.root, ctx.signal)
    const folder = await this.folderOf(root, args.folder, 'folder', ctx.signal)
    const kids = await this.children(folder.parts, ctx.signal)
    const shared = new Map<string, boolean>()
    const above = this.sharing ? await this.sharedAbove(root, folder.parts, shared, ctx.signal) : false
    const folderShared =
      this.sharing && folder.parts.length > root.entry.parts.length && shareTypesOf(folder).length > 0
    const folderRef = this.refOf(folder)
    const items = kids.map((k) => this.toItem(root, k, folderRef, above || folderShared))
    const page = pageByKey(items, (i) => `${i.name}\u0000${i.ref}`, ctx.page)
    return {
      folder: this.toItem(root, folder, await this.parentRef(root, folder, new Map(), ctx.signal), above),
      items: page.items,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    }
  }

  /** An item as answered, with its parent and whether a folder above it is shared. */
  public async answer(root: Located, e: Entry, signal?: AbortSignal): Promise<Item> {
    const parent = await this.parentRef(root, e, new Map(), signal)
    const above = this.sharing ? await this.sharedAbove(root, e.parts, new Map(), signal) : false
    return this.toItem(root, e, parent, above)
  }

  public async get(args: FilesGetArgs, ctx: Ctx) {
    const root = await this.root(args.root, ctx.signal)
    const e = await this.item(root, args.ref, 'ref', ctx.signal)
    return { item: await this.answer(root, e, ctx.signal) }
  }

  public async read(args: FilesReadArgs & { version?: string }, ctx: Ctx) {
    const root = await this.root(args.root, ctx.signal)
    const e = await this.item(root, args.ref, 'ref', ctx.signal)
    if (isFolder(e)) throw errors.notSupported('A folder has no content to read.')
    const type = this.typeOf(e)
    const text = isTextType(type)
    const limit = ctx.limits.readBytes
    let url = this.url(e.parts)
    let size = sizeOf(e)
    if (args.version !== undefined) {
      const v = await this.versionUrl(e, args.version, ctx.signal)
      if (v) {
        url = v
        size = undefined
      }
    }
    if (!text && size !== undefined && size > limit) throw errors.tooLarge(limit, size)
    const max = text ? Math.min(args.maxBytes ?? limit, limit) + 4 : limit + 1
    const res = await this.s.http.send({ method: 'GET', url, maxBytes: max }, ctx.signal)
    if (res.status !== 200) throw statusError(res)
    if (!text && (res.truncated || res.body.length > limit)) throw errors.tooLarge(limit, size)
    const content: Content = text
      ? { kind: 'text', text: decodeText(res.body), mediaType: type }
      : { kind: 'bytes', base64: res.body.toString('base64'), mediaType: type }
    return { item: await this.answer(root, e, ctx.signal), content }
  }

  public async create(args: FilesCreateArgs, ctx: Ctx) {
    const root = await this.root(args.root, ctx.signal)
    const folder = await this.folderOf(root, args.folder, 'folder', ctx.signal)
    const isText = 'text' in args.content
    const body = isText
      ? Buffer.from((args.content as { text: string }).text, 'utf8')
      : Buffer.from((args.content as { base64: string }).base64, 'base64')
    const type = args.mediaType ?? mediaTypeOfName(args.name) ?? (isText ? 'text/plain' : 'application/octet-stream')
    const parts = [...folder.parts, args.name]
    // a server without entity tags may not compare either: it is asked first (atomicWrites false)
    if (!this.atomic && (await this.maybeAt(parts, ctx.signal))) throw errors.alreadyExists()
    const res = await this.write(
      { method: 'PUT', url: this.url(parts), headers: { 'if-none-match': '*', 'content-type': type }, body },
      ctx.signal
    )
    if (![200, 201, 204].includes(res.status)) throw this.writeError(res, ctx, () => errors.alreadyExists())
    const e = await this.at(parts, ctx.signal)
    return { item: await this.answer(root, e, ctx.signal) }
  }

  /** The current version of an item, read again after a refused write. */
  private async current(e: Entry, signal?: AbortSignal): Promise<string> {
    return this.versionOf(await this.at(e.parts, signal))
  }

  public async replace(args: FilesReplaceArgs, ctx: Ctx) {
    const root = await this.root(args.root, ctx.signal)
    const e = await this.item(root, args.ref, 'ref', ctx.signal)
    if (isFolder(e)) throw errors.notSupported('A folder has no content to replace.')
    const headers: Record<string, string> = { 'content-type': args.mediaType ?? this.typeOf(e) }
    if (this.atomic) {
      const tag = entityTag(args.ifVersion)
      if (!tag) throw errors.versionMismatch(this.versionOf(e))
      headers['if-match'] = tag
    } else if (this.versionOf(e) !== args.ifVersion) throw errors.versionMismatch(this.versionOf(e))
    this.bumpTime(e, headers)
    const body =
      'text' in args.content
        ? Buffer.from(args.content.text, 'utf8')
        : Buffer.from((args.content as { base64: string }).base64, 'base64')
    const res = await this.write({ method: 'PUT', url: this.url(e.parts), headers, body }, ctx.signal)
    if (![200, 201, 204].includes(res.status)) {
      if (res.status === 412) throw errors.versionMismatch(await this.current(e, ctx.signal))
      throw this.writeError(res, ctx, () => errors.unavailable())
    }
    const after = await this.at(e.parts, ctx.signal)
    return { item: await this.answer(root, after, ctx.signal) }
  }

  /**
   * A Nextcloud names a version after the second of the change it replaced, so that two changes within one second
   * keep one version (seen on Nextcloud 35): a write whose file changed in the current second, or later, is given the
   * next second as its time (`X-OC-Mtime`), so that each former content is kept (files §3.6).
   */
  private bumpTime(e: Entry, headers: Record<string, string>): void {
    if (this.mode !== 'nextcloud' || !this.s.nc?.versions) return
    const m = modifiedOf(e)
    if (m === undefined) return
    const was = Math.floor(m / 1000)
    if (was >= Math.floor(Date.now() / 1000)) headers['x-oc-mtime'] = String(was + 1)
  }

  // ---- folders --------------------------------------------------------------------------------------------------

  public async createFolder(args: FilesCreateFolderArgs, ctx: Ctx) {
    const root = await this.root(args.root, ctx.signal)
    const folder = await this.folderOf(root, args.folder, 'folder', ctx.signal)
    const parts = [...folder.parts, args.name]
    const res = await this.write({ method: 'MKCOL', url: this.url(parts, true) }, ctx.signal)
    if (res.status !== 201) {
      if (res.status === 405) throw errors.alreadyExists()
      throw this.writeError(res, ctx, () => errors.alreadyExists())
    }
    const e = await this.at(parts, ctx.signal)
    return { item: await this.answer(root, e, ctx.signal) }
  }

  public async move(args: FilesMoveArgs, ctx: Ctx) {
    const root = await this.root(args.root, ctx.signal)
    const e = await this.item(root, args.ref, 'ref', ctx.signal)
    if (e.parts.length === root.entry.parts.length)
      throw errors.notSupported('The root itself is not moved or renamed.')
    const dest =
      args.toFolder !== undefined
        ? await this.folderOf(root, args.toFolder, 'toFolder', ctx.signal)
        : { parts: e.parts.slice(0, -1), res: e.res }
    const folder = isFolder(e)
    if (folder && within(e.parts, dest.parts))
      throw errors.invalidArgument('toFolder', 'A folder cannot move into itself.')
    const parts = [...dest.parts, args.newName ?? (e.parts[e.parts.length - 1] as string)]
    const headers: Record<string, string> = {
      destination: this.url(parts, folder).toString(),
      overwrite: 'F',
    }
    if (args.ifVersion !== undefined) {
      if (folder) throw errors.invalidArgument('ifVersion', 'A folder has no version to compare.')
      if (this.atomic) {
        const tag = entityTag(args.ifVersion)
        if (!tag) throw errors.versionMismatch(this.versionOf(e))
        headers['if-match'] = tag
      } else if (this.versionOf(e) !== args.ifVersion) throw errors.versionMismatch(this.versionOf(e))
    }
    if (parts.join('/') === e.parts.join('/')) return { item: await this.answer(root, e, ctx.signal) }
    const res = await this.write({ method: 'MOVE', url: this.url(e.parts, folder), headers }, ctx.signal)
    if (![201, 204].includes(res.status)) {
      if (res.status === 412) {
        const now = await this.current(e, ctx.signal).catch(() => undefined)
        if (args.ifVersion !== undefined && now !== undefined && now !== args.ifVersion)
          throw errors.versionMismatch(now)
        throw errors.alreadyExists()
      }
      throw this.writeError(res, ctx, () => errors.alreadyExists())
    }
    const after = await this.at(parts, ctx.signal)
    return { item: await this.answer(root, after, ctx.signal) }
  }

  // ---- search ---------------------------------------------------------------------------------------------------

  /**
   * Names under the root's folder (FEAT-NC-004, FEAT-WEBDAV-005): the server is asked for names that hold each word,
   * with the wildcards of its language taken out of them, and the connector keeps the items whose name holds every
   * word as it was given, inside the root: no operator of the store is read in the words (FEAT-FILES-020).
   */
  public async searchNames(args: Omit<FilesSearchArgs, 'limit' | 'cursor'>, ctx: Paged) {
    const root = await this.root(args.root, ctx.signal)
    const scope = await this.folderOf(root, args.folder, 'folder', ctx.signal)
    const words = args.query.split(/\s+/).filter(Boolean)
    const server = words.map((w) => w.replace(/[%_\\*?]/g, '')).filter(Boolean)
    const like = (w: string) =>
      `<d:like><d:prop><d:displayname/></d:prop><d:literal>%${escapeXml(w)}%</d:literal></d:like>`
    const where =
      server.length === 0
        ? like('')
        : server.length === 1
          ? like(server[0] as string)
          : `<d:and>${server.map(like).join('')}</d:and>`
    const found = await this.search(scope.parts, where, 1000, ctx.signal)
    const lower = words.map((w) => w.toLowerCase())
    const kept = found.filter((e) => {
      const name = (e.parts[e.parts.length - 1] ?? '').toLowerCase()
      return within(root.entry.parts, e.parts) && lower.every((w) => name.includes(w))
    })
    const page = pageByKey(kept, (e) => `${e.parts.join('/')}\u0000${fileIdOf(e) ?? ''}`, ctx.page)
    const parents = new Map<string, string>()
    const shared = new Map<string, boolean>()
    const items: Item[] = []
    for (const e of page.items) {
      const parent = await this.parentRef(root, e, parents, ctx.signal)
      const above = this.sharing ? await this.sharedAbove(root, e.parts, shared, ctx.signal) : false
      items.push(this.toItem(root, e, parent, above))
    }
    return { items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }
  }

  // ---- trash (Nextcloud) ----------------------------------------------------------------------------------------

  private trashUrl(...segments: string[]): URL {
    const nc = this.s.nc as NextcloudInfo
    return new URL(`trashbin/${encodeURIComponent(nc.userId)}/${segments.map(encodeURIComponent).join('/')}`, nc.dav)
  }

  /** The items of the account's trash bin, each with its place before (its parts in the account's tree). */
  private async trashed(signal?: AbortSignal): Promise<{ entry: Entry; name: string; place: string[]; at?: number }[]> {
    const base = this.trashUrl('trash', '')
    const all = await propfind(this.s.http, base, '1', TRASH_PROPS, signal)
    const out: { entry: Entry; name: string; place: string[]; at?: number }[] = []
    for (const res of all) {
      const below = partsBelow(res.href, base)
      if (below?.length !== 1) continue
      const location = propText(res, NS.NC, 'trashbin-original-location')
      const place = location?.split('/').filter(Boolean)
      if (!place?.length) continue
      const at = propText(res, NS.NC, 'trashbin-deletion-time')
      out.push({
        entry: { parts: place, res },
        name: below[0] as string,
        place,
        ...(at && /^\d+$/.test(at) ? { at: Number(at) * 1000 } : {}),
      })
    }
    return out
  }

  private async trashItem(
    root: Located,
    t: { entry: Entry; place: string[]; at?: number },
    parents: Map<string, string>,
    signal?: AbortSignal
  ): Promise<Item> {
    let parent: string | undefined = root.ref
    if (t.place.length - 1 > root.entry.parts.length) {
      const k = t.place.slice(0, -1).join('/')
      const known = parents.get(k)
      if (known) parent = known
      else {
        const p = await this.maybeAt(t.place.slice(0, -1), signal)
        parent = p ? this.refOf(p) : root.ref
        parents.set(k, parent)
      }
    }
    const { shared: _s, webUrl: _w, ...item } = this.toItem(root, t.entry, parent)
    return {
      ...item,
      name: propText(t.entry.res, NS.NC, 'trashbin-filename') ?? item.name,
      trashedAt: utc(t.at ?? Date.now()),
    }
  }

  public async trash(args: FilesTrashArgs, ctx: Ctx) {
    const root = await this.root(args.root, ctx.signal)
    const e = await this.item(root, args.ref, 'ref', ctx.signal)
    if (e.parts.length === root.entry.parts.length) throw errors.notSupported('The root itself is not trashed.')
    const headers: Record<string, string> = {}
    if (args.ifVersion !== undefined) {
      if (isFolder(e)) throw errors.invalidArgument('ifVersion', 'A folder has no version to compare.')
      const tag = entityTag(args.ifVersion)
      if (!tag) throw errors.versionMismatch(this.versionOf(e))
      headers['if-match'] = tag
    }
    const id = this.refOf(e)
    const res = await this.write({ method: 'DELETE', url: this.url(e.parts, isFolder(e)), headers }, ctx.signal)
    if (res.status !== 204 && res.status !== 200) {
      if (res.status === 412) throw errors.versionMismatch(await this.current(e, ctx.signal))
      throw statusError(res)
    }
    const t = (await this.trashed(ctx.signal)).find((x) => fileIdOf(x.entry) === id)
    if (!t) {
      const {
        shared: _s,
        webUrl: _w,
        ...item
      } = this.toItem(root, e, await this.parentRef(root, e, new Map(), ctx.signal))
      return { item: { ...item, trashedAt: utc(Date.now()) } }
    }
    return { item: await this.trashItem(root, t, new Map(), ctx.signal) }
  }

  public async listTrash(args: Omit<FilesListTrashArgs, 'limit' | 'cursor'>, ctx: Paged) {
    const root = await this.root(args.root, ctx.signal)
    const all = (await this.trashed(ctx.signal)).filter(
      (t) => t.place.length > root.entry.parts.length && within(root.entry.parts, t.place)
    )
    const page = pageByKey(all, (t) => `${t.place.join('/')}\u0000${t.name}`, ctx.page)
    const parents = new Map<string, string>()
    const items: Item[] = []
    for (const t of page.items) items.push(await this.trashItem(root, t, parents, ctx.signal))
    return { items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }
  }

  public async restore(args: FilesRestoreArgs, ctx: Ctx) {
    const root = await this.root(args.root, ctx.signal)
    const t = (await this.trashed(ctx.signal)).find(
      (x) =>
        fileIdOf(x.entry) === args.ref && x.place.length > root.entry.parts.length && within(root.entry.parts, x.place)
    )
    if (!t) throw errors.notFound('No such item in the trash of this folder.')
    // Nextcloud would restore into the account's own folder, or under another name: the profile answers instead
    const parent = await this.maybeAt(t.place.slice(0, -1), ctx.signal)
    if (!parent || !isFolder(parent)) throw errors.notFound('The folder the item left is gone.')
    if (await this.maybeAt(t.place, ctx.signal)) throw errors.alreadyExists('The folder the item left holds its name.')
    // no Overwrite: F, which Nextcloud answers 412 for the restore collection (seen on Nextcloud 35); the place was
    // looked at above
    const res = await this.write(
      {
        method: 'MOVE',
        url: this.trashUrl('trash', t.name),
        headers: { destination: this.trashUrl('restore', t.name).toString() },
      },
      ctx.signal
    )
    if (res.status !== 201 && res.status !== 204) throw statusError(res)
    const e = await this.at(t.place, ctx.signal)
    return { item: await this.answer(root, e, ctx.signal) }
  }

  // ---- versions (Nextcloud) -------------------------------------------------------------------------------------

  private versionsUrl(id: string, name?: string): URL {
    const nc = this.s.nc as NextcloudInfo
    return new URL(
      `versions/${encodeURIComponent(nc.userId)}/versions/${encodeURIComponent(id)}/${name ? encodeURIComponent(name) : ''}`,
      nc.dav
    )
  }

  /** Where a former version is read; `undefined` for the current one; `not-found` for a version it never had. */
  private async versionUrl(e: Entry, version: string, signal?: AbortSignal): Promise<URL | undefined> {
    if (version === this.versionOf(e)) return undefined
    const m = modifiedOf(e)
    if (m !== undefined && version === String(Math.floor(m / 1000))) return undefined
    if (!/^\d{1,20}$/.test(version)) throw errors.notFound('The file never had this version.')
    const listed = await this.listVersions(e, signal)
    if (!listed.some((v) => v.version === version)) throw errors.notFound('The file never had this version.')
    return this.versionsUrl(this.refOf(e), version)
  }

  private async listVersions(e: Entry, signal?: AbortSignal): Promise<VersionEntry[]> {
    const base = this.versionsUrl(this.refOf(e))
    const all = await propfind(
      this.s.http,
      base,
      '1',
      [
        [NS.D, 'getlastmodified'],
        [NS.D, 'getcontentlength'],
        [NS.D, 'resourcetype'],
      ],
      signal
    )
    const out: VersionEntry[] = []
    for (const res of all) {
      const below = partsBelow(res.href, base)
      if (below?.length !== 1 || !/^\d{1,20}$/.test(below[0] as string)) continue
      const name = below[0] as string
      const size = propText(res, NS.D, 'getcontentlength')
      const at = timeOf(propText(res, NS.D, 'getlastmodified')) ?? Number(name) * 1000
      out.push({
        version: name,
        modifiedAt: utc(at),
        ...(size && /^\d+$/.test(size) ? { sizeBytes: Number(size) } : {}),
      })
    }
    // a server that lists former versions only: the current one is added, by the second of its last change
    const m = modifiedOf(e)
    if (m !== undefined) {
      const current = String(Math.floor(m / 1000))
      if (!out.some((v) => v.version === current)) {
        const size = sizeOf(e)
        out.push({ version: current, modifiedAt: utc(m), ...(size !== undefined ? { sizeBytes: size } : {}) })
      }
    }
    return out.sort((a, b) => Number(b.version) - Number(a.version))
  }

  public async versions(args: Omit<FilesVersionsArgs, 'limit' | 'cursor'>, ctx: Paged) {
    const root = await this.root(args.root, ctx.signal)
    const e = await this.item(root, args.ref, 'ref', ctx.signal)
    if (isFolder(e)) throw errors.notSupported('A folder has no versions.')
    const all = await this.listVersions(e, ctx.signal)
    const key = (v: VersionEntry) => String(99_999_999_999_999_999_999n - BigInt(v.version)).padStart(21, '0')
    const page = pageByKey(all, key, ctx.page)
    return { versions: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }
  }
}

/** The XML of a `DASL` answer: whether a server offers `<DAV:basicsearch>` (RFC 5323). */
export function offersBasicSearch(header: string | undefined): boolean {
  return !!header && /<\s*DAV:basicsearch\s*>/i.test(header)
}
