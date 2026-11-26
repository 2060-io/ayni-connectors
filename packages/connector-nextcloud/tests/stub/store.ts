/**
 * The state of the stub: users and groups; a tree of files per user, with Nextcloud's mounts (a share with a person,
 * mounted in their own tree; a team folder, mounted for the members of its groups), its file ids, its permissions
 * (1 read, 2 update, 4 create, 8 delete, 16 share), its trash bin and its versions (named by the second of the change
 * they replaced, as Nextcloud 35 does); calendars with their objects; and the messages the server would send.
 */
import { createHash, randomBytes } from 'node:crypto'

export interface User {
  id: string
  email?: string
  name: string
  password: string
  groups: Set<string>
  /** app passwords: they sign in, but confirm no password (Nextcloud's PasswordConfirmationRequired) */
  appPasswords: Set<string>
}

export interface Version {
  /** seconds: the name of the version */
  ts: number
  content: Buffer
  author: string
}

export interface FNode {
  id: number
  name: string
  folder: boolean
  parent?: FNode
  children: Map<string, FNode>
  content: Buffer
  /** the type a plain server keeps from the PUT */
  type?: string
  mtime: number
  ctime: number
  etag: string
  owner: string
  versions: Version[]
}

export interface Share {
  id: number
  owner: string
  node: FNode
  type: 0 | 3 | 4
  /** the user id (0) or the address (4) */
  shareWith?: string
  permissions: number
  note: string
  token?: string
  mailSend: boolean
  /** where a person's share is mounted in their tree (0) */
  target?: string[]
}

export interface TeamFolder {
  id: number
  mountPoint: string
  root: FNode
  groups: Map<string, number>
}

export interface TrashItem {
  node: FNode
  user: string
  /** the item's place in the user's tree before */
  place: string[]
  deletedAt: number
  name: string
}

export interface Mount {
  target: string[]
  root: FNode
  perms: number
  type: 'shared' | 'group'
}

/** A resource of a user's tree. */
export interface Entry {
  node: FNode
  parts: string[]
  perms: number
  mount?: Mount
  /** the entry is the root of its mount */
  mountRoot: boolean
}

export interface CalObject {
  name: string
  data: string
  etag: string
}

export interface StubCalendar {
  owner: string
  name: string
  displayName: string
  components: string[]
  timezone?: string
  objects: Map<string, CalObject>
  /** the users it is shared with, and whether they may write */
  sharedWith: Map<string, boolean>
}

export interface Message {
  to: string
  subject: string
  text: string
}

export const ALL = 31

const etag = () => `"${randomBytes(8).toString('hex')}"`

export class Store {
  public readonly users = new Map<string, User>()
  public readonly groups = new Set<string>(['admin'])
  /** groups whose members the Team folders app takes as its administrators (its delegation) */
  public readonly teamAdminGroups = new Set<string>()
  /** groups whose members may manage users and groups (Nextcloud's delegation of the Users settings) */
  public readonly userAdminGroups = new Set<string>()
  public readonly homes = new Map<string, FNode>()
  public readonly shares: Share[] = []
  public readonly folders: TeamFolder[] = []
  public readonly trash: TrashItem[] = []
  public readonly calendars: StubCalendar[] = []
  public readonly inbox = new Map<string, CalObject[]>()
  public readonly messages: Message[] = []
  private nextId = 100
  private nextShare = 1
  private nextFolder = 1

  public node(name: string, folder: boolean, owner: string, parent?: FNode): FNode {
    const now = Date.now()
    const n: FNode = {
      id: this.nextId++,
      name,
      folder,
      children: new Map(),
      content: Buffer.alloc(0),
      mtime: now,
      ctime: now,
      etag: etag(),
      owner,
      versions: [],
      ...(parent ? { parent } : {}),
    }
    if (parent) parent.children.set(name, n)
    return n
  }

  public addUser(u: { id: string; email?: string; name: string; password: string; groups?: string[] }): User {
    const user: User = { ...u, groups: new Set(u.groups ?? []), appPasswords: new Set() }
    for (const g of user.groups) this.groups.add(g)
    this.users.set(u.id, user)
    this.homes.set(u.id, this.node(u.id, true, u.id))
    return user
  }

  public userByLogin(login: string): User | undefined {
    return this.users.get(login) ?? [...this.users.values()].find((u) => u.email?.toLowerCase() === login.toLowerCase())
  }

  public isAdmin(uid: string): boolean {
    return !!this.users.get(uid)?.groups.has('admin')
  }

  public isTeamAdmin(uid: string): boolean {
    const u = this.users.get(uid)
    return !!u && (u.groups.has('admin') || [...u.groups].some((g) => this.teamAdminGroups.has(g)))
  }

  public isUserAdmin(uid: string): boolean {
    const u = this.users.get(uid)
    return !!u && (u.groups.has('admin') || [...u.groups].some((g) => this.userAdminGroups.has(g)))
  }

  /** A change: a new entity tag, propagated to every folder above, as Nextcloud does. */
  public touch(n: FNode, mtime = Date.now()): void {
    n.etag = etag()
    n.mtime = mtime
    for (let p = n.parent; p; p = p.parent) p.etag = etag()
  }

  public mountsOf(uid: string): Mount[] {
    const out: Mount[] = []
    for (const s of this.shares)
      if (s.type === 0 && s.shareWith === uid && s.target && this.alive(s.node))
        out.push({ target: s.target, root: s.node, perms: s.permissions, type: 'shared' })
    const u = this.users.get(uid)
    for (const f of this.folders) {
      let perms = 0
      for (const [g, p] of f.groups) if (u?.groups.has(g)) perms |= p
      if (perms) out.push({ target: f.mountPoint.split('/').filter(Boolean), root: f.root, perms, type: 'group' })
    }
    return out
  }

  /** Whether a node is still in a tree (not in a trash bin, not removed). */
  public alive(n: FNode): boolean {
    let x: FNode | undefined = n
    while (x?.parent) {
      if (x.parent.children.get(x.name) !== x) return false
      x = x.parent
    }
    return !!x && ([...this.homes.values()].includes(x) || this.folders.some((f) => f.root === x))
  }

  /** A path of a user's tree, through the mounts. */
  public resolve(uid: string, parts: readonly string[]): Entry | undefined {
    const home = this.homes.get(uid)
    if (!home) return undefined
    const mounts = this.mountsOf(uid)
    let best: Mount | undefined
    for (const m of mounts)
      if (m.target.length <= parts.length && m.target.every((p, i) => p === parts[i]))
        if (!best || m.target.length > best.target.length) best = m
    let node: FNode = best ? best.root : home
    const start = best ? best.target.length : 0
    for (let i = start; i < parts.length; i++) {
      const c = node.folder ? node.children.get(parts[i] as string) : undefined
      if (!c) return undefined
      node = c
    }
    return {
      node,
      parts: [...parts],
      perms: best ? best.perms : ALL,
      ...(best ? { mount: best } : {}),
      mountRoot: !!best && parts.length === best.target.length,
    }
  }

  /** What a folder of a user's tree holds: its children and the mounts placed in it. */
  public children(uid: string, e: Entry): Entry[] {
    const out: Entry[] = []
    for (const c of e.node.children.values()) {
      const r = this.resolve(uid, [...e.parts, c.name])
      if (r && r.node === c) out.push(r)
    }
    for (const m of this.mountsOf(uid))
      if (m.target.length === e.parts.length + 1 && e.parts.every((p, i) => p === m.target[i])) {
        const r = this.resolve(uid, m.target)
        if (r && !out.some((o) => o.node === r.node)) out.push(r)
      }
    return out
  }

  /** Every entry below a folder of a user's tree, at any depth, the folder itself left out. */
  public below(uid: string, e: Entry): Entry[] {
    const out: Entry[] = []
    const walk = (x: Entry, depth: number) => {
      if (depth > 64) return
      for (const c of this.children(uid, x)) {
        out.push(c)
        if (c.node.folder) walk(c, depth + 1)
      }
    }
    walk(e, 0)
    return out
  }

  public share(s: Omit<Share, 'id'>): Share {
    const share: Share = { ...s, id: this.nextShare++ }
    this.shares.push(share)
    return share
  }

  public teamFolder(mountPoint: string): TeamFolder {
    const root = this.node(mountPoint, true, '__groupfolders')
    const f: TeamFolder = { id: this.nextFolder++, mountPoint, root, groups: new Map() }
    this.folders.push(f)
    return f
  }

  public calendar(owner: string, name: string, displayName: string, timezone?: string): StubCalendar {
    const c: StubCalendar = {
      owner,
      name,
      displayName,
      components: ['VEVENT'],
      objects: new Map(),
      sharedWith: new Map(),
      ...(timezone ? { timezone } : {}),
    }
    this.calendars.push(c)
    return c
  }

  public calendarOf(owner: string, name: string): StubCalendar | undefined {
    return this.calendars.find((c) => c.owner === owner && c.name === name)
  }

  /** The calendars of a user's home: their own, and those shared with them as `{name}_shared_by_{owner}`. */
  public calendarsOf(uid: string): { cal: StubCalendar; name: string; writable: boolean }[] {
    const out: { cal: StubCalendar; name: string; writable: boolean }[] = []
    for (const c of this.calendars) {
      if (c.owner === uid) out.push({ cal: c, name: c.name, writable: true })
      else if (c.sharedWith.has(uid))
        out.push({ cal: c, name: `${c.name}_shared_by_${c.owner}`, writable: c.sharedWith.get(uid) === true })
    }
    return out
  }

  public object(data: string): CalObject {
    return { name: '', data, etag: `"${createHash('sha1').update(data).update(randomBytes(4)).digest('hex')}"` }
  }
}
