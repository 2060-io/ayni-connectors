/**
 * The stub's OCS interfaces, as Nextcloud 35 answers them (seen on its container): the capabilities; the Share API
 * (shares by path and inherited, sharees, a share made, changed and ended, the mail a share sends with its note);
 * the provisioning interface (groups made, users in and out of them, users and members with their details); and the
 * Team folders app's own routes under `/index.php/apps/groupfolders/`. Version 2 answers its status in HTTP, version 1
 * and the Team folders app `200` with a `statuscode` (100 for success, 102 for a group that exists, 403 refused).
 */
import type { StubRequest, StubResponse } from './http.js'
import { ALL, type Entry, type Share, type Store, type User } from './store.js'

export interface OcsOptions {
  trashbin: boolean
  versions: boolean
  sharing: boolean
  publicLinks: boolean
  shareByMail: boolean
  groupfolders: boolean
  /** the host and port the stub is reached at, for the links of public shares */
  origin: () => string
}

function ocs(version: 1 | 2, status: number, data: unknown, message = 'OK'): StubResponse {
  const ok = status < 300
  return {
    status: version === 2 ? status : 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      ocs: {
        meta: {
          status: ok ? 'ok' : 'failure',
          statuscode: version === 1 ? (ok ? 100 : status) : status,
          message,
          ...(version === 1 ? { totalitems: '', itemsperpage: '' } : {}),
        },
        data,
      },
    }),
  }
}

/** The fields of a form body or a query. */
function form(req: StubRequest): URLSearchParams {
  const p = new URLSearchParams(req.url.search)
  if (req.body.length && (req.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded'))
    for (const [k, v] of new URLSearchParams(req.body.toString('utf8'))) p.append(k, v)
  return p
}

export class StubOcs {
  public constructor(
    private readonly store: Store,
    private readonly o: OcsOptions
  ) {}

  private pathEntry(user: User, path: string | null): Entry | undefined {
    if (!path) return undefined
    return this.store.resolve(user.id, path.split('/').filter(Boolean))
  }

  private shareJson(s: Share, user: User) {
    const recipient = s.type === 0 ? this.store.users.get(s.shareWith ?? '') : undefined
    const e = this.ownerPath(s)
    return {
      id: String(s.id),
      share_type: s.type,
      uid_owner: s.owner,
      displayname_owner: this.store.users.get(s.owner)?.name ?? s.owner,
      permissions: s.permissions,
      note: s.note,
      path: e ? `/${e.join('/')}` : `/${s.node.name}`,
      item_type: s.node.folder ? 'folder' : 'file',
      item_source: s.node.id,
      file_source: s.node.id,
      share_with: s.type === 3 ? null : (s.shareWith ?? null),
      share_with_displayname: recipient ? recipient.name : (s.shareWith ?? ''),
      share_with_displayname_unique: recipient ? (recipient.email ?? recipient.id) : (s.shareWith ?? ''),
      token: s.token ?? null,
      url: s.type === 3 ? `https://${this.o.origin()}/index.php/s/${s.token}` : undefined,
      mail_send: s.mailSend ? 1 : 0,
      viewer: user.id,
    }
  }

  /** The path of a shared node in its owner's tree. */
  private ownerPath(s: Share): string[] | undefined {
    const out: string[] = []
    for (let n: typeof s.node | undefined = s.node; n?.parent; n = n.parent) out.unshift(n.name)
    return out
  }

  public handle(req: StubRequest): StubResponse | undefined {
    const user = req.user as User
    const path = req.url.pathname
    const m = req.method
    const f = form(req)
    // the calls Nextcloud marks PasswordConfirmationRequired: an app password confirms no password (Nextcloud 35)
    const confirming =
      m !== 'GET' &&
      (path === '/ocs/v1.php/cloud/groups' ||
        /^\/ocs\/v1\.php\/cloud\/users\/[^/]+\/groups$/.test(path) ||
        path.startsWith('/index.php/apps/groupfolders/folders'))
    if (confirming && req.appPassword) return ocs(1, 403, [], 'Password confirmation is required')
    if (path === '/ocs/v2.php/cloud/capabilities' && m === 'GET')
      return ocs(2, 200, { capabilities: this.capabilities() })
    if (path === '/ocs/v2.php/cloud/groups/admin/subadmins' && m === 'GET')
      return this.store.isUserAdmin(user.id)
        ? ocs(2, 200, [])
        : ocs(
            2,
            403,
            [],
            'Logged in account must be an admin, a sub admin or gotten special right to access this setting'
          )
    const shares = '/ocs/v2.php/apps/files_sharing/api/v1/shares'
    if (path === '/ocs/v2.php/apps/files_sharing/api/v1/sharees' && m === 'GET') return this.sharees(f)
    if (this.o.sharing && path.startsWith(shares)) return this.shares(req, user, path.slice(shares.length), f)
    if (path.startsWith('/ocs/v1.php/cloud/'))
      return this.provisioning(req, user, path.slice('/ocs/v1.php/cloud/'.length), f)
    if (this.o.groupfolders && path.startsWith('/index.php/apps/groupfolders/folders'))
      return this.teamFolders(req, user, path.slice('/index.php/apps/groupfolders/folders'.length), f)
    return undefined
  }

  private capabilities() {
    return {
      core: { 'webdav-root': 'remote.php/webdav', 'mod-rewrite-working': true },
      files: { undelete: this.o.trashbin, versioning: this.o.versions, bigfilechunking: true },
      files_sharing: {
        api_enabled: this.o.sharing,
        public: { enabled: this.o.publicLinks },
        resharing: true,
        user: { send_mail: false },
        sharebymail: { enabled: this.o.shareByMail },
      },
      ...(this.o.groupfolders ? { groupfolders: { appVersion: '23.0.2', hasGroupFolders: true } } : {}),
    }
  }

  private sharees(f: URLSearchParams): StubResponse {
    const search = (f.get('search') ?? '').toLowerCase()
    const exactUsers = [...this.store.users.values()]
      .filter((u) => u.email?.toLowerCase() === search || u.id.toLowerCase() === search)
      .map((u) => ({
        label: u.name,
        value: { shareType: 0, shareWith: u.id },
        shareWithDisplayNameUnique: u.email ?? u.id,
      }))
    const emails =
      exactUsers.length === 0 && /^[^\s@]+@[^\s@]+$/.test(search)
        ? [{ label: search, uuid: search, value: { shareType: 4, shareWith: search } }]
        : []
    return ocs(2, 200, {
      exact: { users: exactUsers, groups: [], remotes: [], emails, circles: [], rooms: [] },
      users: [],
      groups: [],
      emails: [],
      lookupEnabled: false,
    })
  }

  private shares(req: StubRequest, user: User, rest: string, f: URLSearchParams): StubResponse {
    const m = req.method
    if ((rest === '' || rest === '/inherited') && m === 'GET') {
      const e = this.pathEntry(user, f.get('path'))
      if (!e) return ocs(2, 404, [], 'Wrong path, file/folder does not exist')
      if (rest === '') {
        const own = this.store.shares.filter((s) => s.node === e.node && s.owner === user.id)
        return ocs(
          2,
          200,
          own.map((s) => this.shareJson(s, user))
        )
      }
      const above: Share[] = []
      for (let n = e.node.parent; n; n = n.parent)
        for (const s of this.store.shares) if (s.node === n && s.owner === user.id) above.push(s)
      return ocs(
        2,
        200,
        above.map((s) => this.shareJson(s, user))
      )
    }
    if (rest === '' && m === 'POST') {
      const e = this.pathEntry(user, f.get('path'))
      if (!e) return ocs(2, 404, [], 'Wrong path, file/folder does not exist')
      if (e.perms !== ALL && !(e.perms & 16)) return ocs(2, 403, [], 'You are not allowed to share this item')
      const type = Number(f.get('shareType'))
      const permissions = Number(f.get('permissions') ?? 31)
      if (permissions & 16 && !(e.perms & 16)) return ocs(2, 404, [], 'Cannot increase permissions')
      const sendMail = f.get('sendMail')
      let share: Share
      if (type === 0) {
        const to = this.store.users.get(f.get('shareWith') ?? '')
        if (!to) return ocs(2, 404, [], 'Please specify a valid account to share with')
        if (to.id === user.id) return ocs(2, 400, [], 'You cannot share to yourself')
        if (this.store.shares.some((s) => s.node === e.node && s.type === 0 && s.shareWith === to.id))
          return ocs(2, 403, [], 'Path is already shared with this user')
        share = this.store.share({
          owner: user.id,
          node: e.node,
          type: 0,
          shareWith: to.id,
          permissions,
          note: f.get('note') ?? '',
          mailSend: sendMail === null ? true : sendMail === 'true',
          target: [this.freeTarget(to.id, e.node.name)],
        })
        if (share.mailSend && to.email)
          this.store.messages.push({
            to: to.email,
            subject: `${user.name} shared »${e.node.name}« with you`,
            text: `${user.name} shared »${e.node.name}« with you.${share.note ? `\n\n${share.note}` : ''}`,
          })
      } else if (type === 4) {
        if (!this.o.shareByMail) return ocs(2, 400, [], 'Share type not allowed')
        const address = f.get('shareWith') ?? ''
        share = this.store.share({
          owner: user.id,
          node: e.node,
          type: 4,
          shareWith: address,
          permissions,
          note: f.get('note') ?? '',
          mailSend: sendMail === null ? true : sendMail === 'true',
          token: Math.random().toString(36).slice(2, 12),
        })
        if (share.mailSend)
          this.store.messages.push({
            to: address,
            subject: `${user.name} shared »${e.node.name}« with you`,
            text: `${user.name} shared »${e.node.name}« with you: https://${this.o.origin()}/index.php/s/${share.token}${share.note ? `\n\n${share.note}` : ''}`,
          })
      } else if (type === 3) {
        if (!this.o.publicLinks) return ocs(2, 403, [], 'Public link sharing is disabled by the administrator')
        share = this.store.share({
          owner: user.id,
          node: e.node,
          type: 3,
          permissions,
          note: '',
          mailSend: false,
          token: Math.random().toString(36).slice(2, 12),
        })
      } else return ocs(2, 400, [], 'Unknown share type')
      return ocs(2, 200, this.shareJson(share, user))
    }
    const id = /^\/(\d+)$/.exec(rest)?.[1]
    const share = id ? this.store.shares.find((s) => String(s.id) === id && s.owner === user.id) : undefined
    if (!share) return ocs(2, 404, [], 'Wrong share ID, share does not exist')
    if (m === 'PUT') {
      if (f.get('permissions')) share.permissions = Number(f.get('permissions'))
      if (f.get('note') !== null) share.note = f.get('note') ?? ''
      return ocs(2, 200, this.shareJson(share, user))
    }
    if (m === 'DELETE') {
      this.store.shares.splice(this.store.shares.indexOf(share), 1)
      return ocs(2, 200, [])
    }
    return ocs(2, 405, [])
  }

  /** The name a share is mounted at in a person's tree: its own, or `name (2)` where it is taken. */
  private freeTarget(uid: string, name: string): string {
    const home = this.store.resolve(uid, [])
    let candidate = name
    for (let i = 2; home && this.store.children(uid, home).some((c) => c.parts[0] === candidate); i++)
      candidate = `${name} (${i})`
    return candidate
  }

  private provisioning(req: StubRequest, user: User, rest: string, f: URLSearchParams): StubResponse {
    const m = req.method
    const admin = this.store.isUserAdmin(user.id)
    const refused = () => ocs(1, 403, [], 'Logged in account must be at least a sub admin')
    const details = (u: User) => ({
      id: u.id,
      enabled: true,
      email: u.email ?? null,
      displayname: u.name,
      groups: [...u.groups],
    })
    if (rest === 'groups' && m === 'POST') {
      if (!admin) return refused()
      const g = f.get('groupid') ?? ''
      if (!g || g.length > 64) return ocs(1, 101, [], 'Invalid group name')
      if (this.store.groups.has(g)) return ocs(1, 102, [], 'group exists')
      this.store.groups.add(g)
      return ocs(1, 200, [])
    }
    const members = /^groups\/([^/]+)\/users\/details$/.exec(rest)
    if (members && m === 'GET') {
      if (!admin) return refused()
      const g = decodeURIComponent(members[1] as string)
      if (!this.store.groups.has(g)) return ocs(1, 998, [], 'The requested group could not be found')
      const users = Object.fromEntries(
        [...this.store.users.values()].filter((u) => u.groups.has(g)).map((u) => [u.id, details(u)])
      )
      return ocs(1, 200, { users })
    }
    if (rest === 'users/details' && m === 'GET') {
      if (!admin) return refused()
      const q = (f.get('search') ?? '').toLowerCase()
      const users = Object.fromEntries(
        [...this.store.users.values()]
          .filter(
            (u) =>
              u.id.toLowerCase().includes(q) ||
              (u.email ?? '').toLowerCase().includes(q) ||
              u.name.toLowerCase().includes(q)
          )
          .map((u) => [u.id, details(u)])
      )
      return ocs(1, 200, { users })
    }
    const membership = /^users\/([^/]+)\/groups$/.exec(rest)
    if (membership && (m === 'POST' || m === 'DELETE')) {
      if (!admin) return refused()
      const target = this.store.users.get(decodeURIComponent(membership[1] as string))
      const g = f.get('groupid') ?? ''
      if (!g) return ocs(1, 101, [])
      if (!this.store.groups.has(g)) return ocs(1, 102, [])
      if (!target) return ocs(1, 103, [])
      if (m === 'POST') target.groups.add(g)
      else target.groups.delete(g)
      return ocs(1, 200, [])
    }
    return ocs(1, 404, [], 'Not found')
  }

  private folderJson(id: number) {
    const f = this.store.folders.find((x) => x.id === id)
    if (!f) return undefined
    return {
      id: f.id,
      mount_point: f.mountPoint,
      quota: -3,
      acl: false,
      size: 0,
      groups: f.groups.size ? Object.fromEntries(f.groups) : [],
      group_details: Object.fromEntries(
        [...f.groups].map(([g, p]) => [g, { displayName: g, permissions: p, type: 'group' }])
      ),
      manage: [],
      team_circle_id: null,
    }
  }

  private teamFolders(req: StubRequest, user: User, rest: string, f: URLSearchParams): StubResponse {
    const m = req.method
    const plain = (status: number, message: string): StubResponse => ({
      status,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    })
    const admin = this.store.isTeamAdmin(user.id)
    if (rest === '' && m === 'GET') {
      const mount = f.get('mountpoint')
      const list = this.store.folders
        .filter((x) => mount === null || x.mountPoint === mount)
        .filter((x) => admin || [...x.groups.keys()].some((g) => user.groups.has(g)))
      return ocs(1, 200, Object.fromEntries(list.map((x) => [String(x.id), this.folderJson(x.id)])))
    }
    if (!admin)
      return ocs(
        1,
        403,
        [],
        'Logged in user must be an admin, a sub admin or gotten special right to access this setting'
      )
    if (rest === '/count' && m === 'GET') return ocs(1, 200, { count: this.store.folders.length })
    if (rest === '' && m === 'POST') {
      const mount = (f.get('mountpoint') ?? '').trim()
      if (!mount) return plain(400, 'Invalid mount point')
      if (this.store.folders.some((x) => x.mountPoint === mount)) return plain(400, 'Mount point already exists')
      const folder = this.store.teamFolder(mount)
      return ocs(1, 200, this.folderJson(folder.id))
    }
    const one = /^\/(\d+)(\/groups(?:\/(.+))?)?$/.exec(rest)
    const folder = one ? this.store.folders.find((x) => String(x.id) === one[1]) : undefined
    if (!one || !folder) return ocs(1, 404, [], 'Groupfolder not found')
    if (!one[2] && m === 'PUT') {
      const mount = (f.get('mountPoint') ?? '').trim()
      if (this.store.folders.some((x) => x.mountPoint === mount)) return plain(400, 'Mount point already exists')
      folder.mountPoint = mount
      folder.root.name = mount
      return ocs(1, 200, { success: true, folder: this.folderJson(folder.id) })
    }
    if (!one[2] && m === 'GET') return ocs(1, 200, this.folderJson(folder.id))
    if (one[2] && !one[3] && m === 'POST') {
      const g = f.get('group') ?? ''
      if (!this.store.groups.has(g)) return plain(400, 'Group does not exist')
      if (!folder.groups.has(g)) folder.groups.set(g, ALL)
      return ocs(1, 200, { success: true, folder: this.folderJson(folder.id) })
    }
    if (one[3] && m === 'POST') {
      const g = decodeURIComponent(one[3])
      if (!folder.groups.has(g)) return plain(400, 'Group not given access')
      folder.groups.set(g, Number(f.get('permissions') ?? 31))
      return ocs(1, 200, { success: true, folder: this.folderJson(folder.id) })
    }
    return ocs(1, 405, [])
  }
}
