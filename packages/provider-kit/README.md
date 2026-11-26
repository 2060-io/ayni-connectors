# @ayni.org/ayni-provider-kit

What every provider of the Ayni Feature Profiles shares: an MCP server over Streamable HTTP that declares the
profiles a connector implements, lists their tools from the contracts of
[`@ayni.org/ayni-feature-profiles`](../feature-profiles), checks every call and every result against them, maps
errors to the profiles' codes, pages, and reads the account from each request. A connector supplies one handler per
tool and what it declares; the kit does the rest.

## MCP

The official TypeScript SDK at the revision the spec names, 2026-07-28: `@modelcontextprotocol/server` 2.x (v1.x of
`@modelcontextprotocol/sdk` stops at 2025-11-25). The server answers both eras from one definition:
`server/discover` and per-request envelopes for clients of 2026-07-28, and the stateless `initialize` for clients of
earlier revisions, such as the Ayni Agent's current client. The profile is declared in `capabilities.extensions` of
both (common §3).

One server is built per HTTP request, for the account that request carries (common §11): nothing read with one
account is kept for another.

## Usage

```ts
import { bearerAccount, createProviderHandler, errors, serve, type FilesProvider } from '@ayni.org/ayni-provider-kit'

const files = (account): FilesProvider => ({
  declaration: { capabilities: ['folders'], atomicWrites: false },
  roots: async (args, ctx) => ({ roots: [/* … */] }),      // ctx.page: { limit, cursor } of the provider's own
  list: async (args, ctx) => ({ folder, items, nextCursor }), // nextCursor: the provider's own, sealed by the kit
  get: async (args, ctx) => ({ item }),
  read: async (args, ctx) => ({ item, content }),
  create: async (args, ctx) => ({ item }),
  replace: async (args, ctx) => {
    if (stale) throw errors.versionMismatch(current)
    return { item }
  },
  createFolder: async (args, ctx) => ({ item }),
  move: async (args, ctx) => ({ item }),
})

const handler = createProviderHandler({
  name: 'my-connector',
  version: '1.0.0',
  readAccount: bearerAccount(),          // or headerAccount([...names], [...secretNames])
  files: (account) => (account ? files(account) : undefined),
  cursorSecret: process.env.CURSOR_SECRET, // the same on every replica
})
await serve(handler, { port: 8000, host: '0.0.0.0' })
```

## Public API

| Export | What it does |
|--------|--------------|
| `createProviderHandler(options)` | the web-standard handler (`fetch(request)`, `close()`): `name`, `version`, `readAccount`, `files(account, request)`, `calendar(account, request)` (each answers the provider of that account, or `undefined` to declare nothing to it), `cursorSecret`, `cursorLifetimeSeconds`, `logger`, `validateResults` (true), `maxRequestBodyBytes` (16 MiB), `instructions` |
| `FilesProvider<D>` | `declaration` (capabilities, limits, `atomicWrites`, `search`, `share`, `team-roots`) and the handlers `roots`, `list`, `get`, `read`, `create`, `replace`; `search`; `createFolder`, `move`; `trash`, `restore`, `listTrash`; `shares`, `share`, `unshare`; `versions`; `export`; `createTeamRoot`, `renameRoot` |
| `CalendarProvider<D>` | `declaration` (capabilities, limits, `atomicWrites`, `meeting`) and `calendars`, `listEvents`, `getEvent`, `createEvent`, `updateEvent`, `cancelEvent`; `freeBusy`; `respond` |
| `CallContext`, `PagedContext` | what a handler is given: `account`, `declaration`, `limits`, `signal`, `logger`, `ask(question)` (a question of the service, passed on as an input request, FEAT-CORE-024), and for a tool that lists `page: { limit, cursor }` |
| `ProfileError`, `errors.*` | the errors of the tables: `invalidArgument(field)`, `notSupported`, `notFound`, `outsideLocation`, `alreadyExists`, `versionMismatch(current)`, `tooLarge(limit, size)`, `permissionDenied`, `accountRefused`, `rateLimited(seconds)`, `unavailable`, `badCursor`, `recipientRefused(reason)` |
| `Account`, `AccountReader`, `bearerAccount()`, `headerAccount(names, secret)`, `accountKey(...)` | the account of a request: a stable key (a digest), its secrets (kept out of every answer and log) and what the provider needs |
| `CursorCodec`, `bindingOf`, `pageByKey`, `pageByOffset` | cursors sealed with AES-256-GCM, bound to the tool, the arguments and the account; pages of a list held whole |
| `serve(handler, options)`, `routes(handler, options)` | Node's HTTP server around a handler: `/mcp`, `/healthz`, and for an OAuth resource server its Protected Resource Metadata and the `401` that names it |
| `truncateUtf8`, `declarationOf`, `handlerName` | helpers |

## What the kit does on each call

1. An unknown tool is a protocol error. A call without an account answers `account-refused`.
2. The checks of the contract (`checkCall`): an argument the profile does not know is `invalid-argument`; an
   argument or a value of a capability not declared, or of a part of the declaration the server lacks, is
   `not-supported`; the schema, the rules between arguments, times, time zones and repetitions.
3. A content larger than `writeBytes` answers `too-large` before the handler runs.
4. The handler runs with its page (`limit` bounded by `limits.page`, its own cursor opened from the client's).
5. A text read longer than `maxBytes` (or `readBytes`) is cut at a character with `truncated: true`; bytes over
   `readBytes`, and an export over it, answer `too-large`.
6. The result is checked against the profile, every item against the location of the call, a page against its size;
   a handler that answers otherwise is logged and the call answers `unavailable`.
7. The result goes out as `structuredContent` and as JSON in one `text` block; an error likewise, with `isError`,
   its message scrubbed of the account's secrets; anything a handler throws that is not a `ProfileError` is
   `unavailable`, with nothing of it in the answer.
