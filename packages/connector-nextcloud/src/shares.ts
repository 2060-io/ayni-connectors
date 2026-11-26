/**
 * Shares of a Nextcloud (providers §5, FEAT-NC-006), through the OCS Share API, and team folders (§5.1, FEAT-NC-008 to
 * 011), through the Team folders app and the provisioning interface, for the managing account (agent D150).
 *
 * An item is shared with the person of the server whose email is the address (`shareType` 0), by email with anyone
 * else where the server allows it (4), and with whoever has the link (3); `reader` is the permission 1, `editor` 3 for a
 * file and 15 for a folder, never 16. A team root's members are those of its two groups, `ayni-{requestId}-editors`
 * (15) and `ayni-{requestId}-readers` (1); the managing account itself is in the readers' group, the one way it has to
 * read the team folder's file id (Nextcloud's Team folders app gives none), and is listed among no members.
 */
import { createHash } from 'node:crypto'
import type {
  FilesCreateTeamRootArgs,
  FilesDeclaration,
  FilesRenameRootArgs,
  FilesShareArgs,
  FilesSharesArgs,
  FilesUnshareArgs,
  Share,
} from '@ayni.org/ayni-feature-profiles'
import { type CallContext, errors } from '@ayni.org/ayni-provider-kit'
import type { DavAccountData } from './account.js'
import { type DavFiles, type Entry, isFolder, type Located } from './files.js'
import type { NextcloudInfo } from './nextcloud.js'
import { appUrl, type OcsAnswer, ocs, ocsError, ocsOk, ocsUrl } from './ocs.js'

type Ctx = CallContext<DavAccountData, FilesDeclaration>

/** A share as the OCS Share API answers it (the members the connector reads). */
interface OcsShare {
  id: string | number
  share_type: number
  permissions: number
  share_with?: string | null
  share_with_displayname?: string | null
  share_with_displayname_unique?: string | null
  url?: string | null
  path?: string
  item_type?: string
}

const READ = 1
const UPDATE = 2
const CREATE = 4
const DELETE = 8
export const EDITOR_FILE = READ | UPDATE
export const EDITOR_FOLDER = READ | UPDATE | CREATE | DELETE
export const TEAM_READER = READ
export const TEAM_EDITOR = READ | UPDATE | CREATE | DELETE

const isEmail = (s: string | null | undefined): s is string => !!s && /^[^\s@]+@[^\s@]+$/.test(s)

/** A share of the OCS Share API as the profile answers it; `undefined` for a kind the profile has no shape for. */
export function shareOf(s: OcsShare, inherited: boolean): Share | undefined {
  const role = s.permissions & (UPDATE | CREATE | DELETE) ? 'editor' : 'reader'
  const id = String(s.id)
  if (s.share_type === 0) {
    const address = isEmail(s.share_with_displayname_unique) ? s.share_with_displayname_unique : undefined
    if (!address) return undefined
    return {
      id,
      role,
      recipient: { address, ...(s.share_with_displayname ? { name: s.share_with_displayname } : {}) },
      inherited,
    }
  }
  if (s.share_type === 4 && isEmail(s.share_with)) return { id, role, recipient: { address: s.share_with }, inherited }
  if (s.share_type === 3) return { id, role, audience: 'anyone', ...(s.url ? { link: s.url } : {}), inherited }
  return undefined
}

/** The groups of a team root of a request (FEAT-NC-009), a digest of the request when its id makes them too long. */
export function teamGroups(requestId: string): { editors: string; readers: string } {
  const plain = { editors: `ayni-${requestId}-editors`, readers: `ayni-${requestId}-readers` }
  if (plain.editors.length <= 64) return plain
  const d = createHash('sha256').update(requestId).digest('hex').slice(0, 32)
  return { editors: `ayni-${d}-editors`, readers: `ayni-${d}-readers` }
}

/** A team folder as the Team folders app answers it. */
interface TeamFolder {
  id: number
  mount_point: string
  groups: Record<string, number> | unknown[]
}

const groupsOf = (f: TeamFolder): Record<string, number> =>
  Array.isArray(f.groups) ? {} : (f.groups as Record<string, number>)

/** The pair of the connector's groups a team folder is given to, when it is one the connector made. */
function ourGroups(f: TeamFolder): { editors: string; readers: string } | undefined {
  const names = Object.keys(groupsOf(f))
  const editors = names.find((g) => /^ayni-[A-Za-z0-9_-]+-editors$/.test(g))
  if (!editors) return undefined
  const readers = `${editors.slice(0, -'-editors'.length)}-readers`
  return names.includes(readers) ? { editors, readers } : undefined
}

export class NcShares {
  private readonly nc: NextcloudInfo

  public constructor(private readonly f: DavFiles) {
    this.nc = f.s.nc as NextcloudInfo
  }

  private get http() {
    return this.f.s.http
  }

  private pathOf(e: Entry): string {
    return `/${e.parts.join('/')}`
  }

  private sharesUrl(path = ''): URL {
    return ocsUrl(this.nc.base, `apps/files_sharing/api/v1/shares${path}`)
  }

  /** Whether a call acts on a team root's members: its own reference, by an account that declares `team-roots`. */
  private onTeamRoot(root: Located, ref: string, ctx: Ctx): boolean {
    return ref === root.ref && this.f.isTeamRoot(root.entry) && ctx.declaration.capabilities.includes('team-roots')
  }

  // ---- shares of an item ---------------------------------------------------------------------------------------

  private async own(e: Entry, ctx: Ctx): Promise<OcsShare[]> {
    const a = await ocs<OcsShare[]>(this.http, this.sharesUrl(), 'GET', { path: this.pathOf(e) }, ctx.signal)
    if (!ocsOk(a)) {
      if (a.status === 404 || a.statuscode === 404) return []
      throw ocsError(a)
    }
    return Array.isArray(a.data) ? a.data : []
  }

  private async inheritedOf(root: Located, e: Entry, ctx: Ctx): Promise<OcsShare[]> {
    if (e.parts.length <= root.entry.parts.length) return []
    const a = await ocs<OcsShare[]>(
      this.http,
      this.sharesUrl('/inherited'),
      'GET',
      { path: this.pathOf(e) },
      ctx.signal
    )
    if (!ocsOk(a)) {
      if (a.status === 404 || a.statuscode === 404) return []
      throw ocsError(a)
    }
    // the shares of the root's folder and of the folders between it and the item: none from outside the location
    const rootPath = this.pathOf(root.entry)
    return (Array.isArray(a.data) ? a.data : []).filter(
      (s) =>
        typeof s.path === 'string' &&
        (s.path === rootPath || s.path.startsWith(rootPath === '/' ? '/' : `${rootPath}/`))
    )
  }

  private async itemShares(root: Located, e: Entry, ctx: Ctx): Promise<Share[]> {
    const [own, inherited] = await Promise.all([this.own(e, ctx), this.inheritedOf(root, e, ctx)])
    const out: Share[] = []
    for (const s of own) {
      const x = shareOf(s, false)
      if (x) out.push(x)
    }
    for (const s of inherited) {
      const x = shareOf(s, true)
      if (x && !out.some((o) => o.id === x.id)) out.push(x)
    }
    return out
  }

  public async shares(args: FilesSharesArgs, ctx: Ctx) {
    const root = await this.f.root(args.root, ctx.signal)
    if (this.onTeamRoot(root, args.ref, ctx)) return { shares: await this.members(root, ctx) }
    const e = await this.f.item(root, args.ref, 'ref', ctx.signal)
    return { shares: await this.itemShares(root, e, ctx) }
  }

  /** The person of the server whose email the address is, by the sharees interface: exactly one, or none. */
  private async personOf(address: string, ctx: Ctx): Promise<{ user?: string; many: boolean }> {
    const a = await ocs<{
      exact?: { users?: { value?: { shareWith?: string }; shareWithDisplayNameUnique?: string }[] }
    }>(
      this.http,
      ocsUrl(this.nc.base, 'apps/files_sharing/api/v1/sharees'),
      'GET',
      { search: address, itemType: 'file', shareType: ['0'], lookup: 'false', perPage: '20' },
      ctx.signal
    )
    if (!ocsOk(a)) throw ocsError(a)
    const users = (a.data.exact?.users ?? []).filter(
      (u) => (u.shareWithDisplayNameUnique ?? '').toLowerCase() === address.toLowerCase() && u.value?.shareWith
    )
    return users.length === 1 ? { user: users[0]?.value?.shareWith as string, many: false } : { many: users.length > 1 }
  }

  public async share(args: FilesShareArgs, ctx: Ctx) {
    const root = await this.f.root(args.root, ctx.signal)
    if (this.onTeamRoot(root, args.ref, ctx)) return this.shareTeam(root, args, ctx)
    const e = await this.f.item(root, args.ref, 'ref', ctx.signal)
    const folder = isFolder(e)
    const permissions = args.role === 'editor' ? (folder ? EDITOR_FOLDER : EDITOR_FILE) : READ
    const made: Share[] = []
    if (args.audience !== undefined) {
      // the kit refuses an audience not declared: `anyone` alone, where the server allows public links
      const a = await this.createShare({ path: this.pathOf(e), shareType: '3', permissions: String(permissions) }, ctx)
      const s = shareOf(a, false)
      if (s) made.push(s)
      return { shares: made }
    }
    // every address is read before any share is made: a refusal makes none
    const targets: { address: string; user?: string }[] = []
    for (const { address } of args.recipients ?? []) {
      const p = await this.personOf(address, ctx)
      if (p.many) throw errors.notSupported('An address names more than one person of the server.', 'recipients')
      if (!p.user && !this.nc.shareByMail)
        throw errors.notSupported('This server shares with its own people only.', 'recipients')
      targets.push({ address, ...(p.user ? { user: p.user } : {}) })
    }
    const existing = await this.own(e, ctx)
    for (const t of targets) {
      const before = existing.find((s) =>
        t.user ? s.share_type === 0 && s.share_with === t.user : s.share_type === 4 && s.share_with === t.address
      )
      let answered: OcsShare
      if (before) {
        // sharing again with someone the item is shared with changes the role of that share
        const a = await ocs<OcsShare>(
          this.http,
          this.sharesUrl(`/${encodeURIComponent(String(before.id))}`),
          'PUT',
          { permissions: String(permissions), ...(args.message !== undefined ? { note: args.message } : {}) },
          ctx.signal
        )
        if (!ocsOk(a)) throw this.shareError(a)
        answered = a.data
      } else
        answered = await this.createShare(
          {
            path: this.pathOf(e),
            shareType: t.user ? '0' : '4',
            shareWith: t.user ?? t.address,
            permissions: String(permissions),
            sendMail: args.notify === false ? 'false' : 'true',
            ...(args.message !== undefined ? { note: args.message } : {}),
          },
          ctx
        )
      const s = shareOf(answered, false) ?? {
        id: String(answered.id),
        role: args.role === 'editor' ? 'editor' : 'reader',
        recipient: { address: t.address },
        inherited: false,
      }
      made.push(s)
    }
    return { shares: made }
  }

  private shareError(a: OcsAnswer): Error {
    if (a.status === 400 || a.statuscode === 400) return errors.permissionDenied('The server refuses this share.')
    return ocsError(a)
  }

  private async createShare(form: Record<string, string>, ctx: Ctx): Promise<OcsShare> {
    const a = await ocs<OcsShare>(this.http, this.sharesUrl(), 'POST', form, ctx.signal)
    if (!ocsOk(a)) throw this.shareError(a)
    return a.data
  }

  public async unshare(args: FilesUnshareArgs, ctx: Ctx) {
    const root = await this.f.root(args.root, ctx.signal)
    if (this.onTeamRoot(root, args.ref, ctx)) return this.unshareTeam(root, args, ctx)
    const e = await this.f.item(root, args.ref, 'ref', ctx.signal)
    const [own, inherited] = await Promise.all([this.own(e, ctx), this.inheritedOf(root, e, ctx)])
    if (!own.some((s) => String(s.id) === args.share)) {
      if (inherited.some((s) => String(s.id) === args.share))
        throw errors.notSupported('This share comes from a folder above: end it there.', 'share')
      throw errors.notFound('The item has no such share.')
    }
    const a = await ocs(
      this.http,
      this.sharesUrl(`/${encodeURIComponent(args.share)}`),
      'DELETE',
      undefined,
      ctx.signal
    )
    if (!ocsOk(a)) throw ocsError(a)
    return { shares: await this.itemShares(root, e, ctx) }
  }

  // ---- team roots (§5.1) ---------------------------------------------------------------------------------------

  private async folders(ctx: Ctx, mountpoint?: string): Promise<TeamFolder[]> {
    const a = await ocs<Record<string, TeamFolder> | TeamFolder[]>(
      this.http,
      appUrl(this.nc.base, 'apps/groupfolders/folders'),
      'GET',
      mountpoint !== undefined ? { mountpoint } : undefined,
      ctx.signal
    )
    if (!ocsOk(a)) throw ocsError(a)
    const list = Array.isArray(a.data) ? a.data : Object.values(a.data ?? {})
    return list.filter((f) => f && typeof f === 'object' && 'id' in f) as TeamFolder[]
  }

  /** The team folder of a root of the managing account's tree: by its mount point, which is its path there. */
  private async folderOfRoot(root: Located, ctx: Ctx): Promise<TeamFolder> {
    if (!this.f.isTeamRoot(root.entry)) throw errors.notSupported('This folder is not a team root.')
    const mount = root.entry.parts.join('/')
    const found = (await this.folders(ctx, mount)).find((f) => f.mount_point === mount)
    if (!found) throw errors.notFound()
    return found
  }

  private async managed(
    root: Located,
    ctx: Ctx
  ): Promise<{ folder: TeamFolder; groups: { editors: string; readers: string } }> {
    const folder = await this.folderOfRoot(root, ctx)
    const groups = ourGroups(folder)
    if (!groups)
      throw errors.notSupported('This team folder was not made by this connector: its members are not kept here.')
    return { folder, groups }
  }

  private async groupMembers(group: string, ctx: Ctx): Promise<{ id: string; email?: string; name?: string }[]> {
    const a = await ocs<{
      users?: Record<string, { id?: string; email?: string | null; displayname?: string }> | unknown[]
    }>(
      this.http,
      ocsUrl(this.nc.base, `cloud/groups/${encodeURIComponent(group)}/users/details`, 1),
      'GET',
      undefined,
      ctx.signal
    )
    if (!ocsOk(a)) {
      if (a.statuscode === 998 || a.status === 404) return []
      throw ocsError(a)
    }
    const users = a.data.users
    if (!users || Array.isArray(users)) return []
    return Object.entries(users).map(([id, u]) => ({
      id: u.id ?? id,
      ...(u.email ? { email: u.email } : {}),
      ...(u.displayname ? { name: u.displayname } : {}),
    }))
  }

  /** The members of a team root (FEAT-NC-010): the users of its two groups, the managing account left out. */
  private async members(root: Located, ctx: Ctx): Promise<Share[]> {
    const { groups } = await this.managed(root, ctx)
    const [editors, readers] = await Promise.all([
      this.groupMembers(groups.editors, ctx),
      this.groupMembers(groups.readers, ctx),
    ])
    const out: Share[] = []
    const seen = new Set<string>()
    for (const [role, list] of [
      ['editor', editors],
      ['reader', readers],
    ] as const)
      for (const u of list) {
        if (u.id === this.nc.userId || seen.has(u.id) || !isEmail(u.email)) continue
        seen.add(u.id)
        out.push({
          id: `member:${u.id}`,
          role,
          recipient: { address: u.email, ...(u.name ? { name: u.name } : {}) },
          inherited: false,
        })
      }
    return out
  }

  /** The one user whose email is the address (FEAT-NC-010), by the provisioning interface's search. */
  private async userByEmail(address: string, ctx: Ctx): Promise<string | undefined> {
    const a = await ocs<{ users?: Record<string, { id?: string; email?: string | null }> | unknown[] }>(
      this.http,
      ocsUrl(this.nc.base, 'cloud/users/details', 1),
      'GET',
      { search: address, limit: '25' },
      ctx.signal
    )
    if (!ocsOk(a)) throw ocsError(a)
    const users = a.data.users
    if (!users || Array.isArray(users)) return undefined
    const exact = Object.entries(users).filter(([, u]) => (u.email ?? '').toLowerCase() === address.toLowerCase())
    return exact.length === 1 ? ((exact[0]?.[1].id ?? exact[0]?.[0]) as string) : undefined
  }

  private async setGroup(user: string, group: string, on: boolean, ctx: Ctx): Promise<void> {
    const a = await ocs(
      this.http,
      ocsUrl(this.nc.base, `cloud/users/${encodeURIComponent(user)}/groups`, 1),
      on ? 'POST' : 'DELETE',
      { groupid: group },
      ctx.signal
    )
    if (!ocsOk(a)) throw ocsError(a)
  }

  private async shareTeam(root: Located, args: FilesShareArgs, ctx: Ctx) {
    if (args.audience !== undefined) throw errors.notSupported('A team root takes people, not an audience.', 'audience')
    if (args.message !== undefined)
      throw errors.notSupported('A membership of a team folder carries no message.', 'message')
    const { groups } = await this.managed(root, ctx)
    const targets: { address: string; user: string }[] = []
    for (const { address } of args.recipients ?? []) {
      const user = await this.userByEmail(address, ctx)
      if (!user)
        throw errors.recipientRefused('no-account', 'The address is no account of the server, or more than one.')
      if (user === this.nc.userId)
        throw errors.recipientRefused('not-allowed', 'The managing account is not made a member.')
      targets.push({ address, user })
    }
    const into = args.role === 'editor' ? groups.editors : groups.readers
    const outOf = args.role === 'editor' ? groups.readers : groups.editors
    const made: Share[] = []
    for (const t of targets) {
      await this.setGroup(t.user, into, true, ctx)
      await this.setGroup(t.user, outOf, false, ctx).catch(() => undefined)
      made.push({
        id: `member:${t.user}`,
        role: args.role === 'editor' ? 'editor' : 'reader',
        recipient: { address: t.address },
        inherited: false,
      })
    }
    const listed = await this.members(root, ctx)
    return { shares: made.map((m) => listed.find((l) => l.id === m.id) ?? m) }
  }

  private async unshareTeam(root: Located, args: FilesUnshareArgs, ctx: Ctx) {
    const { groups } = await this.managed(root, ctx)
    const members = await this.members(root, ctx)
    const m = members.find((x) => x.id === args.share)
    if (!m) throw errors.notFound('The team root has no such member.')
    const user = args.share.slice('member:'.length)
    await this.setGroup(user, groups.editors, false, ctx).catch(() => undefined)
    await this.setGroup(user, groups.readers, false, ctx).catch(() => undefined)
    return { shares: (await this.members(root, ctx)).filter((x) => x.id !== args.share) }
  }

  private async ensureGroup(group: string, ctx: Ctx): Promise<void> {
    const a = await ocs(this.http, ocsUrl(this.nc.base, 'cloud/groups', 1), 'POST', { groupid: group }, ctx.signal)
    // 102: the group exists already, which a request sent again finds
    if (!ocsOk(a) && a.statuscode !== 102) throw ocsError(a)
  }

  private async folderCall(path: string, form: Record<string, string>, ctx: Ctx, method = 'POST'): Promise<OcsAnswer> {
    return ocs(this.http, appUrl(this.nc.base, `apps/groupfolders/folders${path}`), method, form, ctx.signal)
  }

  /** `files_create_team_root` (FEAT-NC-009): two groups, a team folder given to them, made once per request id. */
  public async createTeamRoot(args: FilesCreateTeamRootArgs, ctx: Ctx) {
    const groups = teamGroups(args.requestId)
    const all = await this.folders(ctx)
    let folder = all.find((f) => {
      const g = groupsOf(f)
      return groups.editors in g || groups.readers in g
    })
    if (!folder) {
      const made = await this.folderCall('', { mountpoint: args.name }, ctx)
      if (ocsOk(made)) folder = made.data as TeamFolder
      else {
        // a creation cut short before its groups: the folder of that name with no group is taken up again
        const orphan = all.find((f) => f.mount_point === args.name.trim() && Object.keys(groupsOf(f)).length === 0)
        if (orphan) folder = orphan
        else if (made.status === 400) throw errors.alreadyExists('A team folder of this name is already there.')
        else throw ocsError(made)
      }
    }
    const f = folder as TeamFolder
    await this.ensureGroup(groups.editors, ctx)
    await this.ensureGroup(groups.readers, ctx)
    const given = groupsOf(f)
    for (const [group, permissions] of [
      [groups.editors, TEAM_EDITOR],
      [groups.readers, TEAM_READER],
    ] as const) {
      if (!(group in given)) {
        const a = await this.folderCall(`/${f.id}/groups`, { group }, ctx)
        if (!ocsOk(a)) throw ocsError(a)
      }
      if (given[group] !== permissions) {
        const a = await this.folderCall(
          `/${f.id}/groups/${encodeURIComponent(group)}`,
          { permissions: String(permissions) },
          ctx
        )
        if (!ocsOk(a)) throw ocsError(a)
      }
    }
    await this.setGroup(this.nc.userId, groups.readers, true, ctx)
    const entry = await this.f.at(f.mount_point.split('/').filter(Boolean), ctx.signal)
    return { root: { ...this.f.toRoot(entry), team: true as const, portable: true } }
  }

  /** `files_rename_root` (FEAT-NC-011): the team folder's mount point; its file id, the root's reference, stays. */
  public async renameRoot(args: FilesRenameRootArgs, ctx: Ctx) {
    const root = await this.f.root(args.root, ctx.signal)
    const folder = await this.folderOfRoot(root, ctx)
    if (folder.mount_point !== args.name) {
      const a = await this.folderCall(`/${folder.id}`, { mountPoint: args.name }, ctx, 'PUT')
      if (!ocsOk(a)) {
        if (a.status === 400) throw errors.alreadyExists('A team folder of this name is already there.')
        throw ocsError(a)
      }
    }
    const again = await this.f.root(args.root, ctx.signal)
    return { root: this.f.toRoot(again.entry) }
  }
}
