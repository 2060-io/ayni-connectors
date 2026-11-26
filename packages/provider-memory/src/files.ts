/**
 * A file store in memory, and its provider of Files 1.0 with every capability (files §1 to §4). References are
 * identifiers of the store's own, so that a rename or a move keeps them, and the same for every account: every root is
 * portable. Roles are inherited down a tree; a share on a folder reaches what it holds.
 */
import type {
  Audience,
  FilesCapability,
  FilesDeclaration,
  Item,
  Limits,
  Role,
  Root,
  Share,
} from '@ayni.org/ayni-feature-profiles'
import { type CallContext, errors, type FilesProvider, pageByKey, pageByOffset } from '@ayni.org/ayni-provider-kit'
import type { MemoryService, MemoryUser } from './store.js'
import { utc } from './time.js'

export interface MemoryFilesOptions {
  /** the capabilities declared, every one when absent */
  capabilities?: FilesCapability[]
  /** whether `files_search` reads contents (`search.content`) */
  searchContent?: boolean
  audiences?: Audience[]
  /** whether the store tells the recipients of a share (`share.notify`) */
  notify?: boolean
  /** whether team roots have the role `manager` (`team-roots.manager`) */
  teamRootManager?: boolean
  /** whether a team root takes members outside the organization */
  teamRootOutside?: boolean
  maxTeamMembers?: number
  /** the domains of the organization at the store, for the audience `organization` */
  organizationDomains?: string[]
  /** the accounts that may create team roots, every one when absent */
  teamRootCreators?: string[]
  limits?: Partial<Limits>
  /** whether the store converts a text into its own documents on a replace */
  nativeConvertsText?: boolean
}

const MIB = 1024 * 1024
const ALL: FilesCapability[] = ['search', 'folders', 'trash', 'share', 'versions', 'export', 'team-roots']
const RANK: Record<Role, number> = { reader: 1, editor: 2, manager: 3 }
const NATIVE_TYPE = 'application/vnd.memory.document'
const EXPORT_TYPES = ['application/pdf', 'text/markdown', 'text/plain']

const EXTENSIONS: Record<string, string> = {
  md: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  html: 'text/html',
  json: 'application/json',
  xml: 'application/xml',
  ics: 'text/calendar',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  pdf: 'application/pdf',
  zip: 'application/zip',
}

export function mediaTypeOfName(name: string): string | undefined {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? EXTENSIONS[name.slice(dot + 1).toLowerCase()] : undefined
}

export function isTextType(mediaType: string): boolean {
  const t = mediaType.split(';')[0]?.trim().toLowerCase() ?? ''
  return (
    t.startsWith('text/') ||
    t === 'application/json' ||
    t === 'application/xml' ||
    t.endsWith('+json') ||
    t.endsWith('+xml')
  )
}

interface State {
  version: string
  data: Buffer
  mediaType: string
  at: number
  by: string
}

interface ShareRec {
  id: string
  role: Role
  userId?: string
  address?: string
  audience?: Audience
  link?: string
}

interface Team {
  members: Map<string, Role>
  creator: string
  requestKey: string
}

interface FileNode {
  id: string
  kind: 'file' | 'folder' | 'link'
  name: string
  parent?: string
  /** the account whose own folder this is */
  home?: string
  team?: Team
  mediaType?: string
  data?: Buffer
  native?: boolean
  version: string
  history: State[]
  createdAt: number
  modifiedAt: number
  modifiedBy?: string
  target?: string
  trashedAt?: number
  trashedFrom?: string
  shares: ShareRec[]
}

type Ctx = CallContext<MemoryUser, FilesDeclaration>

export class MemoryFiles {
  public readonly options: Required<Omit<MemoryFilesOptions, 'teamRootCreators' | 'limits'>> & {
    teamRootCreators?: string[]
    limits: Limits
  }
  private readonly nodes = new Map<string, FileNode>()

  public constructor(
    private readonly service: MemoryService,
    options: MemoryFilesOptions = {}
  ) {
    this.options = {
      capabilities: options.capabilities ?? ALL,
      searchContent: options.searchContent ?? true,
      audiences: options.audiences ?? ['organization', 'anyone'],
      notify: options.notify ?? true,
      teamRootManager: options.teamRootManager ?? true,
      teamRootOutside: options.teamRootOutside ?? false,
      maxTeamMembers: options.maxTeamMembers ?? 600,
      organizationDomains: options.organizationDomains ?? ['example.org'],
      nativeConvertsText: options.nativeConvertsText ?? true,
      limits: { page: 100, readBytes: MIB, writeBytes: 2 * MIB, ...(options.limits ?? {}) },
      ...(options.teamRootCreators ? { teamRootCreators: options.teamRootCreators } : {}),
    }
    for (const u of service.users) {
      const id = `home-${u.id}`
      this.nodes.set(id, this.newNode({ id, kind: 'folder', name: 'My files', home: u.id }, u.id))
    }
  }

  // ---- what the provider declares

  public declaration(): Omit<FilesDeclaration, 'version'> {
    const caps = this.options.capabilities
    return {
      capabilities: caps,
      limits: this.options.limits,
      atomicWrites: true,
      ...(caps.includes('search') ? { search: { content: this.options.searchContent } } : {}),
      ...(caps.includes('share') ? { share: { audiences: this.options.audiences, notify: this.options.notify } } : {}),
      ...(caps.includes('team-roots') ? { 'team-roots': { manager: this.options.teamRootManager } } : {}),
    }
  }

  // ---- by other means (common §13): what a test sets up at the store directly

  public homeOf(userId: string): string {
    return `home-${userId}`
  }

  public seedFolder(parentRef: string, name: string, by?: string): string {
    const parent = this.mustGet(parentRef)
    const node = this.newNode({ kind: 'folder', name, parent: parent.id }, by ?? this.ownerOf(parent))
    this.nodes.set(node.id, node)
    return node.id
  }

  /** A file, even of a name the folder already holds (two items of one name, FEAT-FILES-017), or a native document. */
  public seedFile(
    parentRef: string,
    name: string,
    content: string | Buffer,
    opts: { mediaType?: string; native?: boolean; by?: string } = {}
  ): string {
    const parent = this.mustGet(parentRef)
    const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
    const mediaType = opts.native
      ? NATIVE_TYPE
      : (opts.mediaType ?? mediaTypeOfName(name) ?? 'application/octet-stream')
    const node = this.newNode(
      { kind: 'file', name, parent: parent.id, data, mediaType, ...(opts.native ? { native: true } : {}) },
      opts.by ?? this.ownerOf(parent)
    )
    this.nodes.set(node.id, node)
    return node.id
  }

  /** A shortcut to an item elsewhere, never followed (FEAT-FILES-012). */
  public seedLink(parentRef: string, name: string, targetRef: string): string {
    const parent = this.mustGet(parentRef)
    const node = this.newNode({ kind: 'link', name, parent: parent.id, target: targetRef }, this.ownerOf(parent))
    this.nodes.set(node.id, node)
    return node.id
  }

  /** A share made at the store by other means. */
  public seedShare(ref: string, userId: string, role: Role): void {
    const node = this.mustGet(ref)
    node.shares.push({ id: this.service.next('s'), role, userId })
  }

  // ---- the model

  private newNode(fields: Partial<FileNode> & Pick<FileNode, 'kind' | 'name'>, by: string): FileNode {
    const now = this.service.now()
    return {
      id: fields.id ?? this.service.next('n'),
      version: this.service.next('v'),
      history: [],
      createdAt: now,
      modifiedAt: now,
      modifiedBy: by,
      shares: [],
      ...fields,
    }
  }

  private mustGet(ref: string): FileNode {
    const n = this.nodes.get(ref)
    if (!n) throw new Error(`no item ${ref}`)
    return n
  }

  private ownerOf(node: FileNode): string {
    for (const n of this.chain(node)) {
      if (n.home) return n.home
      if (n.team) return n.team.creator
    }
    return this.service.users[0]?.id ?? 'nobody'
  }

  /** The node, then each folder above it, to the top. */
  private chain(node: FileNode): FileNode[] {
    const out: FileNode[] = []
    let n: FileNode | undefined = node
    while (n && out.length < 1000) {
      out.push(n)
      n = n.parent ? this.nodes.get(n.parent) : undefined
    }
    return out
  }

  private trashed(node: FileNode): boolean {
    return this.chain(node).some((n) => n.trashedAt !== undefined)
  }

  private inOrganization(user: MemoryUser): boolean {
    const domain = user.email.slice(user.email.lastIndexOf('@') + 1).toLowerCase()
    return this.options.organizationDomains.includes(domain)
  }

  /** The role of an account on an item: its own folder's, a team root's membership, or a share above it. */
  private roleOn(user: MemoryUser, node: FileNode): Role | undefined {
    let best: Role | undefined
    const take = (r: Role) => {
      if (!best || RANK[r] > RANK[best]) best = r
    }
    for (const n of this.chain(node)) {
      if (n.home === user.id) take('editor')
      if (n.team) {
        const r = n.team.members.get(user.id)
        if (r) take(r)
        if (n.team.creator === user.id) take(this.options.teamRootManager ? 'manager' : 'editor')
      }
      for (const s of n.shares) {
        if (s.userId === user.id) take(s.role)
        if (s.audience === 'organization' && this.inOrganization(user)) take(s.role)
      }
    }
    return best
  }

  private mayManage(user: MemoryUser, root: FileNode): boolean {
    if (!root.team) return false
    return root.team.creator === user.id || root.team.members.get(user.id) === 'manager'
  }

  private inside(root: FileNode, node: FileNode): boolean {
    return this.chain(node).some((n) => n.id === root.id)
  }

  /** The root of a call: a folder the account reaches, not in the trash; `not-found` otherwise. */
  private rootOf(user: MemoryUser, ref: string): FileNode {
    const root = this.nodes.get(ref)
    if (root?.kind !== 'folder' || this.trashed(root) || !this.roleOn(user, root)) throw errors.notFound()
    return root
  }

  /** An item the root holds, not in the trash; `not-found` for anything else, an item elsewhere included (FEAT-CORE-012). */
  private itemIn(root: FileNode, ref: string): FileNode {
    const node = this.nodes.get(ref)
    if (!node || this.trashed(node) || !this.inside(root, node)) throw errors.notFound()
    return node
  }

  private folderIn(root: FileNode, ref: string | undefined): FileNode {
    const folder = ref === undefined ? root : this.itemIn(root, ref)
    if (folder.kind !== 'folder') throw errors.notSupported('This item is not a folder.')
    return folder
  }

  private pathOf(root: FileNode, node: FileNode, via?: FileNode): string {
    const names: string[] = []
    let n: FileNode | undefined = node
    if (via) {
      names.push(node.name)
      n = via
    }
    while (n && n.id !== root.id) {
      names.push(n.name)
      n = n.parent ? this.nodes.get(n.parent) : undefined
    }
    return `/${names.reverse().join('/')}`
  }

  private sharedBetween(root: FileNode, node: FileNode): boolean {
    for (const n of this.chain(node)) {
      if (n.id === root.id) return false
      if (n.shares.length > 0) return true
    }
    return false
  }

  private item(user: MemoryUser, root: FileNode, node: FileNode, extra: { trashedFrom?: FileNode } = {}): Item {
    const caps = this.options.capabilities
    const by = node.modifiedBy ? this.service.userById(node.modifiedBy)?.name : undefined
    const out: Item = {
      ref: node.id,
      root: root.id,
      kind: node.kind,
      name: node.name,
      path: node.id === root.id ? '/' : this.pathOf(root, node, extra.trashedFrom),
      ...(node.id !== root.id && (extra.trashedFrom || node.parent)
        ? { parent: extra.trashedFrom?.id ?? node.parent }
        : {}),
    }
    if (node.kind === 'file') {
      out.mediaType = node.mediaType ?? 'application/octet-stream'
      out.sizeBytes = node.data?.length ?? 0
      out.version = node.version
    }
    out.createdAt = utc(node.createdAt)
    out.modifiedAt = utc(node.modifiedAt)
    if (by) out.modifiedBy = by
    if (node.native) out.native = true
    if (caps.includes('share') && !extra.trashedFrom && this.sharedBetween(root, node)) out.shared = true
    if (node.trashedAt !== undefined) out.trashedAt = utc(node.trashedAt)
    if (caps.includes('export') && node.native) out.exportTypes = [...EXPORT_TYPES]
    out.webUrl = `https://files.memory.invalid/item/${node.id}`
    void user
    return out
  }

  private rootView(user: MemoryUser, node: FileNode, path: string): Root {
    const role = this.roleOn(user, node)
    return {
      ref: node.id,
      title: node.name,
      path,
      writable: !!role && RANK[role] >= RANK.editor,
      portable: true,
      ...(node.team ? { team: true as const } : {}),
    }
  }

  private children(folder: FileNode): FileNode[] {
    return [...this.nodes.values()].filter((n) => n.parent === folder.id && n.trashedAt === undefined)
  }

  private descendants(folder: FileNode): FileNode[] {
    const out: FileNode[] = []
    const walk = (f: FileNode) => {
      for (const c of this.children(f)) {
        out.push(c)
        if (c.kind === 'folder') walk(c)
      }
    }
    walk(folder)
    return out
  }

  private requireRole(user: MemoryUser, node: FileNode, role: Role): void {
    const r = this.roleOn(user, node)
    if (!r || RANK[r] < RANK[role]) throw errors.permissionDenied()
  }

  private nameTaken(folder: FileNode, name: string, except?: FileNode): boolean {
    return this.children(folder).some((c) => c.name === name && c !== except)
  }

  private touch(node: FileNode, user: MemoryUser): void {
    node.version = this.service.next('v')
    node.modifiedAt = this.service.now()
    node.modifiedBy = user.id
  }

  private guard(ctx: Ctx, write: boolean): MemoryUser {
    if (!this.service.available) throw errors.unavailable()
    if (write && this.service.askBeforeWrite)
      ctx.ask({ key: 'confirm-write', message: 'The store asks you to confirm this change.' })
    return ctx.account.data
  }

  private textOf(
    node: FileNode,
    data: Buffer,
    mediaType: string
  ): { kind: 'text'; text: string; mediaType: string } | undefined {
    if (node.native) return { kind: 'text', text: data.toString('utf8'), mediaType: 'text/markdown' }
    if (!isTextType(mediaType)) return undefined
    let text = data.toString('utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    return { kind: 'text', text, mediaType }
  }

  // ---- the provider of one account

  public provider(): FilesProvider<MemoryUser> {
    const caps = this.options.capabilities
    const self = this
    const provider: FilesProvider<MemoryUser> = {
      declaration: this.declaration(),

      roots(args, ctx) {
        const user = self.guard(ctx, false)
        const home = self.mustGet(self.homeOf(user.id))
        const top: { node: FileNode; path: string }[] = [{ node: home, path: '/' }]
        const others = [...self.nodes.values()]
          .filter((n) => n.kind === 'folder' && n.id !== home.id && !self.trashed(n) && self.roleOn(user, n))
          // a place the account reaches at the top: a team root, or a folder shared with it whose parent it does not reach
          .filter((n) => n.team || !n.parent || !self.roleOn(user, self.mustGet(n.parent)))
          .filter((n) => !n.home)
          .sort((a, b) => (a.name + a.id < b.name + b.id ? -1 : 1))
          .map((n) => ({ node: n, path: `/${n.name}` }))
        top.push(...others)
        let list = top
        if (args.query !== undefined) {
          const q = args.query.toLowerCase()
          const inHome = self
            .descendants(home)
            .filter((n) => n.kind === 'folder')
            .map((n) => ({ node: n, path: self.pathOf(home, n) }))
          list = [...top, ...inHome].filter((r) => r.path.toLowerCase().startsWith(q))
        }
        const page = pageByOffset(list, ctx.page)
        return {
          roots: page.items.map((r) => self.rootView(user, r.node, r.path)),
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        }
      },

      list(args, ctx) {
        const user = self.guard(ctx, false)
        const root = self.rootOf(user, args.root)
        const folder = self.folderIn(root, args.folder)
        const page = pageByKey(self.children(folder), (n) => `${n.name}\u0000${n.id}`, ctx.page)
        return {
          folder: self.item(user, root, folder),
          items: page.items.map((n) => self.item(user, root, n)),
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        }
      },

      get(args, ctx) {
        const user = self.guard(ctx, false)
        const root = self.rootOf(user, args.root)
        return { item: self.item(user, root, self.itemIn(root, args.ref)) }
      },

      read(args, ctx) {
        const user = self.guard(ctx, false)
        const root = self.rootOf(user, args.root)
        const node = self.itemIn(root, args.ref)
        if (node.kind !== 'file')
          throw errors.notSupported(
            node.kind === 'link' ? 'A link is not read through.' : 'A folder is not read as a file.'
          )
        let data = node.data ?? Buffer.alloc(0)
        let mediaType = node.mediaType ?? 'application/octet-stream'
        if (args.version !== undefined && args.version !== node.version) {
          const state = node.history.find((h) => h.version === args.version)
          if (!state) throw errors.notFound('The file has no such version.')
          data = state.data
          mediaType = state.mediaType
        }
        const text = self.textOf(node, data, mediaType)
        if (!text && data.length > ctx.limits.readBytes) throw errors.tooLarge(ctx.limits.readBytes, data.length)
        const content = text ?? { kind: 'bytes' as const, base64: data.toString('base64'), mediaType }
        return { item: self.item(user, root, node), content }
      },

      create(args, ctx) {
        const user = self.guard(ctx, false)
        const root = self.rootOf(user, args.root)
        const folder = self.folderIn(root, args.folder)
        self.requireRole(user, folder, 'editor')
        if (self.nameTaken(folder, args.name)) throw errors.alreadyExists()
        self.guard(ctx, true)
        const isText = 'text' in args.content
        const data = isText
          ? Buffer.from((args.content as { text: string }).text, 'utf8')
          : Buffer.from((args.content as { base64: string }).base64, 'base64')
        const mediaType =
          args.mediaType ?? mediaTypeOfName(args.name) ?? (isText ? 'text/plain' : 'application/octet-stream')
        const node = self.newNode({ kind: 'file', name: args.name, parent: folder.id, data, mediaType }, user.id)
        self.nodes.set(node.id, node)
        return { item: self.item(user, root, node) }
      },

      replace(args, ctx) {
        const user = self.guard(ctx, false)
        const root = self.rootOf(user, args.root)
        const node = self.itemIn(root, args.ref)
        if (node.kind !== 'file') throw errors.notSupported('Only a file has a content to replace.')
        self.requireRole(user, node, 'editor')
        if (node.native && (!self.options.nativeConvertsText || !('text' in args.content)))
          throw errors.notSupported('The store does not convert this content into its own document.')
        self.guard(ctx, true)
        // compared and written in one step: nothing runs between the two (atomicWrites)
        if (args.ifVersion !== node.version) throw errors.versionMismatch(node.version)
        const isText = 'text' in args.content
        const data = isText
          ? Buffer.from((args.content as { text: string }).text, 'utf8')
          : Buffer.from((args.content as { base64: string }).base64, 'base64')
        node.history.push({
          version: node.version,
          data: node.data ?? Buffer.alloc(0),
          mediaType: node.mediaType ?? 'application/octet-stream',
          at: node.modifiedAt,
          by: node.modifiedBy ?? user.id,
        })
        node.data = data
        if (args.mediaType !== undefined && !node.native) node.mediaType = args.mediaType
        self.touch(node, user)
        return { item: self.item(user, root, node) }
      },
    }

    if (caps.includes('search'))
      provider.search = (args, ctx) => {
        const user = self.guard(ctx, false)
        const root = self.rootOf(user, args.root)
        const folder = self.folderIn(root, args.folder)
        const words = args.query.toLowerCase().split(/\s+/).filter(Boolean)
        const where = args.in ?? 'any'
        const found: (Item & { snippet?: string })[] = []
        for (const n of self.descendants(folder)) {
          const byName = where !== 'content' && words.every((w) => n.name.toLowerCase().includes(w))
          let snippet: string | undefined
          if (!byName && where !== 'name' && self.options.searchContent && n.kind === 'file' && n.data) {
            const text = self.textOf(n, n.data, n.mediaType ?? '')?.text
            const lower = text?.toLowerCase()
            if (text && lower && words.every((w) => lower.includes(w))) {
              const at = lower.indexOf(words[0] as string)
              snippet = text
                .slice(Math.max(0, at - 30), at + 60)
                .replace(/\s+/g, ' ')
                .trim()
            }
          }
          if (byName || snippet !== undefined)
            found.push({ ...self.item(user, root, n), ...(snippet ? { snippet } : {}) })
        }
        const page = pageByKey(found, (i) => `${i.path}\u0000${i.ref}`, ctx.page)
        return { items: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }
      }

    if (caps.includes('folders')) {
      provider.createFolder = (args, ctx) => {
        const user = self.guard(ctx, false)
        const root = self.rootOf(user, args.root)
        const folder = self.folderIn(root, args.folder)
        self.requireRole(user, folder, 'editor')
        if (self.nameTaken(folder, args.name)) throw errors.alreadyExists()
        self.guard(ctx, true)
        const node = self.newNode({ kind: 'folder', name: args.name, parent: folder.id }, user.id)
        self.nodes.set(node.id, node)
        return { item: self.item(user, root, node) }
      }
      provider.move = (args, ctx) => {
        const user = self.guard(ctx, false)
        const root = self.rootOf(user, args.root)
        const node = self.itemIn(root, args.ref)
        if (node.id === root.id) throw errors.notSupported('The root itself is not moved or renamed.')
        const parent = self.mustGet(node.parent as string)
        const dest = args.toFolder === undefined ? parent : self.itemIn(root, args.toFolder)
        if (dest.kind !== 'folder') throw errors.notSupported('The destination is not a folder.')
        if (node.kind === 'folder' && self.inside(node, dest))
          throw errors.invalidArgument('toFolder', 'A folder is not moved into itself.')
        const name = args.newName ?? node.name
        self.requireRole(user, parent, 'editor')
        self.requireRole(user, dest, 'editor')
        if (args.ifVersion !== undefined && node.kind === 'file' && args.ifVersion !== node.version)
          throw errors.versionMismatch(node.version)
        if (self.nameTaken(dest, name, node)) throw errors.alreadyExists()
        self.guard(ctx, true)
        node.parent = dest.id
        node.name = name
        node.modifiedAt = self.service.now()
        return { item: self.item(user, root, node) }
      }
    }

    if (caps.includes('trash')) {
      provider.trash = (args, ctx) => {
        const user = self.guard(ctx, false)
        const root = self.rootOf(user, args.root)
        const node = self.itemIn(root, args.ref)
        if (node.id === root.id) throw errors.notSupported('The root itself is not moved to the trash.')
        const parent = self.mustGet(node.parent as string)
        self.requireRole(user, parent, 'editor')
        if (args.ifVersion !== undefined && node.kind === 'file' && args.ifVersion !== node.version)
          throw errors.versionMismatch(node.version)
        self.guard(ctx, true)
        node.trashedAt = self.service.now()
        node.trashedFrom = parent.id
        node.parent = undefined
        return { item: self.item(user, root, node, { trashedFrom: parent }) }
      }
      const trashedIn = (root: FileNode) =>
        [...self.nodes.values()].filter((n) => {
          if (n.trashedAt === undefined || !n.trashedFrom) return false
          const from = self.nodes.get(n.trashedFrom)
          return !!from && self.inside(root, from)
        })
      provider.restore = (args, ctx) => {
        const user = self.guard(ctx, false)
        const root = self.rootOf(user, args.root)
        const node = trashedIn(root).find((n) => n.id === args.ref)
        if (!node) throw errors.notFound('The item is not in the trash of this folder.')
        const from = self.nodes.get(node.trashedFrom as string)
        if (!from || self.trashed(from)) throw errors.notFound('The folder the item left is gone.')
        self.requireRole(user, from, 'editor')
        if (self.nameTaken(from, node.name)) throw errors.alreadyExists()
        self.guard(ctx, true)
        node.parent = from.id
        node.trashedAt = undefined
        node.trashedFrom = undefined
        return { item: self.item(user, root, node) }
      }
      provider.listTrash = (args, ctx) => {
        const user = self.guard(ctx, false)
        const root = self.rootOf(user, args.root)
        const page = pageByKey(trashedIn(root), (n) => n.id, ctx.page)
        return {
          items: page.items.map((n) =>
            self.item(user, root, n, { trashedFrom: self.mustGet(n.trashedFrom as string) })
          ),
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        }
      }
    }

    if (caps.includes('share')) {
      const shareView = (s: ShareRec, inherited: boolean): Share => {
        const u = s.userId ? self.service.userById(s.userId) : undefined
        const address = u?.email ?? s.address
        return {
          id: s.id,
          role: s.role,
          ...(address ? { recipient: { address, ...(u ? { name: u.name } : {}) } } : {}),
          ...(s.audience ? { audience: s.audience } : {}),
          ...(s.link ? { link: s.link } : {}),
          inherited,
        }
      }
      const membersOf = (root: FileNode): Share[] =>
        [...(root.team?.members ?? new Map<string, Role>()).entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([userId, role]) => {
            const u = self.service.userById(userId)
            return {
              id: `member-${userId}`,
              role,
              recipient: { address: u?.email ?? userId, ...(u ? { name: u.name } : {}) },
              inherited: false,
            }
          })
      const sharesOf = (root: FileNode, node: FileNode): Share[] => {
        if (node.id === root.id && root.team) return membersOf(root)
        const out = node.shares.map((s) => shareView(s, false))
        for (const n of self.chain(node).slice(1)) {
          out.push(...n.shares.map((s) => shareView(s, true)))
          if (n.id === root.id) break
        }
        return out
      }
      provider.shares = (args, ctx) => {
        const user = self.guard(ctx, false)
        const root = self.rootOf(user, args.root)
        return { shares: sharesOf(root, self.itemIn(root, args.ref)) }
      }
      provider.share = (args, ctx) => {
        const user = self.guard(ctx, false)
        const root = self.rootOf(user, args.root)
        const node = self.itemIn(root, args.ref)
        const team = node.id === root.id && root.team ? root.team : undefined
        if (team) {
          if (args.audience !== undefined)
            throw errors.notSupported('A team folder takes members by address only.', 'audience')
          if (!self.mayManage(user, root))
            throw errors.permissionDenied('The account may not change the members of this folder.')
          const made: Share[] = []
          const users: MemoryUser[] = []
          for (const r of args.recipients ?? []) {
            const u = self.service.userByEmail(r.address)
            if (!u) throw errors.recipientRefused('no-account', 'The address is no account of the store.')
            if (!self.options.teamRootOutside && !self.inOrganization(u))
              throw errors.recipientRefused('not-allowed', 'The store does not let this folder take that address.')
            users.push(u)
          }
          const after = new Set([...team.members.keys(), ...users.map((u) => u.id)])
          if (after.size > self.options.maxTeamMembers)
            throw errors.recipientRefused('too-many', 'The folder holds as many members as the store allows.')
          self.guard(ctx, true)
          for (const u of users) {
            team.members.set(u.id, args.role)
            made.push({
              id: `member-${u.id}`,
              role: args.role,
              recipient: { address: u.email, name: u.name },
              inherited: false,
            })
          }
          return { shares: made }
        }
        if (args.role === 'manager') throw errors.notSupported('The role "manager" is for a team folder.', 'role')
        self.requireRole(user, node, 'editor')
        self.guard(ctx, true)
        const made: ShareRec[] = []
        for (const r of args.recipients ?? []) {
          const u = self.service.userByEmail(r.address)
          node.shares = node.shares.filter(
            (s) => !(u ? s.userId === u.id : s.address?.toLowerCase() === r.address.toLowerCase())
          )
          const rec: ShareRec = {
            id: self.service.next('s'),
            role: args.role,
            ...(u ? { userId: u.id } : { address: r.address }),
          }
          node.shares.push(rec)
          made.push(rec)
          if (self.options.notify && args.notify !== false)
            self.service.send({
              to: u?.email ?? r.address,
              kind: 'share',
              subject: `${user.name} shared ${node.name}`,
              text: args.message ?? '',
            })
        }
        if (args.audience) {
          const id = self.service.next('s')
          const rec: ShareRec = {
            id,
            role: args.role,
            audience: args.audience,
            ...(args.audience === 'anyone' ? { link: `https://files.memory.invalid/s/${id}` } : {}),
          }
          node.shares.push(rec)
          made.push(rec)
        }
        return { shares: made.map((s) => shareView(s, false)) }
      }
      provider.unshare = (args, ctx) => {
        const user = self.guard(ctx, false)
        const root = self.rootOf(user, args.root)
        const node = self.itemIn(root, args.ref)
        if (node.id === root.id && root.team) {
          if (!self.mayManage(user, root))
            throw errors.permissionDenied('The account may not change the members of this folder.')
          const userId = args.share.replace(/^member-/, '')
          if (!root.team.members.has(userId)) throw errors.notFound('The folder has no such member.')
          self.guard(ctx, true)
          root.team.members.delete(userId)
          return { shares: membersOf(root) }
        }
        const own = node.shares.find((s) => s.id === args.share)
        if (!own) {
          if (sharesOf(root, node).some((s) => s.id === args.share && s.inherited))
            throw errors.notSupported('This share comes from a folder above and is ended there.')
          throw errors.notFound('The item has no such share.')
        }
        self.requireRole(user, node, 'editor')
        self.guard(ctx, true)
        node.shares = node.shares.filter((s) => s !== own)
        return { shares: sharesOf(root, node) }
      }
    }

    if (caps.includes('versions'))
      provider.versions = (args, ctx) => {
        const user = self.guard(ctx, false)
        const root = self.rootOf(user, args.root)
        const node = self.itemIn(root, args.ref)
        if (node.kind !== 'file') throw errors.notSupported('Only a file has versions.')
        const name = (id?: string) => (id ? self.service.userById(id)?.name : undefined)
        const all = [
          { version: node.version, at: node.modifiedAt, by: node.modifiedBy, size: node.data?.length ?? 0 },
          ...[...node.history].reverse().map((h) => ({ version: h.version, at: h.at, by: h.by, size: h.data.length })),
        ]
        const page = pageByOffset(all, ctx.page)
        return {
          versions: page.items.map((v) => {
            const by = name(v.by)
            return { version: v.version, modifiedAt: utc(v.at), ...(by ? { modifiedBy: by } : {}), sizeBytes: v.size }
          }),
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        }
      }

    if (caps.includes('export'))
      provider.export = (args, ctx) => {
        const user = self.guard(ctx, false)
        const root = self.rootOf(user, args.root)
        const node = self.itemIn(root, args.ref)
        if (node.kind !== 'file' || !node.native || !EXPORT_TYPES.includes(args.mediaType))
          throw errors.notSupported('The file is not given in this format.', 'mediaType')
        const text = (node.data ?? Buffer.alloc(0)).toString('utf8')
        if (args.mediaType === 'application/pdf') {
          const pdf = Buffer.from(`%PDF-1.4\n% ${node.name}\n${text}\n%%EOF\n`, 'utf8')
          return {
            item: self.item(user, root, node),
            content: { kind: 'bytes', base64: pdf.toString('base64'), mediaType: 'application/pdf' },
          }
        }
        return { item: self.item(user, root, node), content: { kind: 'text', text, mediaType: args.mediaType } }
      }

    if (caps.includes('team-roots')) {
      provider.createTeamRoot = (args, ctx) => {
        const user = self.guard(ctx, false)
        const creators = self.options.teamRootCreators
        if (creators && !creators.includes(user.id))
          throw errors.permissionDenied('The store does not let this account create a team folder.')
        const key = `${user.id}:${args.requestId}`
        const existing = [...self.nodes.values()].find((n) => n.team?.requestKey === key)
        if (existing) return { root: self.rootView(user, existing, `/${existing.name}`) }
        self.guard(ctx, true)
        const node = self.newNode(
          {
            kind: 'folder',
            name: args.name,
            team: {
              members: new Map([[user.id, self.options.teamRootManager ? 'manager' : 'editor']]),
              creator: user.id,
              requestKey: key,
            },
          },
          user.id
        )
        self.nodes.set(node.id, node)
        return { root: self.rootView(user, node, `/${node.name}`) }
      }
      provider.renameRoot = (args, ctx) => {
        const user = self.guard(ctx, false)
        const root = self.rootOf(user, args.root)
        if (!root.team) throw errors.notSupported('Only a team folder is renamed.')
        if (!self.mayManage(user, root)) throw errors.permissionDenied('The account may not rename this folder.')
        self.guard(ctx, true)
        root.name = args.name
        return { root: self.rootView(user, root, `/${root.name}`) }
      }
    }
    return provider
  }
}
