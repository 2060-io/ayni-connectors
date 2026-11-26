/**
 * Google Drive as a provider of Files 1.0 (providers §6, the Google column of files §6). A reference is Drive's file
 * id, the same for every account that reaches the item, so a rename or a move keeps it and every root is portable; a
 * root is a folder (the account's My Drive, a shared drive, a folder shared with the account, or any folder below);
 * an item is inside a root when the root is found among its parents, one parent at a time (FEAT-CORE-012, 013). A
 * shared drive is a team root (`team-roots`, `manager: true`). Drive compares no version on a write, so the connector
 * compares, then writes: `atomicWrites: false`.
 */
import type { Content, FilesDeclaration, Item, Root, Share, VersionEntry } from '@ayni.org/ayni-feature-profiles'
import { type CallContext, errors, type FilesProvider, pageByOffset } from '@ayni.org/ayni-provider-kit'
import {
  type DriveFile,
  type DrivePermission,
  domainOf,
  driveRoleOfItem,
  driveRoleOfMember,
  EXPORT_LIMIT_BYTES,
  EXPORT_TYPES,
  FILE_FIELDS,
  FOLDER,
  GOOGLE_DOC,
  holdsWords,
  isGoogleType,
  isNative,
  isTextType,
  kindOf,
  MAX_DRIVE_MEMBERS,
  mediaTypeOfName,
  NO_ACCOUNT_REASONS,
  NOT_ALLOWED_REASONS,
  nameToShow,
  PERMISSION_FIELDS,
  quote,
  readTypeOf,
  SHORTCUT,
  searchQuery,
  shareOf,
  snippetOf,
  versionOf,
  wordsOf,
} from './drive-map.js'
import { type GoogleClient, isGoogleError, profileErrorOf, seg } from './google.js'
import { allPages, fillPage, type GooglePage } from './pages.js'
import { instantOf, utc } from './time.js'

export interface GoogleAccount {
  token: string
}

type Ctx = CallContext<GoogleAccount, FilesDeclaration>

const MIB = 1024 * 1024
/** Drive takes a file of 5 MB at most in one multipart upload (Drive's guide to uploads). */
export const WRITE_BYTES = 5_000_000
/** How much of a text file is read to make a snippet. */
const SNIPPET_READ_BYTES = 256 * 1024
/** The size of Google's pages the connector asks for. */
const GOOGLE_PAGE = 100

export const FILES_DECLARATION: FilesProvider['declaration'] = {
  capabilities: ['search', 'folders', 'trash', 'share', 'versions', 'export', 'team-roots'],
  limits: { page: 100, readBytes: 10 * MIB, writeBytes: WRITE_BYTES },
  atomicWrites: false,
  search: { content: true },
  share: { audiences: ['organization', 'anyone'], notify: true },
  'team-roots': { manager: true },
}

interface RootRef {
  /** the reference the call gave */
  arg: string
  file: DriveFile
  /** a shared drive: its id is that of its top folder */
  drive: boolean
}

interface Located {
  path: string
  /** the folders above the item, from its parent up to the root */
  ancestors: string[]
}

const ALL_DRIVES = { supportsAllDrives: true }

/** One call's work at Drive: the client, and the files read during the call, each once. */
class DriveCall {
  private readonly cache = new Map<string, Promise<DriveFile>>()
  private aboutAddress?: Promise<string>

  public constructor(
    public readonly g: GoogleClient,
    public readonly ctx: Ctx
  ) {}

  /** A file by its id; `not-found` when Drive knows none for the account. */
  public getFile(id: string, fresh = false): Promise<DriveFile> {
    const cached = this.cache.get(id)
    if (cached && !fresh) return cached
    const p = this.g
      .json<DriveFile>('drive', 'GET', `/files/${seg(id)}`, { query: { ...ALL_DRIVES, fields: FILE_FIELDS } })
      .catch((e) => {
        throw profileErrorOf(e)
      })
    this.cache.set(id, p)
    return p
  }

  public remember(f: DriveFile): void {
    this.cache.set(f.id, Promise.resolve(f))
  }

  /** The account's address at Google, for the audience of its domain. */
  public address(): Promise<string> {
    this.aboutAddress ??= this.g
      .json<{ user?: { emailAddress?: string } }>('drive', 'GET', '/about', { query: { fields: 'user(emailAddress)' } })
      .then((a) => {
        const address = a.user?.emailAddress
        if (!address) throw errors.unavailable('Google did not give the address of the account.')
        return address
      })
      .catch((e) => {
        throw profileErrorOf(e)
      })
    return this.aboutAddress
  }

  /** The root of a call: a folder the account reaches, not in the trash; `not-found` otherwise. */
  public async root(arg: string): Promise<RootRef> {
    const file = await this.getFile(arg)
    if (file.mimeType !== FOLDER || file.trashed) throw errors.notFound()
    return { arg, file, drive: file.driveId !== undefined && file.driveId === file.id }
  }

  /** Where an item is under the root, found up its parents; `not-found` for an item the root does not hold. */
  public async locate(root: RootRef, f: DriveFile): Promise<Located> {
    if (f.id === root.file.id) return { path: '/', ancestors: [] }
    const names = [f.name]
    const ancestors: string[] = []
    let current = f
    for (let depth = 0; depth < 110; depth++) {
      const parent = current.parents?.[0]
      if (!parent) break
      ancestors.push(parent)
      if (parent === root.file.id) return { path: `/${names.reverse().join('/')}`, ancestors }
      let up: DriveFile
      try {
        up = await this.getFile(parent)
      } catch (e) {
        if (isNotFound(e)) break
        throw e
      }
      names.push(up.name)
      current = up
    }
    throw errors.notFound()
  }

  /** An item the root holds, not in the trash, with where it is. */
  public async itemIn(root: RootRef, ref: string): Promise<{ f: DriveFile; at: Located }> {
    const f = await this.getFile(ref)
    if (f.trashed) throw errors.notFound()
    return { f, at: await this.locate(root, f) }
  }

  /** A folder the root holds: the root itself when absent; `not-supported` for a file or a link. */
  public async folderIn(root: RootRef, ref: string | undefined): Promise<{ f: DriveFile; at: Located }> {
    if (ref === undefined) return { f: root.file, at: { path: '/', ancestors: [] } }
    const found = await this.itemIn(root, ref)
    if (found.f.mimeType !== FOLDER)
      throw errors.notSupported(
        found.f.mimeType === SHORTCUT ? 'A link is not followed.' : 'This item is not a folder.',
        'folder'
      )
    return found
  }

  /** The profile's item of a file found under a root. */
  public item(root: RootRef, f: DriveFile, at: Located, now?: number): Item {
    const isRoot = f.id === root.file.id
    const kind = kindOf(f.mimeType)
    const out: Item = {
      ref: isRoot ? root.arg : f.id,
      root: root.arg,
      kind,
      name: f.name || 'Untitled',
      path: at.path,
    }
    const parent = f.parents?.[0]
    if (!isRoot && parent) out.parent = parent === root.file.id ? root.arg : parent
    if (kind === 'file') {
      out.mediaType = f.mimeType || 'application/octet-stream'
      const version = versionOf(f)
      if (version) out.version = version
      if (!isGoogleType(f.mimeType) && f.size !== undefined && /^\d+$/.test(f.size)) out.sizeBytes = Number(f.size)
    }
    const created = instantOf(f.createdTime)
    const modified = instantOf(f.modifiedTime)
    if (created) out.createdAt = created
    if (modified) out.modifiedAt = modified
    const by = nameToShow(f.lastModifyingUser?.displayName)
    if (by) out.modifiedBy = by
    if (kind === 'file' && isNative(f.mimeType)) {
      out.native = true
      out.exportTypes = [...(EXPORT_TYPES[f.mimeType] ?? [])]
    }
    // shared: someone reaches the item who does not reach the root (files §1, FEAT-FILES-054)
    const rootIds = root.file.permissionIds
    if (!isRoot && rootIds && f.permissionIds?.some((id) => !rootIds.includes(id))) out.shared = true
    if (f.trashed) {
      // Drive gives the time of trashing for items of shared drives only; for others, the last change, or now
      out.trashedAt = instantOf(f.trashedTime) ?? (now !== undefined ? utc(now) : (modified ?? utc(Date.now())))
    }
    if (f.webViewLink) out.webUrl = f.webViewLink
    return out
  }

  /** Drive's corpus of a root's items (providers §6: `driveId`, `corpora`, `supportsAllDrives`). */
  public corpus(root: RootRef): Record<string, string | boolean> {
    return root.file.driveId
      ? { corpora: 'drive', driveId: root.file.driveId, includeItemsFromAllDrives: true, ...ALL_DRIVES }
      : { corpora: 'user', includeItemsFromAllDrives: true, ...ALL_DRIVES }
  }

  /** A page of Drive's files of a query. */
  public async listFiles(
    q: string,
    corpus: Record<string, string | boolean>,
    token: string | undefined,
    orderBy?: string
  ): Promise<GooglePage<DriveFile>> {
    try {
      const data = await this.g.json<{ files?: DriveFile[]; nextPageToken?: string }>('drive', 'GET', '/files', {
        query: {
          q,
          ...corpus,
          pageSize: GOOGLE_PAGE,
          ...(token ? { pageToken: token } : {}),
          ...(orderBy ? { orderBy } : {}),
          fields: `nextPageToken,files(${FILE_FIELDS})`,
        },
      })
      for (const f of data.files ?? []) this.remember(f)
      return { items: data.files ?? [], ...(data.nextPageToken ? { next: data.nextPageToken } : {}) }
    } catch (e) {
      throw profileErrorOf(e)
    }
  }

  /** Whether a folder holds an item of a name, other than one (files §1: no two items of one name). */
  public async nameTaken(root: RootRef, folderId: string, name: string, except?: string): Promise<boolean> {
    const page = await this.listFiles(
      `${quote(folderId)} in parents and name = ${quote(name)} and trashed = false`,
      this.corpus(root),
      undefined
    )
    return page.items.some((f) => f.name === name && f.id !== except)
  }

  /** A file's bytes; for a text, the first `max + 4` bytes when it is longer, so that a cut falls inside them. */
  public async download(f: DriveFile, max?: number): Promise<Buffer> {
    const size = f.size !== undefined ? Number(f.size) : Number.NaN
    const headers: Record<string, string> = {}
    if (max !== undefined && Number.isFinite(size) && size > max + 4) headers.range = `bytes=0-${max + 3}`
    try {
      return await this.g.bytes('drive', `/files/${seg(f.id)}`, { query: { alt: 'media', ...ALL_DRIVES }, headers })
    } catch (e) {
      throw profileErrorOf(e)
    }
  }

  /** A document of Google's own, exported. */
  public async exported(f: DriveFile, mediaType: string): Promise<Buffer> {
    try {
      return await this.g.bytes('drive', `/files/${seg(f.id)}/export`, { query: { mimeType: mediaType } })
    } catch (e) {
      if (isGoogleError(e) && e.status === 403 && e.reason === 'exportSizeLimitExceeded')
        throw errors.tooLarge(EXPORT_LIMIT_BYTES, undefined, 'Google exports no document larger than 10 MB.')
      throw profileErrorOf(e)
    }
  }

  /** The text of a file, for a snippet: a text file's start, a native document's export; none for other files. */
  public async textOf(f: DriveFile): Promise<string | undefined> {
    try {
      if (isNative(f.mimeType)) {
        const type = readTypeOf(f.mimeType)
        return type ? (await this.exported(f, type)).toString('utf8') : undefined
      }
      if (kindOf(f.mimeType) !== 'file' || isGoogleType(f.mimeType) || !isTextType(f.mimeType)) return undefined
      return decodeText(await this.download(f, SNIPPET_READ_BYTES))
    } catch {
      return undefined
    }
  }

  /** Uploads a content with its metadata, in one multipart request (Drive's guide to uploads). */
  public async upload(
    method: 'POST' | 'PATCH',
    path: string,
    metadata: Record<string, unknown>,
    content: Buffer,
    mediaType: string
  ): Promise<DriveFile> {
    const boundary = `ayni-${crypto.randomUUID()}`
    const head = Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\nContent-Type: ${mediaType}\r\n\r\n`,
      'utf8'
    )
    const tail = Buffer.from(`\r\n--${boundary}--`, 'utf8')
    try {
      const f = await this.g.json<DriveFile>('upload', method, path, {
        query: { uploadType: 'multipart', ...ALL_DRIVES, fields: FILE_FIELDS },
        body: Buffer.concat([head, content, tail]),
        contentType: `multipart/related; boundary=${boundary}`,
      })
      this.remember(f)
      return f
    } catch (e) {
      throw profileErrorOf(e)
    }
  }

  /** A change of a file's metadata. */
  public async patch(
    id: string,
    body: Record<string, unknown>,
    query: Record<string, string> = {}
  ): Promise<DriveFile> {
    try {
      const f = await this.g.json<DriveFile>('drive', 'PATCH', `/files/${seg(id)}`, {
        query: { ...query, ...ALL_DRIVES, fields: FILE_FIELDS },
        json: body,
      })
      this.remember(f)
      return f
    } catch (e) {
      throw profileErrorOf(e)
    }
  }

  /** Every permission of a file or a shared drive. */
  public async permissions(id: string): Promise<DrivePermission[]> {
    try {
      return await allPages(async (token) => {
        const data = await this.g.json<{ permissions?: DrivePermission[]; nextPageToken?: string }>(
          'drive',
          'GET',
          `/files/${seg(id)}/permissions`,
          {
            query: {
              ...ALL_DRIVES,
              pageSize: GOOGLE_PAGE,
              ...(token ? { pageToken: token } : {}),
              fields: `nextPageToken,permissions(${PERMISSION_FIELDS})`,
            },
          }
        )
        return { items: data.permissions ?? [], ...(data.nextPageToken ? { next: data.nextPageToken } : {}) }
      })
    } catch (e) {
      throw profileErrorOf(e)
    }
  }
}

function isNotFound(e: unknown): boolean {
  return (e as { code?: string } | undefined)?.code === 'not-found'
}

/** A text decoded as UTF-8, its byte order mark removed (FEAT-FILES-014). */
function decodeText(bytes: Buffer): string {
  const text = bytes.toString('utf8')
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function bytesOf(content: { text: string } | { base64: string }): Buffer {
  return 'text' in content ? Buffer.from(content.text, 'utf8') : Buffer.from(content.base64, 'base64')
}

/** A media type of Google's own is never written: the provider converts nothing to a format of the store (files §3.5). */
function checkWrittenType(mediaType: string | undefined): void {
  if (mediaType?.toLowerCase().startsWith('application/vnd.google-apps.'))
    throw errors.invalidArgument('mediaType', 'A type of Google’s own documents is not written as a content.')
}

function rootView(f: DriveFile, path: string, drive: boolean, canAdd?: boolean): Root {
  return {
    ref: f.id,
    title: f.name,
    path,
    writable: canAdd ?? f.capabilities?.canAddChildren === true,
    portable: true,
    ...(drive ? { team: true as const } : {}),
  }
}

interface SharedDrive {
  id: string
  name: string
  capabilities?: { canAddChildren?: boolean }
}

const DRIVE_FIELDS = 'id,name,capabilities(canAddChildren)'

function driveView(d: SharedDrive): Root {
  return {
    ref: d.id,
    title: d.name,
    path: `/${d.name}`,
    writable: d.capabilities?.canAddChildren === true,
    portable: true,
    team: true,
  }
}

/** The provider of Files over Drive, for every account: each call carries its own token. */
export function driveProvider(
  client: (ctx: Ctx) => GoogleClient
): FilesProvider<GoogleAccount> & Required<Pick<FilesProvider<GoogleAccount>, 'search'>> {
  const call = (ctx: Ctx) => new DriveCall(client(ctx), ctx)

  /** The account's places at the top: its My Drive, its shared drives, the folders shared with it. */
  async function tops(c: DriveCall): Promise<{ root: Root; file?: DriveFile; driveId?: string }[]> {
    const mine = await c.getFile('root')
    const drives = await allPages(async (token) => {
      const data = await c.g
        .json<{ drives?: SharedDrive[]; nextPageToken?: string }>('drive', 'GET', '/drives', {
          query: {
            pageSize: GOOGLE_PAGE,
            ...(token ? { pageToken: token } : {}),
            fields: `nextPageToken,drives(${DRIVE_FIELDS})`,
          },
        })
        .catch((e) => {
          throw profileErrorOf(e)
        })
      return { items: data.drives ?? [], ...(data.nextPageToken ? { next: data.nextPageToken } : {}) }
    })
    const shared = await allPages((token) =>
      c.listFiles(
        `sharedWithMe = true and mimeType = ${quote(FOLDER)} and trashed = false`,
        { corpora: 'user', ...ALL_DRIVES },
        token
      )
    )
    return [
      { root: rootView(mine, '/', false), file: mine },
      ...drives.map((d) => ({ root: driveView(d), driveId: d.id })),
      ...shared.filter((f) => f.id !== mine.id).map((f) => ({ root: rootView(f, `/${f.name}`, false), file: f })),
    ]
  }

  /** The folders a folder holds, one level. */
  async function subfolders(c: DriveCall, id: string, driveId: string | undefined): Promise<DriveFile[]> {
    const corpus = driveId
      ? { corpora: 'drive', driveId, includeItemsFromAllDrives: true, ...ALL_DRIVES }
      : { corpora: 'user', includeItemsFromAllDrives: true, ...ALL_DRIVES }
    return allPages((token) =>
      c.listFiles(`${quote(id)} in parents and mimeType = ${quote(FOLDER)} and trashed = false`, corpus, token)
    )
  }

  /**
   * The folders whose path begins with a text, the last part taken as unfinished (files §3.1, FEAT-FILES-003): each
   * full part is a folder's name, whatever the case, found one level at a time from the top of the account.
   */
  async function byPath(c: DriveCall, query: string): Promise<Root[]> {
    const parts = (query.startsWith('/') ? query : `/${query}`).slice(1).split('/')
    const placeOf = await tops(c)
    const mine = placeOf[0] as { root: Root; file: DriveFile }
    type Candidate = { id: string; name: string; path: string; driveId?: string; root?: Root; file?: DriveFile }
    let level: Candidate[] = [
      ...(await subfolders(c, mine.file.id, undefined)).map((f) => ({
        id: f.id,
        name: f.name,
        path: `/${f.name}`,
        file: f,
      })),
      ...placeOf.slice(1).map((p) => ({
        id: p.root.ref,
        name: p.root.title,
        path: p.root.path,
        ...(p.driveId ? { driveId: p.driveId } : {}),
        root: p.root,
        ...(p.file ? { file: p.file } : {}),
      })),
    ]
    const last = (parts[parts.length - 1] ?? '').toLowerCase()
    for (const part of parts.slice(0, -1)) {
      const matching = level.filter((x) => x.name.toLowerCase() === part.toLowerCase()).slice(0, 50)
      const next: Candidate[] = []
      for (const m of matching) {
        const driveId = m.driveId ?? m.file?.driveId
        for (const f of await subfolders(c, m.id, driveId))
          next.push({ id: f.id, name: f.name, path: `${m.path}/${f.name}`, ...(driveId ? { driveId } : {}), file: f })
      }
      level = next
    }
    const found = level
      .filter((x) => x.name.toLowerCase().startsWith(last))
      .map((x) => x.root ?? rootView(x.file as DriveFile, x.path, false))
    return parts.length === 1 && last === '' ? [mine.root, ...found] : found
  }

  const provider: FilesProvider<GoogleAccount> & Required<Pick<FilesProvider<GoogleAccount>, 'search'>> = {
    declaration: FILES_DECLARATION,

    async roots(args, ctx) {
      const c = call(ctx)
      const list = args.query === undefined ? (await tops(c)).map((t) => t.root) : await byPath(c, args.query)
      const page = pageByOffset(list.slice(0, 2000), ctx.page)
      return { roots: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }
    },

    async list(args, ctx) {
      const c = call(ctx)
      const root = await c.root(args.root)
      const folder = await c.folderIn(root, args.folder)
      const base = folder.at.path === '/' ? '' : folder.at.path
      const page = await fillPage(
        (token) =>
          c.listFiles(`${quote(folder.f.id)} in parents and trashed = false`, c.corpus(root), token, 'folder,name'),
        (f) =>
          f.parents?.[0] === folder.f.id ? c.item(root, f, { path: `${base}/${f.name}`, ancestors: [] }) : undefined,
        ctx.page
      )
      return {
        folder: c.item(root, folder.f, folder.at),
        items: page.items,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      }
    },

    async get(args, ctx) {
      const c = call(ctx)
      const root = await c.root(args.root)
      const { f, at } = await c.itemIn(root, args.ref)
      return { item: c.item(root, f, at) }
    },

    async read(args, ctx) {
      const c = call(ctx)
      const root = await c.root(args.root)
      const { f, at } = await c.itemIn(root, args.ref)
      const kind = kindOf(f.mimeType)
      if (kind !== 'file')
        throw errors.notSupported(kind === 'link' ? 'A link is not read through.' : 'A folder is not read as a file.')
      const item = c.item(root, f, at)
      const max = Math.min(args.maxBytes ?? ctx.limits.readBytes, ctx.limits.readBytes)
      if (isGoogleType(f.mimeType)) {
        if (args.version !== undefined && args.version !== item.version)
          throw errors.notSupported('Drive gives a former version of a Google document only outside its interface.')
        const type = readTypeOf(f.mimeType)
        if (!type) throw errors.notSupported('Drive gives this document neither as bytes nor as a text.')
        return { item, content: { kind: 'text', text: decodeText(await c.exported(f, type)), mediaType: type } }
      }
      let source: DriveFile = f
      let mediaType = f.mimeType || 'application/octet-stream'
      let path = `/files/${seg(f.id)}`
      if (args.version !== undefined && args.version !== item.version) {
        const rev = await c.g
          .json<{ id: string; mimeType?: string; size?: string }>(
            'drive',
            'GET',
            `/files/${seg(f.id)}/revisions/${seg(args.version)}`,
            { query: { fields: 'id,mimeType,size' } }
          )
          .catch((e) => {
            const pe = profileErrorOf(e)
            throw pe.code === 'not-found' ? errors.notFound('The file has no such version.') : pe
          })
        mediaType = rev.mimeType ?? mediaType
        source = { ...f, ...(rev.size !== undefined ? { size: rev.size } : {}) }
        path = `/files/${seg(f.id)}/revisions/${seg(rev.id)}`
      }
      const size = source.size !== undefined ? Number(source.size) : Number.NaN
      const text = isTextType(mediaType)
      if (!text && Number.isFinite(size) && size > ctx.limits.readBytes)
        throw errors.tooLarge(ctx.limits.readBytes, size)
      const headers: Record<string, string> = {}
      if (text && Number.isFinite(size) && size > max + 4) headers.range = `bytes=0-${max + 3}`
      const bytes = await c.g
        .bytes('drive', path, { query: { alt: 'media', ...(path.includes('/revisions/') ? {} : ALL_DRIVES) }, headers })
        .catch((e) => {
          throw profileErrorOf(e)
        })
      if (text) return { item, content: { kind: 'text', text: decodeText(bytes), mediaType } }
      if (bytes.length > ctx.limits.readBytes) throw errors.tooLarge(ctx.limits.readBytes, bytes.length)
      return { item, content: { kind: 'bytes', base64: bytes.toString('base64'), mediaType } }
    },

    async create(args, ctx) {
      const c = call(ctx)
      const root = await c.root(args.root)
      const folder = await c.folderIn(root, args.folder)
      checkWrittenType(args.mediaType)
      if (await c.nameTaken(root, folder.f.id, args.name)) throw errors.alreadyExists()
      const isText = 'text' in args.content
      const mediaType =
        args.mediaType ?? mediaTypeOfName(args.name) ?? (isText ? 'text/plain' : 'application/octet-stream')
      const made = await c.upload(
        'POST',
        '/files',
        { name: args.name, parents: [folder.f.id], mimeType: mediaType },
        bytesOf(args.content),
        mediaType
      )
      const base = folder.at.path === '/' ? '' : folder.at.path
      return { item: c.item(root, made, { path: `${base}/${made.name}`, ancestors: [] }) }
    },

    async replace(args, ctx) {
      const c = call(ctx)
      const root = await c.root(args.root)
      const { f, at } = await c.itemIn(root, args.ref)
      const kind = kindOf(f.mimeType)
      if (kind !== 'file') throw errors.notSupported('Only a file has a content to replace.')
      checkWrittenType(args.mediaType)
      let metadata: Record<string, unknown>
      let mediaType: string
      if (isGoogleType(f.mimeType)) {
        // Drive converts a text into a Google document on an upload; into no other of its own types
        if (f.mimeType !== GOOGLE_DOC || !('text' in args.content))
          throw errors.notSupported('Google converts no such content into this document.')
        metadata = {}
        mediaType = args.mediaType === 'text/plain' ? 'text/plain' : 'text/markdown'
      } else {
        mediaType = args.mediaType ?? f.mimeType
        metadata = { mimeType: mediaType }
      }
      // compared, then written: Drive takes no precondition on an upload (atomicWrites: false)
      const current = versionOf(f)
      if (args.ifVersion !== current) throw errors.versionMismatch(current ?? '')
      const made = await c.upload('PATCH', `/files/${seg(f.id)}`, metadata, bytesOf(args.content), mediaType)
      return { item: c.item(root, made, at) }
    },

    async search(args, ctx) {
      const c = call(ctx)
      const root = await c.root(args.root)
      const folder = await c.folderIn(root, args.folder)
      const words = wordsOf(args.query)
      const where = args.in ?? 'any'
      const page = await fillPage(
        (token) => c.listFiles(searchQuery(words, where), c.corpus(root), token),
        async (f): Promise<(Item & { snippet?: string }) | undefined> => {
          if (f.id === folder.f.id || f.trashed) return undefined
          let at: Located
          try {
            at = await c.locate(root, f)
          } catch (e) {
            if (isNotFound(e)) return undefined
            throw e
          }
          if (folder.f.id !== root.file.id && !at.ancestors.includes(folder.f.id)) return undefined
          const item = c.item(root, f, at)
          const byName = holdsWords(f.name, words)
          if (where === 'name') return byName ? item : undefined
          if (where === 'any' && byName) return item
          // found by its content: a snippet from its text, where the connector can read one
          const text = await c.textOf(f)
          if (text === undefined) return item
          const snippet = snippetOf(text, words)
          if (snippet) return { ...item, snippet }
          return where === 'content' && byName ? undefined : item
        },
        ctx.page
      )
      return { items: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }
    },

    async createFolder(args, ctx) {
      const c = call(ctx)
      const root = await c.root(args.root)
      const folder = await c.folderIn(root, args.folder)
      if (await c.nameTaken(root, folder.f.id, args.name)) throw errors.alreadyExists()
      const made = await c.g
        .json<DriveFile>('drive', 'POST', '/files', {
          query: { ...ALL_DRIVES, fields: FILE_FIELDS },
          json: { name: args.name, mimeType: FOLDER, parents: [folder.f.id] },
        })
        .catch((e) => {
          throw profileErrorOf(e)
        })
      const base = folder.at.path === '/' ? '' : folder.at.path
      return { item: c.item(root, made, { path: `${base}/${made.name}`, ancestors: [] }) }
    },

    async move(args, ctx) {
      const c = call(ctx)
      const root = await c.root(args.root)
      const { f, at } = await c.itemIn(root, args.ref)
      if (f.id === root.file.id) throw errors.notSupported('The root itself is not moved or renamed.')
      const from = f.parents?.[0] as string
      const dest = args.toFolder === undefined ? undefined : await c.folderIn(root, args.toFolder)
      const destId = dest?.f.id ?? from
      if (f.mimeType === FOLDER && dest && (dest.f.id === f.id || dest.at.ancestors.includes(f.id)))
        throw errors.invalidArgument('toFolder', 'A folder is not moved into itself.')
      if (args.ifVersion !== undefined && kindOf(f.mimeType) === 'file' && args.ifVersion !== versionOf(f))
        throw errors.versionMismatch(versionOf(f) ?? '')
      const name = args.newName ?? f.name
      if (await c.nameTaken(root, destId, name, f.id)) throw errors.alreadyExists()
      const query: Record<string, string> = destId !== from ? { addParents: destId, removeParents: from } : {}
      const moved = await c.patch(f.id, args.newName !== undefined ? { name: args.newName } : {}, query)
      const destPath = dest ? dest.at.path : at.path.slice(0, at.path.lastIndexOf('/')) || '/'
      const base = destPath === '/' ? '' : destPath
      return { item: c.item(root, moved, { path: `${base}/${moved.name}`, ancestors: [] }) }
    },

    async trash(args, ctx) {
      const c = call(ctx)
      const root = await c.root(args.root)
      const { f, at } = await c.itemIn(root, args.ref)
      if (f.id === root.file.id) throw errors.notSupported('The root itself is not moved to the trash.')
      if (args.ifVersion !== undefined && kindOf(f.mimeType) === 'file' && args.ifVersion !== versionOf(f))
        throw errors.versionMismatch(versionOf(f) ?? '')
      const done = await c.patch(f.id, { trashed: true })
      return { item: c.item(root, done, at, Date.now()) }
    },

    async restore(args, ctx) {
      const c = call(ctx)
      const root = await c.root(args.root)
      const f = await c.getFile(args.ref)
      if (!f.trashed || !f.explicitlyTrashed) throw errors.notFound('The item is not in the trash of this folder.')
      const parentId = f.parents?.[0]
      if (!parentId) throw errors.notFound('The folder the item left is gone.')
      const parent = await c.getFile(parentId).catch((e) => {
        throw isNotFound(e) ? errors.notFound('The folder the item left is gone.') : e
      })
      if (parent.trashed) throw errors.notFound('The folder the item left is gone.')
      const at = await c.locate(root, f)
      if (await c.nameTaken(root, parentId, f.name, f.id)) throw errors.alreadyExists()
      const done = await c.patch(f.id, { trashed: false })
      return { item: c.item(root, done, at) }
    },

    async listTrash(args, ctx) {
      const c = call(ctx)
      const root = await c.root(args.root)
      const page = await fillPage(
        (token) => c.listFiles('trashed = true', c.corpus(root), token),
        async (f) => {
          if (!f.explicitlyTrashed) return undefined
          try {
            return c.item(root, f, await c.locate(root, f))
          } catch (e) {
            if (isNotFound(e)) return undefined
            throw e
          }
        },
        ctx.page
      )
      return { items: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }
    },

    async shares(args, ctx) {
      const c = call(ctx)
      const root = await c.root(args.root)
      const { f } = await c.itemIn(root, args.ref)
      const team = root.drive && f.id === root.file.id
      const perms = await c.permissions(f.id)
      return { shares: sharesOf(perms, f, team) }
    },

    async share(args, ctx) {
      const c = call(ctx)
      const root = await c.root(args.root)
      const { f } = await c.itemIn(root, args.ref)
      const team = root.drive && f.id === root.file.id
      const notify = args.notify !== false
      const made: Share[] = []
      if (team) {
        if (args.audience !== undefined)
          throw errors.notSupported('A shared drive takes members by address only.', 'audience')
        const members = (await c.permissions(f.id)).filter((p) => !p.deleted)
        for (const r of args.recipients ?? []) {
          const role = driveRoleOfMember(args.role)
          const existing = members.find((p) => p.emailAddress?.toLowerCase() === r.address.toLowerCase())
          if (existing) {
            // sharing again replaces the role (files §4.7)
            const p =
              existing.role === role
                ? existing
                : await c.g
                    .json<DrivePermission>('drive', 'PATCH', `/files/${seg(f.id)}/permissions/${seg(existing.id)}`, {
                      query: { ...ALL_DRIVES, fields: PERMISSION_FIELDS },
                      json: { role },
                    })
                    .catch((e) => {
                      throw profileErrorOf(e)
                    })
            made.push(shareOf(p, f.webViewLink, true))
            continue
          }
          if (members.length >= MAX_DRIVE_MEMBERS)
            throw errors.recipientRefused('too-many', 'The shared drive holds as many members as Google allows.')
          const p = await c.g
            .json<DrivePermission>('drive', 'POST', `/files/${seg(f.id)}/permissions`, {
              query: {
                ...ALL_DRIVES,
                sendNotificationEmail: notify,
                ...(notify && args.message ? { emailMessage: args.message } : {}),
                fields: PERMISSION_FIELDS,
              },
              json: { type: 'user', role, emailAddress: r.address },
            })
            .catch((e) => {
              throw memberRefusal(e)
            })
          members.push(p)
          made.push(shareOf(p, f.webViewLink, true))
        }
        return { shares: made }
      }
      if (args.role === 'manager') throw errors.notSupported('The role "manager" is for a shared drive.', 'role')
      const role = driveRoleOfItem(args.role)
      const create = async (body: Record<string, unknown>, query: Record<string, string | boolean>) => {
        const p = await c.g
          .json<DrivePermission>('drive', 'POST', `/files/${seg(f.id)}/permissions`, {
            query: { ...ALL_DRIVES, ...query, fields: PERMISSION_FIELDS },
            json: body,
          })
          .catch((e) => {
            if (isGoogleError(e) && e.status === 400 && e.reason === 'invalidSharingRequest')
              throw errors.permissionDenied('Google does not share this item with this address.')
            throw profileErrorOf(e)
          })
        made.push(shareOf(p, f.webViewLink))
      }
      for (const r of args.recipients ?? [])
        await create(
          { type: 'user', role, emailAddress: r.address },
          { sendNotificationEmail: notify, ...(notify && args.message ? { emailMessage: args.message } : {}) }
        )
      if (args.audience === 'organization')
        await create({ type: 'domain', role, domain: domainOf(await c.address()), allowFileDiscovery: false }, {})
      if (args.audience === 'anyone') await create({ type: 'anyone', role, allowFileDiscovery: false }, {})
      return { shares: made }
    },

    async unshare(args, ctx) {
      const c = call(ctx)
      const root = await c.root(args.root)
      const { f } = await c.itemIn(root, args.ref)
      const team = root.drive && f.id === root.file.id
      if (!team) {
        const own = sharesOf(await c.permissions(f.id), f, false).find((s) => s.id === args.share)
        if (!own) throw errors.notFound('The item has no such share.')
        if (own.inherited) throw errors.notSupported('This share comes from a folder above and is ended there.')
      }
      await c.g
        .request('drive', 'DELETE', `/files/${seg(f.id)}/permissions/${seg(args.share)}`, {
          query: ALL_DRIVES,
          read: 'none',
        })
        .catch((e) => {
          const pe = profileErrorOf(e)
          throw pe.code === 'not-found' ? errors.notFound('The item has no such share.') : pe
        })
      return { shares: sharesOf(await c.permissions(f.id), f, team) }
    },

    async versions(args, ctx) {
      const c = call(ctx)
      const root = await c.root(args.root)
      const { f } = await c.itemIn(root, args.ref)
      if (kindOf(f.mimeType) !== 'file') throw errors.notSupported('Only a file has versions.')
      if (isGoogleType(f.mimeType))
        throw errors.notSupported('Drive gives the former versions of a Google document only outside its interface.')
      const revisions = await allPages(async (token) => {
        const data = await c.g
          .json<{
            revisions?: {
              id: string
              modifiedTime?: string
              size?: string
              lastModifyingUser?: { displayName?: string }
            }[]
            nextPageToken?: string
          }>('drive', 'GET', `/files/${seg(f.id)}/revisions`, {
            query: {
              pageSize: 1000,
              ...(token ? { pageToken: token } : {}),
              fields: 'nextPageToken,revisions(id,modifiedTime,size,lastModifyingUser(displayName))',
            },
          })
          .catch((e) => {
            throw profileErrorOf(e)
          })
        return { items: data.revisions ?? [], ...(data.nextPageToken ? { next: data.nextPageToken } : {}) }
      })
      // newest first (files §4.5): Drive's reference does not say in which order it lists revisions
      const ordered = revisions
        .map((r, i) => ({ r, i, at: Date.parse(r.modifiedTime ?? '') }))
        .sort((x, y) => (Number.isNaN(y.at) ? 0 : y.at) - (Number.isNaN(x.at) ? 0 : x.at) || y.i - x.i)
        .map((x) => x.r)
      const entries: VersionEntry[] = ordered.map((r) => {
        const by = nameToShow(r.lastModifyingUser?.displayName)
        return {
          version: r.id,
          modifiedAt: instantOf(r.modifiedTime) ?? utc(Date.now()),
          ...(by ? { modifiedBy: by } : {}),
          ...(r.size !== undefined && /^\d+$/.test(r.size) ? { sizeBytes: Number(r.size) } : {}),
        }
      })
      const page = pageByOffset(entries, ctx.page)
      return { versions: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }
    },

    async export(args, ctx) {
      const c = call(ctx)
      const root = await c.root(args.root)
      const { f, at } = await c.itemIn(root, args.ref)
      const types = EXPORT_TYPES[f.mimeType]
      if (!types?.includes(args.mediaType))
        throw errors.notSupported('The file is not given in this format.', 'mediaType')
      const bytes = await c.exported(f, args.mediaType)
      const content: Content = isTextType(args.mediaType)
        ? { kind: 'text', text: decodeText(bytes), mediaType: args.mediaType }
        : { kind: 'bytes', base64: bytes.toString('base64'), mediaType: args.mediaType }
      return { item: c.item(root, f, at), content }
    },

    async createTeamRoot(args, ctx) {
      const c = call(ctx)
      // the requestId is Google's identifier of the attempt: the same request again makes no second drive
      const d = await c.g
        .json<SharedDrive>('drive', 'POST', '/drives', {
          query: { requestId: args.requestId, fields: DRIVE_FIELDS },
          json: { name: args.name },
        })
        .catch((e) => {
          if (isGoogleError(e) && e.status === 409)
            throw errors.alreadyExists('Google no longer takes this request: give another requestId.')
          throw profileErrorOf(e)
        })
      return { root: { ...driveView(d), writable: true } }
    },

    async renameRoot(args, ctx) {
      const c = call(ctx)
      const root = await c.root(args.root)
      if (!root.drive) throw errors.notSupported('Only a shared drive is renamed.')
      const d = await c.g
        .json<SharedDrive>('drive', 'PATCH', `/drives/${seg(root.file.id)}`, {
          query: { fields: DRIVE_FIELDS },
          json: { name: args.name },
        })
        .catch((e) => {
          throw profileErrorOf(e)
        })
      return { root: { ...driveView(d), ref: root.arg } }
    },
  }
  return provider
}

/** The shares of an item: its permissions but its owner's; the members of a shared drive, none inherited. */
function sharesOf(perms: DrivePermission[], f: DriveFile, team: boolean): Share[] {
  return perms.filter((p) => p.role !== 'owner' && !p.deleted).map((p) => shareOf(p, f.webViewLink, team))
}

/** Why a shared drive does not take an address (providers §6, FEAT-FILES-072). */
function memberRefusal(e: unknown) {
  if (isGoogleError(e)) {
    if (e.reason && NO_ACCOUNT_REASONS.has(e.reason))
      return errors.recipientRefused('no-account', 'The address is no Google account.')
    if (e.status === 400 && e.reason === 'invalidSharingRequest')
      return errors.recipientRefused('no-account', 'Google cannot make this address a member.')
    if (e.reason && NOT_ALLOWED_REASONS.has(e.reason))
      return errors.recipientRefused(
        'not-allowed',
        'The organization does not let this shared drive take that address.'
      )
  }
  return profileErrorOf(e)
}
