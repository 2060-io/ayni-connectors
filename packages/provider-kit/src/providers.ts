/**
 * What a connector supplies: one handler per tool of a profile, grouped by profile (`FilesProvider`,
 * `CalendarProvider`), with the declaration it makes for the account of the request. The kit lists the tools, checks
 * each call against the contract, pages, and maps what a handler answers or throws to the profile's result or error.
 */
import type {
  CalendarCalendarsArgs,
  CalendarCalendarsResult,
  CalendarCancelEventArgs,
  CalendarCancelEventResult,
  CalendarCreateEventArgs,
  CalendarDeclaration,
  CalendarFreeBusyArgs,
  CalendarFreeBusyResult,
  CalendarGetEventArgs,
  CalendarListEventsArgs,
  CalendarListEventsResult,
  CalendarRespondArgs,
  CalendarUpdateEventArgs,
  EventResult,
  FilesCreateArgs,
  FilesCreateFolderArgs,
  FilesCreateTeamRootArgs,
  FilesDeclaration,
  FilesExportArgs,
  FilesExportResult,
  FilesGetArgs,
  FilesListArgs,
  FilesListResult,
  FilesListTrashArgs,
  FilesListTrashResult,
  FilesMoveArgs,
  FilesReadArgs,
  FilesReadResult,
  FilesRenameRootArgs,
  FilesReplaceArgs,
  FilesRestoreArgs,
  FilesRootsArgs,
  FilesRootsResult,
  FilesSearchArgs,
  FilesSearchResult,
  FilesShareArgs,
  FilesSharesArgs,
  FilesTrashArgs,
  FilesUnshareArgs,
  FilesVersionsArgs,
  FilesVersionsResult,
  ItemResult,
  Limits,
  PageArgs,
  RootResult,
  SharesResult,
} from '@ayni.org/ayni-feature-profiles'
import type { Account } from './account.js'

export type Awaitable<T> = T | Promise<T>

/** Where a connector writes what it does: never a credential, an argument or a content. */
export interface Logger {
  debug(fields: Record<string, unknown>, message: string): void
  info(fields: Record<string, unknown>, message: string): void
  warn(fields: Record<string, unknown>, message: string): void
  error(fields: Record<string, unknown>, message: string): void
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} }

/** A question the service asks the person before it acts, passed on as an input request of the call (common §4). */
export interface Question {
  /** an identifier of the question within the call */
  key: string
  /** one sentence the person reads */
  message: string
}

/** What a handler is given beside its arguments. */
export interface CallContext<D = unknown, Decl = unknown> {
  /** the account of the request, never absent: a call without one answers `account-refused` before a handler runs */
  account: Account<D>
  /** what the server declared for this account */
  declaration: Decl
  /** the server's limits, each absent member taken as the default */
  limits: Limits
  signal: AbortSignal
  logger: Logger
  /**
   * Passes on a question of the service (FEAT-CORE-024): returns once the person accepted; a decline or a cancel ends
   * the call with `permission-denied`, before the handler changes anything. The handler runs again from its start
   * with the answer, so it asks before it writes.
   */
  ask(question: Question): void
}

/** The context of a tool that lists: the page asked, `limit` already bounded by the server's `page` (common §7). */
export interface PagedContext<D = unknown, Decl = unknown> extends CallContext<D, Decl> {
  page: {
    limit: number
    /** the provider's own cursor, as its handler answered it as `nextCursor` for the page before */
    cursor?: string
  }
}

type Unpaged<T> = Omit<T, keyof PageArgs>

/** The declaration a provider makes, without `version`, which the kit sets. */
export type ProviderDeclaration<T> = Omit<T, 'version'>

/** A provider of Files 1.0: the six core handlers, and those of each capability it declares. */
export interface FilesProvider<D = unknown> {
  declaration: ProviderDeclaration<FilesDeclaration>
  roots(args: Unpaged<FilesRootsArgs>, ctx: PagedContext<D, FilesDeclaration>): Awaitable<FilesRootsResult>
  list(args: Unpaged<FilesListArgs>, ctx: PagedContext<D, FilesDeclaration>): Awaitable<FilesListResult>
  get(args: FilesGetArgs, ctx: CallContext<D, FilesDeclaration>): Awaitable<ItemResult>
  read(args: FilesReadArgs, ctx: CallContext<D, FilesDeclaration>): Awaitable<FilesReadResult>
  create(args: FilesCreateArgs, ctx: CallContext<D, FilesDeclaration>): Awaitable<ItemResult>
  replace(args: FilesReplaceArgs, ctx: CallContext<D, FilesDeclaration>): Awaitable<ItemResult>
  /** `search` */
  search?(args: Unpaged<FilesSearchArgs>, ctx: PagedContext<D, FilesDeclaration>): Awaitable<FilesSearchResult>
  /** `folders` */
  createFolder?(args: FilesCreateFolderArgs, ctx: CallContext<D, FilesDeclaration>): Awaitable<ItemResult>
  /** `folders` */
  move?(args: FilesMoveArgs, ctx: CallContext<D, FilesDeclaration>): Awaitable<ItemResult>
  /** `trash` */
  trash?(args: FilesTrashArgs, ctx: CallContext<D, FilesDeclaration>): Awaitable<ItemResult>
  /** `trash` */
  restore?(args: FilesRestoreArgs, ctx: CallContext<D, FilesDeclaration>): Awaitable<ItemResult>
  /** `trash` */
  listTrash?(args: Unpaged<FilesListTrashArgs>, ctx: PagedContext<D, FilesDeclaration>): Awaitable<FilesListTrashResult>
  /** `share` */
  shares?(args: FilesSharesArgs, ctx: CallContext<D, FilesDeclaration>): Awaitable<SharesResult>
  /** `share` */
  share?(args: FilesShareArgs, ctx: CallContext<D, FilesDeclaration>): Awaitable<SharesResult>
  /** `share` */
  unshare?(args: FilesUnshareArgs, ctx: CallContext<D, FilesDeclaration>): Awaitable<SharesResult>
  /** `versions` */
  versions?(args: Unpaged<FilesVersionsArgs>, ctx: PagedContext<D, FilesDeclaration>): Awaitable<FilesVersionsResult>
  /** `export` */
  export?(args: FilesExportArgs, ctx: CallContext<D, FilesDeclaration>): Awaitable<FilesExportResult>
  /** `team-roots` */
  createTeamRoot?(args: FilesCreateTeamRootArgs, ctx: CallContext<D, FilesDeclaration>): Awaitable<RootResult>
  /** `team-roots` */
  renameRoot?(args: FilesRenameRootArgs, ctx: CallContext<D, FilesDeclaration>): Awaitable<RootResult>
}

/** A provider of Calendar 1.0: the six core handlers, and those of each capability it declares. */
export interface CalendarProvider<D = unknown> {
  declaration: ProviderDeclaration<CalendarDeclaration>
  calendars(
    args: Unpaged<CalendarCalendarsArgs>,
    ctx: PagedContext<D, CalendarDeclaration>
  ): Awaitable<CalendarCalendarsResult>
  listEvents(
    args: Unpaged<CalendarListEventsArgs>,
    ctx: PagedContext<D, CalendarDeclaration>
  ): Awaitable<CalendarListEventsResult>
  getEvent(args: CalendarGetEventArgs, ctx: CallContext<D, CalendarDeclaration>): Awaitable<EventResult>
  createEvent(args: CalendarCreateEventArgs, ctx: CallContext<D, CalendarDeclaration>): Awaitable<EventResult>
  updateEvent(args: CalendarUpdateEventArgs, ctx: CallContext<D, CalendarDeclaration>): Awaitable<EventResult>
  cancelEvent(
    args: CalendarCancelEventArgs,
    ctx: CallContext<D, CalendarDeclaration>
  ): Awaitable<CalendarCancelEventResult>
  /** `free-busy` */
  freeBusy?(args: CalendarFreeBusyArgs, ctx: CallContext<D, CalendarDeclaration>): Awaitable<CalendarFreeBusyResult>
  /** `respond` */
  respond?(args: CalendarRespondArgs, ctx: CallContext<D, CalendarDeclaration>): Awaitable<EventResult>
}

/** The handler of a tool: its name without the profile's prefix, in camel case (`files_list_trash` is `listTrash`). */
export function handlerName(toolName: string, prefix: string): string {
  return toolName.slice(prefix.length).replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
}
