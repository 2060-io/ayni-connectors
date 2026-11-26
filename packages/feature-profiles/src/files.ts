/**
 * Files 1.0 (spec `v4/ayni-feature-profiles/files.md`), transcribed: identifier `org.ayni/files`, prefix `files_`,
 * location argument `root`. The descriptions are the words the model reads; the titles, those people read.
 */
import {
  COMMON_ERRORS,
  type ErrorDefinition,
  errorContentSchema,
  INSTANT_SCHEMA,
  type JsonSchema,
  NEXT_CURSOR_SCHEMA,
  REF_SCHEMA,
  VERSION_SCHEMA,
} from './common.js'
import { type ArgumentDefinition, type ProfileDefinition, pageArguments, type ToolDefinition } from './profile.js'

export const FILES_ID = 'org.ayni/files'
export const FILES_VERSION = '1.0'
export const FILES_PREFIX = 'files_'

export const FILES_CAPABILITIES = ['search', 'folders', 'trash', 'share', 'versions', 'export', 'team-roots'] as const
export type FilesCapability = (typeof FILES_CAPABILITIES)[number]

/** A name (files §1): 1 to 255 characters, no `/`, no control character, neither `.` nor `..`. */
export const NAME_PATTERN = '^(?!\\.{1,2}$)[^/\\u0000-\\u001F\\u007F-\\u009F]+$'

const NAME: JsonSchema = { type: 'string', minLength: 1, maxLength: 255, pattern: NAME_PATTERN }
/** The name of a team root: 1 to 100 characters, under the rules of a name (files §4.7). */
const TEAM_ROOT_NAME: JsonSchema = { type: 'string', minLength: 1, maxLength: 100, pattern: NAME_PATTERN }
const EMAIL: JsonSchema = { type: 'string', format: 'email', maxLength: 254 }
const MEDIA_TYPE: JsonSchema = { type: 'string', pattern: '^[^/\\s]+/[^/\\s]+$' }
const ROLE_ENUM = ['reader', 'editor', 'manager']

/** An item (files §1). Members present only when true are `const: true`, never `false`. */
export const ITEM_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['ref', 'root', 'kind', 'name', 'path'],
  properties: {
    ref: REF_SCHEMA,
    root: REF_SCHEMA,
    kind: { enum: ['file', 'folder', 'link'] },
    name: { type: 'string', minLength: 1 },
    path: { type: 'string', pattern: '^/' },
    parent: REF_SCHEMA,
    mediaType: { type: 'string', minLength: 1 },
    sizeBytes: { type: 'integer', minimum: 0 },
    version: VERSION_SCHEMA,
    createdAt: INSTANT_SCHEMA,
    modifiedAt: INSTANT_SCHEMA,
    modifiedBy: { type: 'string', pattern: '^[^@]*$' },
    native: { const: true },
    shared: { const: true },
    trashedAt: INSTANT_SCHEMA,
    exportTypes: { type: 'array', items: { type: 'string', minLength: 1 } },
    webUrl: { type: 'string', minLength: 1 },
  },
  allOf: [
    {
      if: { properties: { kind: { const: 'file' } }, required: ['kind'] },
      then: { required: ['mediaType', 'version'] },
    },
  ],
}

const ITEM_IN_TRASH: JsonSchema = { allOf: [ITEM_SCHEMA, { required: ['trashedAt'] }] }
const SEARCH_ITEM: JsonSchema = {
  allOf: [ITEM_SCHEMA, { properties: { snippet: { type: 'string', minLength: 1 } } }],
}

/** A root (files §2). */
export const ROOT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['ref', 'title', 'path', 'writable', 'portable'],
  properties: {
    ref: REF_SCHEMA,
    title: { type: 'string' },
    path: { type: 'string', pattern: '^/' },
    writable: { type: 'boolean' },
    portable: { type: 'boolean' },
    team: { const: true },
  },
}

/** A content as a read answers it (files §1, Content). */
export const CONTENT_SCHEMA: JsonSchema = {
  oneOf: [
    {
      type: 'object',
      required: ['kind', 'text', 'mediaType'],
      properties: { kind: { const: 'text' }, text: { type: 'string' }, mediaType: { type: 'string', minLength: 1 } },
    },
    {
      type: 'object',
      required: ['kind', 'base64', 'mediaType'],
      properties: {
        kind: { const: 'bytes' },
        base64: { type: 'string', contentEncoding: 'base64' },
        mediaType: { type: 'string', minLength: 1 },
      },
    },
  ],
}

/** A content as a create or a replace takes it: `{ "text" }` or `{ "base64" }`. */
const CONTENT_ARGUMENT: JsonSchema = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    base64: { type: 'string', pattern: '^[A-Za-z0-9+/]*={0,2}$' },
  },
  minProperties: 1,
  maxProperties: 1,
  additionalProperties: false,
}

/** A share (files §4.4). */
export const SHARE_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['id', 'role', 'inherited'],
  properties: {
    id: { type: 'string', minLength: 1 },
    role: { enum: ROLE_ENUM },
    recipient: {
      type: 'object',
      required: ['address'],
      properties: { address: { type: 'string', minLength: 1 }, name: { type: 'string' } },
    },
    audience: { enum: ['organization', 'anyone'] },
    link: { type: 'string', minLength: 1 },
    inherited: { type: 'boolean' },
  },
}

const VERSION_ENTRY: JsonSchema = {
  type: 'object',
  required: ['version', 'modifiedAt'],
  properties: {
    version: VERSION_SCHEMA,
    modifiedAt: INSTANT_SCHEMA,
    modifiedBy: { type: 'string', pattern: '^[^@]*$' },
    sizeBytes: { type: 'integer', minimum: 0 },
  },
}

function object(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: 'object', required, properties }
}

const ROOT_ARG: ArgumentDefinition = { name: 'root', title: 'Folder', schema: REF_SCHEMA, required: true }
const ref = (title: string): ArgumentDefinition => ({ name: 'ref', title, schema: REF_SCHEMA, required: true })
const IF_VERSION_REQUIRED: ArgumentDefinition = {
  name: 'ifVersion',
  title: 'Version read',
  schema: VERSION_SCHEMA,
  required: true,
}
const IF_VERSION_OPTIONAL: ArgumentDefinition = { ...IF_VERSION_REQUIRED, required: false }

const ITEM_RESULT = object(['item'], { item: ITEM_SCHEMA })
const SHARES_RESULT = object(['shares'], { shares: { type: 'array', items: SHARE_SCHEMA } })
const ROOT_RESULT = object(['root'], { root: ROOT_SCHEMA })

export const FILES_TOOLS: ToolDefinition[] = [
  // §3 Core operations
  {
    name: 'files_roots',
    title: 'List folders to work in',
    description: 'List the folders you can work in. Give the start of a path to narrow the list.',
    capability: null,
    effect: 'read',
    untrusted: 'names',
    arguments: [
      {
        name: 'query',
        title: 'Path begins with',
        schema: { type: 'string', minLength: 1, maxLength: 200 },
        required: false,
      },
      ...pageArguments(),
    ],
    result: object(['roots'], { roots: { type: 'array', items: ROOT_SCHEMA }, nextCursor: NEXT_CURSOR_SCHEMA }),
    itemMembers: [],
    errors: [],
    pages: true,
    located: false,
  },
  {
    name: 'files_list',
    title: 'List a folder',
    description:
      'List what a folder holds, one level only, without the content of its files. With no folder, list the top of the folder you work in.',
    capability: null,
    effect: 'read',
    untrusted: 'names',
    arguments: [
      ROOT_ARG,
      { name: 'folder', title: 'Folder to list', schema: REF_SCHEMA, required: false },
      ...pageArguments(),
    ],
    result: object(['folder', 'items'], {
      folder: ITEM_SCHEMA,
      items: { type: 'array', items: ITEM_SCHEMA },
      nextCursor: NEXT_CURSOR_SCHEMA,
    }),
    itemMembers: ['folder', 'items'],
    errors: ['not-found', 'not-supported'],
    pages: true,
    located: true,
  },
  {
    name: 'files_get',
    title: 'Look at a file or a folder',
    description: 'Look at one file or folder: its name, path, type, size, version and dates, without its content.',
    capability: null,
    effect: 'read',
    untrusted: 'names',
    arguments: [ROOT_ARG, ref('Item')],
    result: ITEM_RESULT,
    itemMembers: ['item'],
    errors: ['not-found'],
    pages: false,
    located: true,
  },
  {
    name: 'files_read',
    title: 'Read a file',
    description:
      "Read a file's content: a text file, or a document of the store's own, as text; any other file as its bytes. Give maxBytes to read only the start of a long text.",
    capability: null,
    effect: 'read',
    untrusted: 'names and content',
    arguments: [
      ROOT_ARG,
      ref('File'),
      { name: 'maxBytes', title: 'Most bytes of text', schema: { type: 'integer', minimum: 1 }, required: false },
      { name: 'version', title: 'Version', schema: VERSION_SCHEMA, required: false, capability: 'versions' },
    ],
    result: object(['item', 'content'], { item: ITEM_SCHEMA, content: CONTENT_SCHEMA, truncated: { const: true } }),
    itemMembers: ['item'],
    errors: ['not-found', 'not-supported', 'too-large'],
    pages: false,
    located: true,
  },
  {
    name: 'files_create',
    title: 'Create a file',
    description:
      'Create a new file with its content in a folder. Nothing is written if an item of that name is already there, and no folder is created on the way.',
    capability: null,
    effect: 'write',
    untrusted: 'names',
    arguments: [
      ROOT_ARG,
      { name: 'folder', title: 'In folder', schema: REF_SCHEMA, required: false },
      { name: 'name', title: 'Name', schema: NAME, required: true },
      { name: 'content', title: 'Content', schema: CONTENT_ARGUMENT, required: true },
      { name: 'mediaType', title: 'Type', schema: MEDIA_TYPE, required: false },
    ],
    result: ITEM_RESULT,
    itemMembers: ['item'],
    errors: ['already-exists', 'not-found', 'invalid-argument', 'too-large', 'permission-denied'],
    pages: false,
    located: true,
  },
  {
    name: 'files_replace',
    title: "Replace a file's content",
    description:
      'Replace the whole content of an existing file. Give the version you read: if the file changed since, nothing is written and the current version comes back.',
    capability: null,
    effect: 'write',
    untrusted: 'names',
    arguments: [
      ROOT_ARG,
      ref('File'),
      IF_VERSION_REQUIRED,
      { name: 'content', title: 'New content', schema: CONTENT_ARGUMENT, required: true },
      { name: 'mediaType', title: 'Type', schema: MEDIA_TYPE, required: false },
    ],
    result: ITEM_RESULT,
    itemMembers: ['item'],
    errors: ['version-mismatch', 'not-found', 'not-supported', 'too-large', 'permission-denied'],
    pages: false,
    located: true,
  },
  // §4.1 search
  {
    name: 'files_search',
    title: 'Search files',
    description:
      'Find files and folders by words in their name, their content, or either. Plain words only: no search operators.',
    capability: 'search',
    effect: 'read',
    untrusted: 'names and content',
    arguments: [
      ROOT_ARG,
      { name: 'query', title: 'Words', schema: { type: 'string', minLength: 1, maxLength: 200 }, required: true },
      { name: 'folder', title: 'In folder', schema: REF_SCHEMA, required: false },
      { name: 'in', title: 'Search in', schema: { enum: ['name', 'content', 'any'] }, required: false },
      ...pageArguments(),
    ],
    result: object(['items'], { items: { type: 'array', items: SEARCH_ITEM }, nextCursor: NEXT_CURSOR_SCHEMA }),
    itemMembers: ['items'],
    errors: ['not-supported'],
    pages: true,
    located: true,
  },
  // §4.2 folders
  {
    name: 'files_create_folder',
    title: 'Create a folder',
    description: 'Create a folder inside a folder.',
    capability: 'folders',
    effect: 'write',
    untrusted: 'names',
    arguments: [
      ROOT_ARG,
      { name: 'folder', title: 'In folder', schema: REF_SCHEMA, required: false },
      { name: 'name', title: 'Name', schema: NAME, required: true },
    ],
    result: ITEM_RESULT,
    itemMembers: ['item'],
    errors: ['already-exists', 'not-found', 'invalid-argument'],
    pages: false,
    located: true,
  },
  {
    name: 'files_move',
    title: 'Move or rename',
    description:
      "Move a file or a folder to another folder, rename it, or both. A folder moves with what it holds. The item's reference changes: use the one this answers.",
    capability: 'folders',
    effect: 'write',
    untrusted: 'names',
    arguments: [
      ROOT_ARG,
      ref('Item'),
      { name: 'toFolder', title: 'To folder', schema: REF_SCHEMA, required: false },
      { name: 'newName', title: 'New name', schema: NAME, required: false },
      IF_VERSION_OPTIONAL,
    ],
    constraints: [{ kind: 'at-least-one', arguments: ['toFolder', 'newName'], field: 'toFolder' }],
    result: ITEM_RESULT,
    itemMembers: ['item'],
    errors: [
      'invalid-argument',
      'not-found',
      'outside-location',
      'already-exists',
      'not-supported',
      'version-mismatch',
    ],
    pages: false,
    located: true,
  },
  // §4.3 trash
  {
    name: 'files_trash',
    title: 'Move to the trash',
    description: 'Move a file or a folder to the trash. It can be restored for as long as the store keeps its trash.',
    capability: 'trash',
    effect: 'delete',
    untrusted: 'names',
    arguments: [ROOT_ARG, ref('Item'), IF_VERSION_OPTIONAL],
    result: object(['item'], { item: ITEM_IN_TRASH }),
    itemMembers: ['item'],
    errors: ['not-supported', 'version-mismatch'],
    pages: false,
    located: true,
  },
  {
    name: 'files_restore',
    title: 'Restore from the trash',
    description: 'Bring an item back from the trash to the folder it left.',
    capability: 'trash',
    effect: 'write',
    untrusted: 'names',
    arguments: [ROOT_ARG, ref('Item')],
    result: ITEM_RESULT,
    itemMembers: ['item'],
    errors: ['already-exists', 'not-found'],
    pages: false,
    located: true,
  },
  {
    name: 'files_list_trash',
    title: 'List the trash',
    description: 'List the items in the trash that came from the folder you work in.',
    capability: 'trash',
    effect: 'read',
    untrusted: 'names',
    arguments: [ROOT_ARG, ...pageArguments()],
    result: object(['items'], { items: { type: 'array', items: ITEM_IN_TRASH }, nextCursor: NEXT_CURSOR_SCHEMA }),
    itemMembers: ['items'],
    errors: [],
    pages: true,
    located: true,
  },
  // §4.4 share
  {
    name: 'files_shares',
    title: 'See who a file is shared with',
    description: 'See who a file or a folder is shared with, and how.',
    capability: 'share',
    effect: 'read',
    untrusted: 'names',
    arguments: [ROOT_ARG, ref('Item')],
    result: SHARES_RESULT,
    itemMembers: [],
    errors: [],
    pages: false,
    located: true,
  },
  {
    name: 'files_share',
    title: 'Share',
    description:
      'Share a file or a folder with people, by their email addresses, or with an audience, as a reader or an editor.',
    capability: 'share',
    effect: 'write',
    externalWhen: { addresses: true, values: [{ argument: 'audience', value: 'anyone' }] },
    untrusted: 'names',
    arguments: [
      ROOT_ARG,
      ref('Item'),
      {
        name: 'role',
        title: 'Role',
        schema: { enum: ROLE_ENUM },
        required: true,
        capabilityValues: [{ value: 'manager', capability: 'team-roots' }],
      },
      {
        name: 'recipients',
        title: 'People',
        schema: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: { type: 'object', required: ['address'], properties: { address: EMAIL }, additionalProperties: false },
        },
        required: false,
        addresses: ['*/address'],
      },
      { name: 'audience', title: 'Audience', schema: { enum: ['organization', 'anyone'] }, required: false },
      { name: 'notify', title: 'Tell them', schema: { type: 'boolean' }, required: false },
      { name: 'message', title: 'Message', schema: { type: 'string', maxLength: 1000 }, required: false },
    ],
    constraints: [{ kind: 'exactly-one', arguments: ['recipients', 'audience'], field: 'recipients' }],
    result: SHARES_RESULT,
    itemMembers: [],
    errors: ['not-supported', 'invalid-argument', 'recipient-refused'],
    pages: false,
    located: true,
  },
  {
    name: 'files_unshare',
    title: 'Stop sharing',
    description: 'Stop one share of a file or a folder.',
    capability: 'share',
    effect: 'write',
    untrusted: 'names',
    arguments: [
      ROOT_ARG,
      ref('Item'),
      { name: 'share', title: 'Share', schema: { type: 'string', minLength: 1 }, required: true },
    ],
    result: SHARES_RESULT,
    itemMembers: [],
    errors: ['not-supported'],
    pages: false,
    located: true,
  },
  // §4.5 versions
  {
    name: 'files_versions',
    title: "List a file's versions",
    description:
      'List the former versions of a file, newest first. Read one by giving its version to the read of the file.',
    capability: 'versions',
    effect: 'read',
    untrusted: 'names',
    arguments: [ROOT_ARG, ref('File'), ...pageArguments()],
    result: object(['versions'], { versions: { type: 'array', items: VERSION_ENTRY }, nextCursor: NEXT_CURSOR_SCHEMA }),
    itemMembers: [],
    errors: [],
    pages: true,
    located: true,
  },
  // §4.6 export
  {
    name: 'files_export',
    title: 'Read a file in another format',
    description: 'Read a file converted to another format, one of the formats the file lists.',
    capability: 'export',
    effect: 'read',
    untrusted: 'names and content',
    arguments: [ROOT_ARG, ref('File'), { name: 'mediaType', title: 'Format', schema: MEDIA_TYPE, required: true }],
    result: object(['item', 'content'], { item: ITEM_SCHEMA, content: CONTENT_SCHEMA }),
    itemMembers: ['item'],
    errors: ['not-supported', 'too-large'],
    pages: false,
    located: true,
  },
  // §4.7 team-roots
  {
    name: 'files_create_team_root',
    title: "Create a team's folder",
    description: 'Create a folder that belongs to the organization, for a team.',
    capability: 'team-roots',
    effect: 'write',
    untrusted: 'no',
    arguments: [
      { name: 'name', title: 'Name', schema: TEAM_ROOT_NAME, required: true },
      {
        name: 'requestId',
        title: 'Request',
        schema: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' },
        required: true,
      },
    ],
    result: ROOT_RESULT,
    itemMembers: [],
    errors: ['permission-denied', 'invalid-argument'],
    pages: false,
    located: false,
  },
  {
    name: 'files_rename_root',
    title: "Rename a team's folder",
    description: "Rename a team's folder.",
    capability: 'team-roots',
    effect: 'write',
    untrusted: 'no',
    arguments: [ROOT_ARG, { name: 'name', title: 'New name', schema: TEAM_ROOT_NAME, required: true }],
    result: ROOT_RESULT,
    itemMembers: [],
    errors: ['not-supported', 'permission-denied'],
    pages: false,
    located: true,
  },
]

/** The code Files adds to the common ones (files §4.7). */
export const FILES_ERRORS: ErrorDefinition[] = [
  {
    code: 'recipient-refused',
    when: 'an address the store cannot make a member of a team root',
    members: ['reason'],
    optionalMembers: [],
  },
]

/** The reasons of `recipient-refused` (files §4.7). */
export const RECIPIENT_REFUSED_REASONS = ['no-account', 'not-allowed', 'too-many'] as const

export const FILES_PROFILE: ProfileDefinition = {
  id: FILES_ID,
  version: FILES_VERSION,
  prefix: FILES_PREFIX,
  title: 'Files',
  location: {
    argument: 'root',
    labels: { one: 'Folder', list: 'Folders', any: 'Any folder you can reach' },
    listTool: 'files_roots',
  },
  capabilities: [
    { name: 'search', tools: ['files_search'], adds: '', requires: [] },
    { name: 'folders', tools: ['files_create_folder', 'files_move'], adds: '', requires: [] },
    {
      name: 'trash',
      tools: ['files_trash', 'files_restore', 'files_list_trash'],
      adds: '`trashedAt` on an item of the trash',
      requires: [],
    },
    {
      name: 'share',
      tools: ['files_shares', 'files_share', 'files_unshare'],
      adds: '`shared` on an item',
      requires: [],
    },
    { name: 'versions', tools: ['files_versions'], adds: '`version` as an argument of `files_read`', requires: [] },
    { name: 'export', tools: ['files_export'], adds: '`exportTypes` on an item', requires: [] },
    {
      name: 'team-roots',
      tools: ['files_create_team_root', 'files_rename_root'],
      adds: '`team` on a root; members of a team root through the tools of `share`',
      requires: ['share'],
    },
  ],
  tools: FILES_TOOLS,
  errors: FILES_ERRORS,
  declarationMembers: {
    search: { type: 'object', properties: { content: { type: 'boolean' } } },
    share: {
      type: 'object',
      properties: {
        audiences: { type: 'array', items: { enum: ['organization', 'anyone'] }, uniqueItems: true },
        notify: { type: 'boolean' },
      },
    },
    'team-roots': { type: 'object', properties: { manager: { type: 'boolean' } } },
  },
}

/** The schema of a Files error's structured content: the common codes and `recipient-refused` with its reason. */
export const FILES_ERROR_SCHEMA: JsonSchema = errorContentSchema([...COMMON_ERRORS, ...FILES_ERRORS])
