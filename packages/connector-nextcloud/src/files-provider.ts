/**
 * The provider of Files of a request (providers §2): what it declares, from what the server says (FEAT-NC-001,
 * FEAT-WEBDAV-005), and the handlers of the tools declared. A request that cannot reach its server (no credentials, an
 * address refused, the server down) is declared the core alone, each of whose calls answers why.
 */
import type { FilesCapability, FilesDeclaration } from '@ayni.org/ayni-feature-profiles'
import { errors, type FilesProvider, type ProfileError, type ProviderDeclaration } from '@ayni.org/ayni-provider-kit'
import type { DavAccountData } from './account.js'
import { NS, propfind, propText, statusError } from './dav.js'
import { DavFiles, offersBasicSearch } from './files.js'
import { asProfileError, type RequestScope } from './scope.js'
import { NcShares } from './shares.js'

type Provider = FilesProvider<DavAccountData>

/** The core alone, every call refused with the same error. */
export function refusingFiles(problem: ProfileError): Provider {
  const refuse = async (): Promise<never> => {
    throw problem
  }
  return {
    declaration: { capabilities: [], atomicWrites: false },
    roots: refuse,
    list: refuse,
    get: refuse,
    read: refuse,
    create: refuse,
    replace: refuse,
  }
}

function core(f: DavFiles, declaration: ProviderDeclaration<FilesDeclaration>): Provider {
  return {
    declaration,
    roots: (a, c) => f.roots(a, c),
    list: (a, c) => f.list(a, c),
    get: (a, c) => f.get(a, c),
    read: (a, c) => f.read(a, c),
    create: (a, c) => f.create(a, c),
    replace: (a, c) => f.replace(a, c),
    createFolder: (a, c) => f.createFolder(a, c),
    move: (a, c) => f.move(a, c),
  }
}

/** The Files of a Nextcloud (providers §2, §5): each capability only when the server says its part is on. */
export function nextcloudFiles(f: DavFiles): Provider {
  const nc = f.s.nc
  if (!nc) throw new Error('a Nextcloud provider without its Nextcloud')
  const capabilities: FilesCapability[] = ['search', 'folders']
  if (nc.trash) capabilities.push('trash')
  if (nc.sharing) capabilities.push('share')
  if (nc.versions) capabilities.push('versions')
  if (nc.teamRoots) capabilities.push('team-roots')
  const declaration: ProviderDeclaration<FilesDeclaration> = {
    capabilities,
    atomicWrites: true,
    search: { content: false },
    ...(nc.sharing ? { share: { audiences: nc.publicLinks ? ['anyone'] : [], notify: true } } : {}),
    ...(nc.teamRoots ? { 'team-roots': { manager: false } } : {}),
  }
  const p = core(f, declaration)
  p.search = (a, c) => f.searchNames(a, c)
  if (nc.trash) {
    p.trash = (a, c) => f.trash(a, c)
    p.restore = (a, c) => f.restore(a, c)
    p.listTrash = (a, c) => f.listTrash(a, c)
  }
  if (nc.versions) p.versions = (a, c) => f.versions(a, c)
  if (nc.sharing) {
    const s = new NcShares(f)
    p.shares = (a, c) => s.shares(a, c)
    p.share = (a, c) => s.share(a, c)
    p.unshare = (a, c) => s.unshare(a, c)
    if (nc.teamRoots) {
      p.createTeamRoot = (a, c) => s.createTeamRoot(a, c)
      p.renameRoot = (a, c) => s.renameRoot(a, c)
    }
  }
  return p
}

/** The Files of any other WebDAV server (providers §3): the core and `folders`, `search` where it offers `DASL`. */
export function webdavFiles(f: DavFiles): Provider {
  const capabilities: FilesCapability[] = ['folders']
  if (f.s.dasl) capabilities.unshift('search')
  const p = core(f, {
    capabilities,
    atomicWrites: f.s.etags,
    ...(f.s.dasl ? { search: { content: false } } : {}),
  })
  if (f.s.dasl) p.search = (a, c) => f.searchNames(a, c)
  return p
}

/** The provider of Files of a request, or `undefined` for a request that names no store of files (FEAT-DAV-001). */
export async function filesFor(scope: RequestScope): Promise<Provider | undefined> {
  const target = scope.target.files
  if (!target) return undefined
  const problem = scope.problem
  if (problem || !scope.http) return refusingFiles(problem ?? errors.accountRefused())
  const http = scope.http
  const logger = scope.config.logger
  try {
    if (target.kind === 'nextcloud') {
      const nc = await scope.nextcloud(target.base)
      return nextcloudFiles(
        new DavFiles({ http, home: nc.filesHome, nc, etags: true, dasl: true, logger, ownTitle: 'All files' })
      )
    }
    // a plain server: whether it searches (`DASL`, RFC 5323) and whether it gives entity tags (FEAT-WEBDAV-004, 005)
    const options = await http.send({ method: 'OPTIONS', url: target.folder })
    if (options.status === 401) throw statusError(options)
    const dasl = options.status < 300 && offersBasicSearch(options.headers.dasl)
    const [self] = await propfind(http, target.folder, '0', [
      [NS.D, 'getetag'],
      [NS.D, 'resourcetype'],
      [NS.D, 'displayname'],
    ])
    let etags = !!(self && propText(self, NS.D, 'getetag'))
    if (!etags) {
      const below = await propfind(http, target.folder, '1', [[NS.D, 'getetag']])
      etags = below.some((r) => !!propText(r, NS.D, 'getetag'))
    }
    const title = (self && propText(self, NS.D, 'displayname')) ?? 'Your folder'
    return webdavFiles(new DavFiles({ http, home: target.folder, etags, dasl, logger, ownTitle: title }))
  } catch (error) {
    return refusingFiles(asProfileError(error))
  }
}
