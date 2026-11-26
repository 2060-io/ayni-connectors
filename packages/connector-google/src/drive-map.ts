/**
 * How Google Drive reads as Files 1.0 (providers §6, files §6): kinds, documents of Google's own and their exports,
 * versions, roles, and the words of Drive's query language. Pure functions, unit-tested on their own.
 */
import type { Item, Role, Share } from '@ayni.org/ayni-feature-profiles'

export const FOLDER = 'application/vnd.google-apps.folder'
export const SHORTCUT = 'application/vnd.google-apps.shortcut'
export const GOOGLE_PREFIX = 'application/vnd.google-apps.'
export const GOOGLE_DOC = 'application/vnd.google-apps.document'

/**
 * The formats Drive exports each of Google's own documents to (Drive's page "Export MIME types for Google Workspace
 * documents"): those are the documents that read as `native`. Google Vids is left out: `files.export` refuses it.
 */
export const EXPORT_TYPES: Readonly<Record<string, readonly string[]>> = {
  'application/vnd.google-apps.document': [
    'text/markdown',
    'text/plain',
    'application/pdf',
    'text/html',
    'application/zip',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.oasis.opendocument.text',
    'application/rtf',
    'application/epub+zip',
  ],
  'application/vnd.google-apps.spreadsheet': [
    'text/csv',
    'text/tab-separated-values',
    'application/pdf',
    'application/zip',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.oasis.opendocument.spreadsheet',
  ],
  'application/vnd.google-apps.presentation': [
    'text/plain',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.oasis.opendocument.presentation',
  ],
  'application/vnd.google-apps.drawing': ['application/pdf', 'image/png', 'image/jpeg', 'image/svg+xml'],
  'application/vnd.google-apps.script': ['application/vnd.google-apps.script+json'],
}

/** The fields of a file the connector reads, in Drive's `fields` syntax. */
export const FILE_FIELDS =
  'id,name,mimeType,parents,driveId,trashed,explicitlyTrashed,trashedTime,size,headRevisionId,version,createdTime,modifiedTime,lastModifyingUser(displayName),webViewLink,shortcutDetails(targetId),permissionIds,capabilities(canAddChildren)'

/** A file of Drive, with the fields of `FILE_FIELDS`. */
export interface DriveFile {
  id: string
  name: string
  mimeType: string
  parents?: string[]
  driveId?: string
  trashed?: boolean
  explicitlyTrashed?: boolean
  trashedTime?: string
  size?: string
  headRevisionId?: string
  version?: string
  createdTime?: string
  modifiedTime?: string
  lastModifyingUser?: { displayName?: string }
  webViewLink?: string
  shortcutDetails?: { targetId?: string }
  permissionIds?: string[]
  capabilities?: { canAddChildren?: boolean }
}

export interface DrivePermission {
  id: string
  type: 'user' | 'group' | 'domain' | 'anyone'
  role: 'owner' | 'organizer' | 'fileOrganizer' | 'writer' | 'commenter' | 'reader'
  emailAddress?: string
  domain?: string
  displayName?: string
  deleted?: boolean
  permissionDetails?: { permissionType?: string; role?: string; inherited?: boolean; inheritedFrom?: string }[]
}

export const PERMISSION_FIELDS =
  'id,type,role,emailAddress,domain,displayName,deleted,permissionDetails(permissionType,role,inherited,inheritedFrom)'

export function kindOf(mimeType: string): Item['kind'] {
  if (mimeType === FOLDER) return 'folder'
  if (mimeType === SHORTCUT) return 'link'
  return 'file'
}

/** A document of Google's own that Drive exports: no bytes of its own, read as text, exported (files §1, `native`). */
export function isNative(mimeType: string): boolean {
  return EXPORT_TYPES[mimeType] !== undefined
}

/** Any type of Google's own: no bytes to download. */
export function isGoogleType(mimeType: string): boolean {
  return mimeType.startsWith(GOOGLE_PREFIX)
}

/**
 * The text a native document reads as (files §1, Content): its export as `text/markdown` where Drive gives one, else
 * `text/plain`; none for a document Drive exports to neither, which `files_read` refuses (`files_export` gives it).
 */
export function readTypeOf(mimeType: string): string | undefined {
  const types = EXPORT_TYPES[mimeType] ?? []
  return types.includes('text/markdown') ? 'text/markdown' : types.includes('text/plain') ? 'text/plain' : undefined
}

/** A file's version (providers §6): `headRevisionId` for a file of bytes, `version` for a document of Google's own. */
export function versionOf(f: DriveFile): string | undefined {
  if (isGoogleType(f.mimeType)) return f.version
  return f.headRevisionId ?? f.version
}

/** Whether a media type is read as text (files §1, Content). */
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

/** A text of Drive's query language, between single quotes: `\` and `'` escaped. */
export function quote(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/** The words of a plain query (files §4.1): split on white space, no operator read. */
export function wordsOf(query: string): string[] {
  return query.split(/\s+/).filter(Boolean)
}

/** Drive's query for a search: every word, in the name or in the full text; no operator of the caller is read. */
export function searchQuery(words: string[], where: 'name' | 'content' | 'any'): string {
  const term = where === 'name' ? 'name' : 'fullText'
  return [...words.map((w) => `${term} contains ${quote(w)}`), 'trashed = false'].join(' and ')
}

/** Whether a text holds every word, whatever the case. */
export function holdsWords(text: string, words: string[]): boolean {
  const lower = text.toLowerCase()
  return words.every((w) => lower.includes(w.toLowerCase()))
}

/** A few words of a text around the first word found (files §4.1, `snippet`), or `undefined`. */
export function snippetOf(text: string, words: string[]): string | undefined {
  if (!holdsWords(text, words)) return undefined
  const lower = text.toLowerCase()
  const at = lower.indexOf((words[0] ?? '').toLowerCase())
  const snippet = text
    .slice(Math.max(0, at - 40), at + (words[0]?.length ?? 0) + 60)
    .replace(/\s+/g, ' ')
    .trim()
  return snippet.length > 0 ? snippet : undefined
}

/** Drive's role for a share of an item (files §4.4, the nearest that gives no more). */
export function driveRoleOfItem(role: Role): DrivePermission['role'] {
  return role === 'editor' ? 'writer' : 'reader'
}

/** Drive's role for a member of a shared drive (providers §6). */
export function driveRoleOfMember(role: Role): DrivePermission['role'] {
  return role === 'manager' ? 'organizer' : role === 'editor' ? 'fileOrganizer' : 'reader'
}

/** The profile's role of a permission: never more than Drive gives. */
export function roleOf(role: DrivePermission['role']): Role {
  if (role === 'organizer') return 'manager'
  if (role === 'fileOrganizer' || role === 'writer' || role === 'owner') return 'editor'
  return 'reader'
}

/** A name to show, never an address (FEAT-FILES-015). */
export function nameToShow(name: string | undefined): string | undefined {
  return name && !name.includes('@') ? name : undefined
}

/** A share of a permission (files §4.4); `inherited` when every detail of it comes from a folder above. */
export function shareOf(p: DrivePermission, webUrl: string | undefined, member = false): Share {
  const details = p.permissionDetails ?? []
  const inherited = !member && details.length > 0 && details.every((d) => d.inherited === true)
  const name = nameToShow(p.displayName)
  const out: Share = { id: p.id, role: roleOf(p.role), inherited }
  if ((p.type === 'user' || p.type === 'group') && p.emailAddress)
    out.recipient = { address: p.emailAddress, ...(name ? { name } : {}) }
  if (p.type === 'domain') out.audience = 'organization'
  if (p.type === 'anyone') {
    out.audience = 'anyone'
    if (webUrl) out.link = webUrl
  }
  return out
}

/** The addresses of the domain of an account's address, lower case. */
export function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase()
}

/** The reasons Google gives when a shared drive cannot take an address (providers §6, `recipient-refused`). */
export const NO_ACCOUNT_REASONS = new Set(['cannotShareTeamDriveWithNonGoogleAccounts'])
export const NOT_ALLOWED_REASONS = new Set([
  'shareOutNotPermitted',
  'shareInNotPermitted',
  'publishOutNotPermitted',
  'teamDriveDomainUsersOnlyRestriction',
  'shareOutNotPermittedToUser',
])

/** Google's limit of the members of a shared drive (providers §6). */
export const MAX_DRIVE_MEMBERS = 600

/** Drive's export limit, as `files.export` documents it: 10 MB. */
export const EXPORT_LIMIT_BYTES = 10 * 1024 * 1024
