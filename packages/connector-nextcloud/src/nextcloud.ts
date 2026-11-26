/**
 * What a Nextcloud says of an account, read on each request from its address alone (providers §5, FEAT-NC-001, 008):
 * the account's user id from `current-user-principal` (a login name may be an email address), and which of its parts
 * are on, from the OCS capabilities: the trash bin, versions, sharing, public links, shares by email, Team folders.
 * `team-roots` is declared only to an account that may set up team folders and make groups, which two requests that
 * change nothing tell: the Team folders app's count of folders (its administrators only) and the sub-administrators of
 * the group `admin` (those who may manage users and groups only).
 */
import { hrefsOf, NS, propfind } from './dav.js'
import type { HttpClient } from './http.js'
import { appUrl, ocs, ocsError, ocsOk, ocsUrl } from './ocs.js'
import { partsBelow } from './paths.js'

export interface NextcloudInfo {
  base: URL
  userId: string
  /** `{base}/remote.php/dav/` */
  dav: URL
  /** `{dav}files/{user}/`, the account's own folder */
  filesHome: URL
  trash: boolean
  versions: boolean
  sharing: boolean
  publicLinks: boolean
  shareByMail: boolean
  teamFolders: boolean
  /** the account may set up team folders and make groups (the managing account, agent D150) */
  teamRoots: boolean
}

export function davRoot(base: URL): URL {
  const u = new URL(base.toString())
  u.pathname = `${base.pathname.replace(/\/+$/, '')}/remote.php/dav/`
  return u
}

export function davUrl(base: URL, ...segments: string[]): URL {
  const u = davRoot(base)
  u.pathname = `${u.pathname}${segments.map((s) => encodeURIComponent(s)).join('/')}`
  return u
}

interface Capabilities {
  files?: { undelete?: boolean; versioning?: boolean }
  files_sharing?: { api_enabled?: boolean; public?: { enabled?: boolean }; sharebymail?: { enabled?: boolean } }
  groupfolders?: { appVersion?: string }
}

/** The account's user id, from its principal (`/remote.php/dav/principals/users/{user}/`). */
export async function userIdOf(http: HttpClient, base: URL, signal?: AbortSignal): Promise<string | undefined> {
  const dav = davRoot(base)
  const [res] = await propfind(http, dav, '0', [[NS.D, 'current-user-principal']], signal)
  const href = res ? hrefsOf(res, NS.D, 'current-user-principal')[0] : undefined
  const parts = href ? partsBelow(href, new URL('principals/users/', dav)) : undefined
  return parts?.length === 1 ? parts[0] : undefined
}

export async function discoverNextcloud(
  http: HttpClient,
  base: URL,
  user: Promise<string | undefined> = userIdOf(http, base)
): Promise<NextcloudInfo> {
  const [userId, caps] = await Promise.all([
    user,
    ocs<{ capabilities?: Capabilities }>(http, ocsUrl(base, 'cloud/capabilities')),
  ])
  if (!ocsOk(caps)) throw ocsError(caps)
  if (!userId) throw ocsError({ status: 502, statuscode: 502, message: '', data: null })
  const c = caps.data.capabilities ?? {}
  const sharing = c.files_sharing?.api_enabled === true
  const teamFolders = c.groupfolders !== undefined
  let teamRoots = false
  if (teamFolders && sharing) {
    const folders = await ocs(http, appUrl(base, 'apps/groupfolders/folders/count'))
    if (ocsOk(folders)) {
      const groups = await ocs(http, ocsUrl(base, 'cloud/groups/admin/subadmins'))
      teamRoots = ocsOk(groups)
    }
  }
  const dav = davRoot(base)
  return {
    base,
    userId,
    dav,
    filesHome: new URL(`files/${encodeURIComponent(userId)}/`, dav),
    trash: c.files?.undelete === true,
    versions: c.files?.versioning === true,
    sharing,
    publicLinks: sharing && c.files_sharing?.public?.enabled === true,
    shareByMail: sharing && c.files_sharing?.sharebymail?.enabled === true,
    teamFolders,
    teamRoots,
  }
}
