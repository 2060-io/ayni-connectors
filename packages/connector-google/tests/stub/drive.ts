/**
 * A stub of the Drive API v3, the parts the connector uses, after Google's public documentation: `files` (get, list
 * with `q`, `corpora`, `driveId`, `includeItemsFromAllDrives`, `supportsAllDrives`, `orderBy`, pages; create and update,
 * with multipart uploads; `alt=media` with `Range`; export of Google's own documents), `permissions` (with
 * `permissionDetails` and inheritance down folders and from a shared drive's members), `revisions`, `drives` (create
 * with `requestId`, list, update) and `about`. A file of My Drive has one parent and an owner; a shared drive's top
 * folder has the drive's id. Roles rank `reader` < `commenter` < `writer` < `fileOrganizer` < `organizer` = `owner`.
 *
 * What Google's documentation leaves unsaid is the stub's own choice, listed in the package's README as a point to
 * check against a real account (the reasons of some refusals, how names split into words, idempotent `requestId`).
 */
import { EXPORT_LIMIT_BYTES, EXPORT_TYPES, FOLDER, GOOGLE_DOC, SHORTCUT } from '../../src/drive-map.js'
import {
  type Caller,
  digits,
  domainOf,
  driveId,
  fail,
  flag,
  iso,
  jsonBody,
  notFound,
  pageOf,
  type SentMessage,
  type StubRequest,
  type StubUser,
} from './core.js'
import { partial } from './fields.js'
import { matches, parseQuery, QueryError } from './query.js'

export type GRole = 'owner' | 'organizer' | 'fileOrganizer' | 'writer' | 'commenter' | 'reader'
const RANK: Record<GRole, number> = { reader: 1, commenter: 2, writer: 3, fileOrganizer: 4, organizer: 5, owner: 5 }

interface SPerm {
  id: string
  type: 'user' | 'group' | 'domain' | 'anyone'
  role: GRole
  userId?: string
  email?: string
  domain?: string
}

interface SRevision {
  id: string
  modifiedTime: number
  userId: string
  content: Buffer
  mimeType: string
}

export interface SFile {
  id: string
  name: string
  mimeType: string
  parent?: string
  driveId?: string
  explicitlyTrashed: boolean
  trashedTime?: number
  createdTime: number
  modifiedTime: number
  lastModifyingUserId?: string
  version: number
  revisions: SRevision[]
  docText?: string
  description?: string
  shortcutTarget?: string
  perms: SPerm[]
}

interface SDrive {
  id: string
  name: string
  createdTime: number
  /** the attempts of `drives.create`, by user and `requestId`, with the body each was made with */
  requests: Map<string, string>
  /** `restrictions.domainUsersOnly`: the drive takes members of its domain only */
  domainUsersOnly: boolean
  domain: string
}

const NATIVE_TYPES = new Set(Object.keys(EXPORT_TYPES))
const isGoogleType = (t: string) => t.startsWith('application/vnd.google-apps.')
const isTextType = (t: string) => /^text\/|^application\/(json|xml)|\+json$|\+xml$/.test(t)

export class StubDrive {
  public readonly files = new Map<string, SFile>()
  public readonly drives = new Map<string, SDrive>()
  private readonly roots = new Map<string, string>()

  public constructor(
    private readonly users: StubUser[],
    private readonly organization: string,
    private readonly send: (m: SentMessage) => void,
    private readonly now: () => number = () => Date.now()
  ) {
    for (const u of users) {
      const id = driveId('0A', 19)
      this.roots.set(u.id, id)
      this.files.set(id, this.newFile({ id, name: 'My Drive', mimeType: FOLDER }, u, undefined))
    }
  }

  // ---- by other means: what a test sets up at Drive directly

  public myDriveOf(userId: string): string {
    return this.roots.get(userId) as string
  }

  public user(id: string): StubUser {
    const u = this.users.find((x) => x.id === id)
    if (!u) throw new Error(`no user ${id}`)
    return u
  }

  public seedFolder(parent: string, name: string, owner: string): string {
    return this.seed(parent, { name, mimeType: FOLDER }, owner).id
  }

  public seedFile(parent: string, name: string, content: string | Buffer, owner: string, mimeType?: string): string {
    const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
    return this.seed(parent, { name, mimeType: mimeType ?? 'text/plain' }, owner, data).id
  }

  /** A document of Google's own: a Google Doc kept as Markdown, a Google Sheet as CSV. */
  public seedDocument(parent: string, name: string, text: string, owner: string, mimeType = GOOGLE_DOC): string {
    const f = this.seed(parent, { name, mimeType }, owner)
    f.docText = text
    return f.id
  }

  public seedShortcut(parent: string, name: string, target: string, owner: string): string {
    const f = this.seed(parent, { name, mimeType: SHORTCUT }, owner)
    f.shortcutTarget = target
    return f.id
  }

  public seedShare(fileId: string, userId: string, role: GRole): void {
    const f = this.mustFile(fileId)
    const u = this.user(userId)
    f.perms.push({ id: u.permissionId, type: 'user', role, userId, email: u.email })
  }

  private seed(parent: string, meta: { name: string; mimeType: string }, owner: string, content?: Buffer): SFile {
    const p = this.mustFile(parent)
    const f = this.newFile({ name: meta.name, mimeType: meta.mimeType, parent: p.id }, this.user(owner), content)
    if (p.driveId) {
      f.driveId = p.driveId
      f.perms = []
    }
    this.files.set(f.id, f)
    return f
  }

  private mustFile(id: string): SFile {
    const f = this.files.get(id)
    if (!f) throw new Error(`no file ${id}`)
    return f
  }

  private newFile(fields: Partial<SFile> & Pick<SFile, 'name' | 'mimeType'>, owner: StubUser, content?: Buffer): SFile {
    const now = this.now()
    const f: SFile = {
      id: fields.id ?? driveId(),
      explicitlyTrashed: false,
      createdTime: now,
      modifiedTime: now,
      lastModifyingUserId: owner.id,
      version: 1,
      revisions: [],
      perms: [{ id: owner.permissionId, type: 'user', role: 'owner', userId: owner.id, email: owner.email }],
      ...fields,
    }
    if (content !== undefined && !isGoogleType(f.mimeType) && f.mimeType !== FOLDER)
      f.revisions.push({ id: driveId('0B', 44), modifiedTime: now, userId: owner.id, content, mimeType: f.mimeType })
    else if (!isGoogleType(f.mimeType) && f.mimeType !== FOLDER)
      f.revisions.push({
        id: driveId('0B', 44),
        modifiedTime: now,
        userId: owner.id,
        content: Buffer.alloc(0),
        mimeType: f.mimeType,
      })
    return f
  }

  // ---- the model

  private chain(f: SFile): SFile[] {
    const out: SFile[] = []
    let n: SFile | undefined = f
    while (n && out.length < 200) {
      out.push(n)
      n = n.parent ? this.files.get(n.parent) : undefined
    }
    return out
  }

  private isTrashed(f: SFile): boolean {
    return this.chain(f).some((n) => n.explicitlyTrashed)
  }

  private isRootFolder(f: SFile): boolean {
    return [...this.roots.values()].includes(f.id) || this.drives.has(f.id)
  }

  /** Every permission that reaches a file: its own, then those of the folders above it, inherited. */
  private effective(f: SFile): { perm: SPerm; inherited: boolean; from: SFile }[] {
    const out: { perm: SPerm; inherited: boolean; from: SFile }[] = []
    for (const n of this.chain(f))
      for (const p of n.perms) {
        // an owner of a folder above reaches what it holds as a writer
        const perm = n !== f && p.role === 'owner' ? { ...p, role: 'writer' as GRole } : p
        out.push({ perm, inherited: n !== f, from: n })
      }
    return out
  }

  private grants(p: SPerm, u: StubUser): boolean {
    if (p.type === 'user' || p.type === 'group') return p.userId === u.id
    if (p.type === 'domain') return p.domain === domainOf(u.email)
    return p.type === 'anyone'
  }

  private rank(u: StubUser, f: SFile): number {
    let best = 0
    for (const e of this.effective(f)) if (this.grants(e.perm, u)) best = Math.max(best, RANK[e.perm.role])
    return best
  }

  /** A file the caller reaches; 404 otherwise, and for a file of a shared drive asked without `supportsAllDrives`. */
  private visible(r: StubRequest, id: string): SFile {
    const resolved = id === 'root' ? this.myDriveOf(r.caller.user.id) : id
    const f = this.files.get(resolved)
    if (!f || this.rank(r.caller.user, f) < 1) return notFound(`File not found: ${id}.`)
    if (f.driveId && !flag(r.url, 'supportsAllDrives', false)) return notFound(`File not found: ${id}.`)
    return f
  }

  private need(u: StubUser, f: SFile, rank: number): void {
    if (this.rank(u, f) < rank)
      fail(403, 'insufficientFilePermissions', 'The user does not have sufficient permissions for this file.')
  }

  private textOf(f: SFile): string {
    if (f.docText !== undefined) return f.docText
    const head = f.revisions[f.revisions.length - 1]
    return head && isTextType(head.mimeType) ? head.content.toString('utf8') : ''
  }

  private render(u: StubUser, f: SFile): Record<string, unknown> {
    const head = f.revisions[f.revisions.length - 1]
    const rank = this.rank(u, f)
    const drive = f.driveId ? this.drives.get(f.driveId) : undefined
    const by = f.lastModifyingUserId ? this.users.find((x) => x.id === f.lastModifyingUserId) : undefined
    const folder = f.mimeType === FOLDER
    const ids = [...new Set(this.effective(f).map((e) => e.perm.id))]
    const native = NATIVE_TYPES.has(f.mimeType)
    const web = native
      ? `https://docs.google.com/document/d/${f.id}/edit`
      : folder
        ? `https://drive.google.com/drive/folders/${f.id}`
        : `https://drive.google.com/file/d/${f.id}/view`
    return {
      kind: 'drive#file',
      id: f.id,
      name: drive && f.id === drive.id ? drive.name : f.name,
      mimeType: f.mimeType,
      ...(f.parent ? { parents: [f.parent] } : {}),
      ...(f.driveId ? { driveId: f.driveId } : {}),
      trashed: this.isTrashed(f),
      explicitlyTrashed: f.explicitlyTrashed,
      ...(f.driveId && f.trashedTime !== undefined ? { trashedTime: iso(f.trashedTime) } : {}),
      ...(head ? { size: String(head.content.length), headRevisionId: head.id } : {}),
      ...(native && f.docText !== undefined ? { size: String(Buffer.byteLength(f.docText)) } : {}),
      version: String(f.version),
      createdTime: iso(f.createdTime),
      modifiedTime: iso(f.modifiedTime),
      ...(by
        ? {
            lastModifyingUser: {
              kind: 'drive#user',
              displayName: by.name,
              emailAddress: by.email,
              permissionId: by.permissionId,
              me: by.id === u.id,
            },
          }
        : {}),
      webViewLink: web,
      ...(f.shortcutTarget
        ? {
            shortcutDetails: { targetId: f.shortcutTarget, targetMimeType: this.files.get(f.shortcutTarget)?.mimeType },
          }
        : {}),
      permissionIds: ids,
      ...(f.driveId
        ? {}
        : { ownedByMe: f.perms.some((p) => p.role === 'owner' && p.userId === u.id), shared: ids.length > 1 }),
      capabilities: {
        canAddChildren: folder && rank >= RANK.writer,
        canEdit: rank >= RANK.writer,
        canModifyContent: !folder && rank >= RANK.writer,
        canShare: rank >= RANK.writer,
        canRename: rank >= RANK.writer,
        canTrash: f.driveId ? rank >= RANK.fileOrganizer : f.perms.some((p) => p.role === 'owner' && p.userId === u.id),
        canDownload: rank >= RANK.reader,
        canListChildren: folder && rank >= RANK.reader,
        canReadRevisions: rank >= RANK.writer,
      },
    }
  }

  private permissionsOf(f: SFile): Record<string, unknown>[] {
    const byId = new Map<string, { perm: SPerm; details: Record<string, unknown>[] }>()
    for (const e of this.effective(f)) {
      const entry = byId.get(e.perm.id) ?? { perm: e.perm, details: [] }
      if (RANK[e.perm.role] > RANK[entry.perm.role]) entry.perm = { ...entry.perm, role: e.perm.role }
      entry.details.push({
        permissionType: f.driveId && e.from.id === f.driveId ? 'member' : 'file',
        role: e.perm.role,
        inherited: e.inherited,
        ...(f.driveId && e.inherited ? { inheritedFrom: e.from.id } : {}),
      })
      byId.set(e.perm.id, entry)
    }
    return [...byId.values()].map(({ perm, details }) => this.permissionView(perm, details))
  }

  private permissionView(p: SPerm, details?: Record<string, unknown>[]): Record<string, unknown> {
    const u = p.userId ? this.users.find((x) => x.id === p.userId) : undefined
    return {
      kind: 'drive#permission',
      id: p.id,
      type: p.type,
      role: p.role,
      ...(p.email ? { emailAddress: p.email } : {}),
      ...(p.domain ? { domain: p.domain } : {}),
      ...(u ? { displayName: u.name } : p.domain ? { displayName: p.domain } : {}),
      deleted: false,
      ...(details ? { permissionDetails: details } : {}),
    }
  }

  // ---- the methods

  public handle(r: StubRequest, api: 'drive' | 'upload'): Response {
    const [a, b, c, d] = r.parts
    const m = r.method
    if (api === 'upload') {
      if (a === 'files' && b === undefined && m === 'POST') return this.uploadCreate(r)
      if (a === 'files' && b !== undefined && c === undefined && m === 'PATCH') return this.uploadUpdate(r, b)
      return notFound('Method')
    }
    if (a === 'about' && m === 'GET') return this.about(r)
    if (a === 'drives') {
      if (b === undefined && m === 'POST') return this.createDrive(r)
      if (b === undefined && m === 'GET') return this.listDrives(r)
      if (b !== undefined && m === 'PATCH') return this.updateDrive(r, b)
      if (b !== undefined && m === 'GET') return this.answer(r, this.driveView(r.caller.user, this.mustDrive(r, b)))
    }
    if (a === 'files') {
      if (b === undefined && m === 'GET') return this.list(r)
      if (b === undefined && m === 'POST') return this.createMetadata(r)
      if (b !== undefined && c === undefined && m === 'GET') return this.get(r, b)
      if (b !== undefined && c === undefined && m === 'PATCH') return this.update(r, b)
      if (b !== undefined && c === 'export' && m === 'GET') return this.export(r, b)
      if (b !== undefined && c === 'permissions') {
        if (d === undefined && m === 'GET') return this.listPermissions(r, b)
        if (d === undefined && m === 'POST') return this.createPermission(r, b)
        if (d !== undefined && m === 'PATCH') return this.updatePermission(r, b, d)
        if (d !== undefined && m === 'DELETE') return this.deletePermission(r, b, d)
      }
      if (b !== undefined && c === 'revisions') {
        if (d === undefined && m === 'GET') return this.listRevisions(r, b)
        if (d !== undefined && m === 'GET') return this.getRevision(r, b, d)
      }
    }
    return notFound('Method')
  }

  private answer(r: StubRequest, value: unknown, defaults?: string, status = 200): Response {
    return Response.json(partial(value, r.url.searchParams.get('fields'), defaults), { status })
  }

  private about(r: StubRequest): Response {
    if (!r.url.searchParams.get('fields'))
      return fail(400, 'required', "The 'fields' parameter is required for this method.")
    const u = r.caller.user
    return this.answer(r, {
      kind: 'drive#about',
      user: { kind: 'drive#user', displayName: u.name, emailAddress: u.email, permissionId: u.permissionId, me: true },
      canCreateDrives: u.canCreateDrives,
    })
  }

  private get(r: StubRequest, id: string): Response {
    const f = this.visible(r, id)
    if (r.url.searchParams.get('alt') === 'media') return this.media(r, f, f.revisions[f.revisions.length - 1])
    return this.answer(r, this.render(r.caller.user, f), 'kind,id,name,mimeType')
  }

  private media(r: StubRequest, f: SFile, rev: SRevision | undefined): Response {
    if (isGoogleType(f.mimeType) || f.mimeType === FOLDER || !rev)
      return fail(
        403,
        'fileNotDownloadable',
        'Only files with binary content can be downloaded. Use Export with Docs Editors files.'
      )
    const range = /^bytes=(\d+)-(\d*)$/.exec(r.headers.get('range') ?? '')
    if (range) {
      const from = Number(range[1])
      const to = range[2] ? Math.min(Number(range[2]), rev.content.length - 1) : rev.content.length - 1
      const slice = rev.content.subarray(from, to + 1)
      return new Response(slice, {
        status: 206,
        headers: { 'content-type': rev.mimeType, 'content-range': `bytes ${from}-${to}/${rev.content.length}` },
      })
    }
    return new Response(rev.content, { status: 200, headers: { 'content-type': rev.mimeType } })
  }

  private list(r: StubRequest): Response {
    const u = r.caller.user
    const p = r.url.searchParams
    const corpora = p.get('corpora') ?? 'user'
    const drive = p.get('driveId')
    if (corpora === 'drive') {
      if (!drive) return fail(400, 'invalid', 'The driveId parameter is required for the drive corpus.')
      if (!flag(r.url, 'includeItemsFromAllDrives', false) || !flag(r.url, 'supportsAllDrives', false))
        return fail(400, 'invalid', 'includeItemsFromAllDrives must be true when driveId is given.')
      const top = this.files.get(drive)
      if (!top || !this.drives.has(drive) || this.rank(u, top) < 1) return notFound(`Shared drive not found: ${drive}`)
    } else if (corpora !== 'user' && corpora !== 'allDrives') return fail(400, 'invalid', 'Invalid Value')
    let query: ReturnType<typeof parseQuery> | undefined
    try {
      query = p.get('q') ? parseQuery(p.get('q') as string) : undefined
    } catch (e) {
      return fail(400, 'invalid', `Invalid Value${e instanceof QueryError ? `: ${e.message}` : ''}`)
    }
    const candidates = [...this.files.values()].filter((f) => {
      if (this.isRootFolder(f) || this.rank(u, f) < 1) return false
      if (corpora === 'drive') return f.driveId === drive
      if (corpora === 'user') return f.driveId === undefined
      return f.driveId === undefined || flag(r.url, 'includeItemsFromAllDrives', false)
    })
    const kept = candidates.filter(
      (f) =>
        !query ||
        matches(query, {
          name: f.name,
          mimeType: f.mimeType,
          parents: f.parent ? [f.parent] : [],
          trashed: this.isTrashed(f),
          sharedWithMe:
            f.driveId === undefined &&
            f.perms.some((x) => x.userId === u.id && x.type === 'user' && x.role !== 'owner'),
          fullText: `${f.name} ${f.description ?? ''} ${this.textOf(f)}`,
        })
    )
    const orderBy = p.get('orderBy')
    if (orderBy) {
      const keys = orderBy.split(',').map((k) => k.trim())
      for (const k of keys)
        if (!['folder', 'name', 'name_natural', 'createdTime', 'modifiedTime'].includes(k.replace(/ desc$/, '')))
          return fail(400, 'invalid', 'Invalid Value')
      kept.sort((x, y) => {
        for (const k of keys) {
          const desc = k.endsWith(' desc') ? -1 : 1
          const key = k.replace(/ desc$/, '')
          const cmp =
            key === 'folder'
              ? Number(y.mimeType === FOLDER) - Number(x.mimeType === FOLDER)
              : key === 'name' || key === 'name_natural'
                ? x.name.localeCompare(y.name)
                : key === 'createdTime'
                  ? x.createdTime - y.createdTime
                  : x.modifiedTime - y.modifiedTime
          if (cmp !== 0) return cmp * desc
        }
        return 0
      })
    }
    const binding = JSON.stringify([u.id, p.get('q'), corpora, drive, orderBy])
    const page = pageOf(kept, r.url, binding, { size: 100, max: 1000 })
    return this.answer(
      r,
      {
        kind: 'drive#fileList',
        incompleteSearch: false,
        ...(page.next ? { nextPageToken: page.next } : {}),
        files: page.items.map((f) => this.render(u, f)),
      },
      'kind,incompleteSearch,nextPageToken,files(kind,id,name,mimeType)'
    )
  }

  /** A new file in a folder the caller may add to (files.create). */
  private create(r: StubRequest, meta: Record<string, unknown>, content?: Buffer, contentType?: string): SFile {
    const u = r.caller.user
    const parentId = (meta.parents as string[] | undefined)?.[0] ?? this.myDriveOf(u.id)
    if ((meta.parents as string[] | undefined)?.length && (meta.parents as string[]).length > 1)
      fail(403, 'cannotAddParent', 'Increasing the number of parents is not allowed.')
    const parent = this.visible(r, parentId)
    if (parent.mimeType !== FOLDER || this.isTrashed(parent)) notFound(`File not found: ${parentId}.`)
    this.need(u, parent, RANK.writer)
    const mimeType = String(meta.mimeType ?? contentType ?? 'application/octet-stream')
    const f = this.newFile({ name: String(meta.name ?? 'Untitled'), mimeType, parent: parent.id }, u, undefined)
    if (parent.driveId) {
      f.driveId = parent.driveId
      f.perms = []
    }
    if (typeof meta.description === 'string') f.description = meta.description
    if (mimeType === GOOGLE_DOC && content) f.docText = content.toString('utf8')
    else if (content && f.revisions[0]) {
      f.revisions[0].content = content
    }
    this.files.set(f.id, f)
    return f
  }

  private createMetadata(r: StubRequest): Response {
    const f = this.create(r, jsonBody(r))
    return this.answer(r, this.render(r.caller.user, f), 'kind,id,name,mimeType')
  }

  /** The parts of an upload (Drive's guide to uploads: `media`, or `multipart` with `multipart/related`). */
  private uploadParts(r: StubRequest): { meta: Record<string, unknown>; content: Buffer; contentType: string } {
    const type = r.url.searchParams.get('uploadType')
    const ct = r.headers.get('content-type') ?? ''
    if (type === 'media') return { meta: {}, content: r.body, contentType: ct }
    if (type !== 'multipart') return fail(400, 'invalid', 'Invalid uploadType')
    const boundary = /boundary=([^;]+)/.exec(ct)?.[1]
    if (!/^multipart\/related/.test(ct) || !boundary) return fail(400, 'badContent', 'Bad multipart request')
    const sep = Buffer.from(`--${boundary}`)
    const parts: Buffer[] = []
    let at = r.body.indexOf(sep)
    while (at >= 0) {
      const next = r.body.indexOf(sep, at + sep.length)
      if (next < 0) break
      parts.push(r.body.subarray(at + sep.length, next))
      at = next
    }
    if (parts.length !== 2) return fail(400, 'badContent', 'A multipart upload has two parts')
    const split = (p: Buffer) => {
      const end = p.indexOf('\r\n\r\n')
      const head = p.subarray(0, end).toString('utf8')
      let data = p.subarray(end + 4)
      if (data.subarray(data.length - 2).toString() === '\r\n') data = data.subarray(0, data.length - 2)
      return { head, data }
    }
    const first = split(parts[0] as Buffer)
    const second = split(parts[1] as Buffer)
    if (!/content-type:\s*application\/json/i.test(first.head)) return fail(400, 'badContent', 'Metadata first')
    const media = /content-type:\s*([^\r\n]+)/i.exec(second.head)?.[1]?.trim() ?? 'application/octet-stream'
    return { meta: JSON.parse(first.data.toString('utf8') || '{}'), content: second.data, contentType: media }
  }

  private uploadCreate(r: StubRequest): Response {
    const { meta, content, contentType } = this.uploadParts(r)
    if (content.length > 5_000_000 && r.url.searchParams.get('uploadType') !== 'resumable')
      return fail(400, 'badContent', 'Media larger than 5 MB takes a resumable upload.')
    const f = this.create(r, meta, content, contentType)
    return this.answer(r, this.render(r.caller.user, f), 'kind,id,name,mimeType')
  }

  private uploadUpdate(r: StubRequest, id: string): Response {
    const u = r.caller.user
    const f = this.visible(r, id)
    const { meta, content, contentType } = this.uploadParts(r)
    this.need(u, f, RANK.writer)
    if (f.mimeType === FOLDER) return fail(400, 'badRequest', 'A folder has no content.')
    if (isGoogleType(f.mimeType)) {
      // Drive imports a text into a Google document; the stub converts into no other of Google's types
      if (f.mimeType !== GOOGLE_DOC || !/^text\/(plain|markdown)/.test(contentType))
        return fail(400, 'badRequest', 'The provided file type is not supported for conversion.')
      f.docText = content.toString('utf8')
    } else {
      const mimeType = String(meta.mimeType ?? f.mimeType)
      f.mimeType = mimeType
      f.revisions.push({ id: driveId('0B', 44), modifiedTime: this.now(), userId: u.id, content, mimeType })
    }
    if (typeof meta.name === 'string') f.name = meta.name
    f.version++
    f.modifiedTime = this.now()
    f.lastModifyingUserId = u.id
    return this.answer(r, this.render(u, f), 'kind,id,name,mimeType')
  }

  private update(r: StubRequest, id: string): Response {
    const u = r.caller.user
    const f = this.visible(r, id)
    const body = jsonBody(r)
    const add = r.url.searchParams.get('addParents')
    const remove = r.url.searchParams.get('removeParents')
    if (body.name !== undefined || add || remove) this.need(u, f, RANK.writer)
    if (add || remove) {
      if (remove && remove !== f.parent) return fail(400, 'badRequest', 'The parent to remove is not a parent.')
      if (add && !remove) return fail(403, 'cannotAddParent', 'Increasing the number of parents is not allowed.')
      if (add) {
        const dest = this.visible(r, add)
        if (dest.mimeType !== FOLDER) return fail(400, 'badRequest', 'The parent is not a folder.')
        if (dest.driveId !== f.driveId) return fail(403, 'teamDrivesFolderMoveInNotSupported', 'Not supported.')
        if (this.chain(dest).some((n) => n.id === f.id))
          return fail(400, 'badRequest', 'A folder cannot be its own descendant.')
        this.need(u, dest, RANK.writer)
        f.parent = dest.id
      }
    }
    if (typeof body.name === 'string') {
      f.name = body.name
      f.modifiedTime = this.now()
    }
    if (typeof body.description === 'string') f.description = body.description
    if (typeof body.trashed === 'boolean') {
      const may = f.driveId
        ? this.rank(u, f) >= RANK.fileOrganizer
        : f.perms.some((p) => p.role === 'owner' && p.userId === u.id)
      if (!may)
        return fail(403, 'insufficientFilePermissions', 'The user does not have sufficient permissions for this file.')
      if (body.trashed) {
        if (!f.explicitlyTrashed) {
          f.explicitlyTrashed = true
          f.trashedTime = this.now()
        }
      } else {
        f.explicitlyTrashed = false
        f.trashedTime = undefined
      }
    }
    f.version++
    return this.answer(r, this.render(u, f), 'kind,id,name,mimeType')
  }

  private exported(f: SFile, type: string): Buffer {
    const text = f.docText ?? ''
    if (type === 'text/markdown' || type === 'text/csv') return Buffer.from(text, 'utf8')
    if (type === 'text/plain') return Buffer.from(text.replace(/^#+\s*/gm, '').replace(/[*_`]/g, ''), 'utf8')
    if (type === 'text/tab-separated-values') return Buffer.from(text.replace(/,/g, '\t'), 'utf8')
    if (type === 'text/html') return Buffer.from(`<html><body><p>${text}</p></body></html>`, 'utf8')
    if (type === 'application/pdf') return Buffer.from(`%PDF-1.4\n% ${f.name}\n${text}\n%%EOF\n`, 'utf8')
    return Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.from(text, 'utf8')])
  }

  private export(r: StubRequest, id: string): Response {
    const f = this.visible(r, id)
    if (!NATIVE_TYPES.has(f.mimeType)) return fail(403, 'fileNotExportable', 'Export only supports Docs Editors files.')
    const type = r.url.searchParams.get('mimeType') ?? ''
    if (!(EXPORT_TYPES[f.mimeType] ?? []).includes(type))
      return fail(400, 'badRequest', 'The requested conversion is not supported.')
    const out = this.exported(f, type)
    if (out.length > EXPORT_LIMIT_BYTES)
      return fail(403, 'exportSizeLimitExceeded', 'This file is too large to be exported.')
    return new Response(out, { status: 200, headers: { 'content-type': type } })
  }

  private listRevisions(r: StubRequest, id: string): Response {
    const f = this.visible(r, id)
    this.need(r.caller.user, f, RANK.writer)
    const revisions = f.revisions.map((v) => this.revisionView(v))
    const page = pageOf(revisions, r.url, JSON.stringify(['rev', f.id]), { size: 200, max: 1000 })
    return this.answer(r, {
      kind: 'drive#revisionList',
      ...(page.next ? { nextPageToken: page.next } : {}),
      revisions: page.items,
    })
  }

  private revisionView(v: SRevision): Record<string, unknown> {
    const by = this.users.find((x) => x.id === v.userId)
    return {
      kind: 'drive#revision',
      id: v.id,
      mimeType: v.mimeType,
      modifiedTime: iso(v.modifiedTime),
      size: String(v.content.length),
      keepForever: false,
      ...(by ? { lastModifyingUser: { kind: 'drive#user', displayName: by.name, emailAddress: by.email } } : {}),
    }
  }

  private getRevision(r: StubRequest, id: string, rid: string): Response {
    const f = this.visible(r, id)
    this.need(r.caller.user, f, RANK.writer)
    const v = f.revisions.find((x) => x.id === rid)
    if (!v) return notFound(`Revision not found: ${rid}.`)
    if (r.url.searchParams.get('alt') === 'media') return this.media(r, f, v)
    return this.answer(r, this.revisionView(v))
  }

  private listPermissions(r: StubRequest, id: string): Response {
    const f = this.visible(r, id)
    this.need(r.caller.user, f, this.drives.has(f.id) ? RANK.reader : RANK.writer)
    const page = pageOf(this.permissionsOf(f), r.url, JSON.stringify(['perm', f.id]), { size: 100, max: 100 })
    return this.answer(r, {
      kind: 'drive#permissionList',
      ...(page.next ? { nextPageToken: page.next } : {}),
      permissions: page.items,
    })
  }

  /** Who may change the permissions of a file: an organizer for a shared drive's members, a writer for a file. */
  private mayShare(u: StubUser, f: SFile): void {
    this.need(u, f, this.drives.has(f.id) ? RANK.organizer : RANK.writer)
  }

  private createPermission(r: StubRequest, id: string): Response {
    const u = r.caller.user
    const f = this.visible(r, id)
    this.mayShare(u, f)
    const body = jsonBody<{ type?: SPerm['type']; role?: GRole; emailAddress?: string; domain?: string }>(r)
    const role = body.role
    if (!role || !(role in RANK) || role === 'owner') return fail(400, 'invalid', 'Invalid role.')
    if ((role === 'organizer' || role === 'fileOrganizer') && !f.driveId)
      return fail(400, 'invalid', 'This role is for shared drives only.')
    const notifyParam = r.url.searchParams.get('sendNotificationEmail')
    const message = r.url.searchParams.get('emailMessage')
    const drive = this.drives.get(f.id)
    let perm: SPerm
    if (body.type === 'user' || body.type === 'group') {
      if (notifyParam !== null && notifyParam !== 'true' && notifyParam !== 'false')
        fail(400, 'invalid', 'Invalid Value')
      const notify = notifyParam !== 'false'
      if (message && !notify) return fail(400, 'emailMessage', 'emailMessage is set without sendNotificationEmail.')
      const email = (body.emailAddress ?? '').toLowerCase()
      const target = this.users.find((x) => x.email.toLowerCase() === email)
      if (!target) {
        if (drive)
          return fail(
            403,
            'cannotShareTeamDriveWithNonGoogleAccounts',
            'Cannot share Team Drives with non Google accounts.'
          )
        if (!notify)
          return fail(
            400,
            'invalidSharingRequest',
            `Bad Request. User message: "You are trying to invite ${email}. Since there is no Google account associated with this email address, you must check the Notify people box to invite this recipient."`
          )
      }
      if (drive && target && drive.domainUsersOnly && domainOf(target.email) !== drive.domain)
        return fail(
          403,
          'teamDriveDomainUsersOnlyRestriction',
          'This shared drive is restricted to members of its domain.'
        )
      const pid = target?.permissionId ?? digits()
      const existing = f.perms.find((p) => p.id === pid)
      if (existing) existing.role = role
      perm = existing ?? {
        id: pid,
        type: body.type,
        role,
        email: target?.email ?? email,
        ...(target ? { userId: target.id } : {}),
      }
      if (!existing) f.perms.push(perm)
      if (notify)
        this.send({
          to: target?.email ?? email,
          kind: 'share',
          subject: `${u.name} shared "${f.name}" with you`,
          text: message ?? '',
        })
    } else if (body.type === 'domain' || body.type === 'anyone') {
      if (notifyParam !== null)
        return fail(403, 'sendNotificationEmails', 'sendNotificationEmail is for users and groups.')
      if (body.type === 'domain' && !body.domain) return fail(400, 'invalid', 'A domain is required.')
      const pid = body.type === 'anyone' ? 'anyoneWithLink' : `${digits(19)}k`
      const existing = f.perms.find((p) => p.type === body.type && (p.type === 'anyone' || p.domain === body.domain))
      if (existing) existing.role = role
      perm = existing ?? {
        id: pid,
        type: body.type,
        role,
        ...(body.domain ? { domain: body.domain.toLowerCase() } : {}),
      }
      if (!existing) f.perms.push(perm)
    } else return fail(400, 'invalid', 'Invalid permission type.')
    f.version++
    return this.answer(r, this.permissionView(perm), 'kind,id,type,role')
  }

  private updatePermission(r: StubRequest, id: string, pid: string): Response {
    const u = r.caller.user
    const f = this.visible(r, id)
    this.mayShare(u, f)
    const own = f.perms.find((p) => p.id === pid)
    if (!own) {
      if (this.effective(f).some((e) => e.perm.id === pid))
        return fail(403, 'cannotModifyInheritedTeamDrivePermission', 'An inherited permission is changed where it is.')
      return notFound(`Permission not found: ${pid}.`)
    }
    const role = jsonBody<{ role?: GRole }>(r).role
    if (!role || !(role in RANK) || role === 'owner') return fail(400, 'invalid', 'Invalid role.')
    own.role = role
    f.version++
    return this.answer(r, this.permissionView(own), 'kind,id,type,role')
  }

  private deletePermission(r: StubRequest, id: string, pid: string): Response {
    const u = r.caller.user
    const f = this.visible(r, id)
    this.mayShare(u, f)
    const own = f.perms.find((p) => p.id === pid)
    if (!own) {
      if (this.effective(f).some((e) => e.perm.id === pid))
        return fail(403, 'cannotModifyInheritedTeamDrivePermission', 'An inherited permission is changed where it is.')
      return notFound(`Permission not found: ${pid}.`)
    }
    if (own.role === 'owner') return fail(403, 'insufficientFilePermissions', 'The owner is not removed.')
    f.perms = f.perms.filter((p) => p !== own)
    f.version++
    return new Response(null, { status: 204 })
  }

  private driveView(u: StubUser, d: SDrive): Record<string, unknown> {
    const top = this.files.get(d.id) as SFile
    const rank = this.rank(u, top)
    return {
      kind: 'drive#drive',
      id: d.id,
      name: d.name,
      createdTime: iso(d.createdTime),
      hidden: false,
      capabilities: {
        canAddChildren: rank >= RANK.writer,
        canRenameDrive: rank >= RANK.organizer,
        canManageMembers: rank >= RANK.organizer,
        canShare: rank >= RANK.organizer,
      },
      restrictions: { domainUsersOnly: d.domainUsersOnly, driveMembersOnly: false },
    }
  }

  private mustDrive(r: StubRequest, id: string): SDrive {
    const d = this.drives.get(id)
    if (!d || this.rank(r.caller.user, this.files.get(id) as SFile) < 1)
      return notFound(`Shared drive not found: ${id}`)
    return d
  }

  private createDrive(r: StubRequest): Response {
    const u = r.caller.user
    const requestId = r.url.searchParams.get('requestId')
    if (!requestId) return fail(400, 'required', 'Required parameter: requestId')
    if (!u.canCreateDrives) return fail(403, 'insufficientFilePermissions', 'The user cannot create shared drives.')
    const body = jsonBody<{ name?: string }>(r)
    const key = `${u.id}:${requestId}`
    const bodyText = JSON.stringify(body)
    for (const d of this.drives.values()) {
      const before = d.requests.get(key)
      if (before === undefined) continue
      // the same request again answers the drive it made; another body with the same requestId is a conflict
      if (before === bodyText) return this.answer(r, this.driveView(u, d), 'kind,id,name')
      return fail(409, 'duplicate', 'A shared drive was already created with this request id.')
    }
    const id = driveId('0A', 19)
    const d: SDrive = {
      id,
      name: String(body.name ?? 'Untitled'),
      createdTime: this.now(),
      requests: new Map([[key, bodyText]]),
      domainUsersOnly: true,
      domain: this.organization,
    }
    this.drives.set(id, d)
    const top = this.newFile({ id, name: d.name, mimeType: FOLDER, driveId: id }, u, undefined)
    top.perms = [{ id: u.permissionId, type: 'user', role: 'organizer', userId: u.id, email: u.email }]
    this.files.set(id, top)
    return this.answer(r, this.driveView(u, d), 'kind,id,name')
  }

  private listDrives(r: StubRequest): Response {
    const u = r.caller.user
    const mine = [...this.drives.values()].filter((d) => this.rank(u, this.files.get(d.id) as SFile) >= 1)
    const page = pageOf(mine, r.url, JSON.stringify(['drives', u.id]), { size: 10, max: 100 })
    return this.answer(r, {
      kind: 'drive#driveList',
      ...(page.next ? { nextPageToken: page.next } : {}),
      drives: page.items.map((d) => this.driveView(u, d)),
    })
  }

  private updateDrive(r: StubRequest, id: string): Response {
    const u = r.caller.user
    const d = this.mustDrive(r, id)
    this.need(u, this.files.get(id) as SFile, RANK.organizer)
    const body = jsonBody<{ name?: string }>(r)
    if (typeof body.name === 'string') {
      d.name = body.name
      ;(this.files.get(id) as SFile).name = body.name
    }
    return this.answer(r, this.driveView(u, d), 'kind,id,name')
  }

  /** Who reaches a file: for the tests of the stub itself. */
  public reaches(userId: string, fileId: string): boolean {
    const f = this.files.get(fileId)
    return !!f && this.rank(this.user(userId), f) >= 1
  }

  public callerOf(c: Caller): StubUser {
    return c.user
  }
}
