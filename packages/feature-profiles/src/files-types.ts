/** The TypeScript shapes of Files 1.0 (files §1 to §4): its items, its declaration, and each tool's arguments and result. */
import type { DeclarationBase } from './common.js'
import type { FilesCapability } from './files.js'

export type ItemKind = 'file' | 'folder' | 'link'

/** An item (files §1). */
export interface Item {
  ref: string
  root: string
  kind: ItemKind
  name: string
  path: string
  parent?: string
  mediaType?: string
  sizeBytes?: number
  version?: string
  createdAt?: string
  modifiedAt?: string
  modifiedBy?: string
  native?: true
  shared?: true
  trashedAt?: string
  exportTypes?: string[]
  webUrl?: string
  [member: `x_${string}`]: unknown
}

/** A root (files §2). */
export interface Root {
  ref: string
  title: string
  path: string
  writable: boolean
  portable: boolean
  team?: true
}

/** A content as a read answers it (files §1). */
export type Content =
  | { kind: 'text'; text: string; mediaType: string }
  | { kind: 'bytes'; base64: string; mediaType: string }

/** A content as a create or a replace takes it. */
export type ContentInput = { text: string } | { base64: string }

export type Role = 'reader' | 'editor' | 'manager'
export type Audience = 'organization' | 'anyone'

/** A share (files §4.4). */
export interface Share {
  id: string
  role: Role
  recipient?: { address: string; name?: string }
  audience?: Audience
  link?: string
  inherited: boolean
}

/** A former version of a file (files §4.5). */
export interface VersionEntry {
  version: string
  modifiedAt: string
  modifiedBy?: string
  sizeBytes?: number
}

/** What a provider of Files declares (common §3, files §4). */
export interface FilesDeclaration extends DeclarationBase<FilesCapability> {
  search?: { content?: boolean }
  share?: { audiences?: Audience[]; notify?: boolean }
  'team-roots'?: { manager?: boolean }
}

export interface PageArgs {
  limit?: number
  cursor?: string
}

export interface Page {
  nextCursor?: string
}

export interface FilesRootsArgs extends PageArgs {
  query?: string
}
export interface FilesRootsResult extends Page {
  roots: Root[]
}

export interface FilesListArgs extends PageArgs {
  root: string
  folder?: string
}
export interface FilesListResult extends Page {
  folder: Item
  items: Item[]
}

export interface FilesGetArgs {
  root: string
  ref: string
}
export interface ItemResult {
  item: Item
}

export interface FilesReadArgs {
  root: string
  ref: string
  maxBytes?: number
  /** capability `versions` */
  version?: string
}
export interface FilesReadResult {
  item: Item
  content: Content
  truncated?: true
}

export interface FilesCreateArgs {
  root: string
  folder?: string
  name: string
  content: ContentInput
  mediaType?: string
}

export interface FilesReplaceArgs {
  root: string
  ref: string
  ifVersion: string
  content: ContentInput
  mediaType?: string
}

export type SearchIn = 'name' | 'content' | 'any'

export interface FilesSearchArgs extends PageArgs {
  root: string
  query: string
  folder?: string
  in?: SearchIn
}
export interface FilesSearchResult extends Page {
  items: (Item & { snippet?: string })[]
}

export interface FilesCreateFolderArgs {
  root: string
  folder?: string
  name: string
}

export interface FilesMoveArgs {
  root: string
  ref: string
  toFolder?: string
  newName?: string
  ifVersion?: string
}

export interface FilesTrashArgs {
  root: string
  ref: string
  ifVersion?: string
}

export interface FilesRestoreArgs {
  root: string
  ref: string
}

export interface FilesListTrashArgs extends PageArgs {
  root: string
}
export interface FilesListTrashResult extends Page {
  items: Item[]
}

export interface FilesSharesArgs {
  root: string
  ref: string
}
export interface SharesResult {
  shares: Share[]
}

export interface FilesShareArgs {
  root: string
  ref: string
  role: Role
  recipients?: { address: string }[]
  audience?: Audience
  notify?: boolean
  message?: string
}

export interface FilesUnshareArgs {
  root: string
  ref: string
  share: string
}

export interface FilesVersionsArgs extends PageArgs {
  root: string
  ref: string
}
export interface FilesVersionsResult extends Page {
  versions: VersionEntry[]
}

export interface FilesExportArgs {
  root: string
  ref: string
  mediaType: string
}
export interface FilesExportResult {
  item: Item
  content: Content
}

export interface FilesCreateTeamRootArgs {
  name: string
  requestId: string
}
export interface RootResult {
  root: Root
}

export interface FilesRenameRootArgs {
  root: string
  name: string
}
