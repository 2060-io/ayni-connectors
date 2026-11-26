# @ayni.org/ayni-conformance

The conformance tests of the Ayni Feature Profiles as a kit: the *Verify* lines of FEAT-CORE (common §15),
FEAT-FILES (files §7) and FEAT-CAL (calendar §7), run against **any** provider's MCP endpoint, each reported by its
requirement id. A server conforms to a version of a profile when it passes every test of the core and of each
capability it declares (common §13). This is what a provider's author runs against their own server.

## What a run needs (common §13)

- two accounts of the service, A and B, as the headers of their requests, and their addresses at the service;
- for Files and for Calendar: an **empty location that A may write to** (`first`) and a **second location that A may
  read**, outside the first (`second`); for Calendar, `first` is A's main calendar, where invitations to A arrive;
- for `team-roots`, a third account M that may create a team root;
- optionally, items a profile cannot make, made at the service by other means (`fixtures`), and hooks into the
  service (`hooks`): without them the tests that need them are reported `skip`, never `pass`.

A run leaves the first location as it found it where the server has `trash` (what it made goes to the trash) and
cancels every event it made. Files 1.0 removes nothing for good and cannot delete a team root: those stay.

## From a test runner

```ts
import { registerConformance } from '@ayni.org/ayni-conformance'
import { beforeAll, describe, it } from 'vitest'

registerConformance(
  { describe, it, beforeAll },
  {
    profiles: ['files', 'calendar'],
    options: async () => ({
      url: 'http://127.0.0.1:8000/mcp',
      accounts: {
        A: { headers: { authorization: `Bearer ${process.env.TOKEN_A}` }, address: 'a@example.org' },
        B: { headers: { authorization: `Bearer ${process.env.TOKEN_B}` }, address: 'b@example.org' },
      },
      files: { first: { ref: '…', path: '/Conformance' }, second: { ref: '…' } },
      calendar: { first: { ref: '…' }, second: { ref: '…' } },
    }),
  }
)
```

One test per requirement id; a requirement the run could not test is skipped with its reason (`strict: true` makes it
fail instead). `runConformance(options)` answers the report itself.

## From the command line

```bash
npx @ayni.org/ayni-conformance --config run.json          # or run.mjs, whose default export may hold hooks
npx @ayni.org/ayni-conformance --config run.json --json   # the report as JSON
```

One line per requirement (`PASS`, `FAIL`, `SKIP`, `MANUAL`, `N/A`), exit code 1 when one fails.

## Options

| Member | What it is |
|--------|-----------|
| `url` | the MCP endpoint (Streamable HTTP) |
| `accounts.A`, `.B`, `.M` | `{ headers, address?, secrets? }`: every header value and secret is looked for in every answer and log |
| `files` | `{ expect?, first: { ref, path? }, second: { ref, path? }, fixtures? }`: `expect` the capabilities the server must declare, exactly; `path` the location's path in A's tree, for `files_roots` with a query |
| `files.fixtures` | `link` (a shortcut in the first location to a file of the second), `native` (a document of the store's own), `nativeNotConvertible`, `duplicates` (a folder holding two `a.txt`) |
| `calendar` | `{ expect?, first, second, bCalendar?, fixtures? }` |
| `calendar.fixtures` | `weeklySeries` (`{ ref, from, to }`, four weeks), `floating` (`{ ref, start }`), `invitation` (B's event in A's calendar, used without `attendees`), `conference` (an event with a `CONFERENCE`) |
| `organization` | `noAccount` (an address of no account), `outside` (an address outside the test organization) |
| `hooks` | `stopService()`/`startService()`, `askBeforeWrite(on)`, `messages(address)`, `logs()` |
| `era` | `modern` (2026-07-28, `server/discover`), `legacy` (2025-era `initialize`), `auto` (probe, the default) |
| `fetch`, `onResult` | a fetch of the runner's own; a callback per requirement |

## What the kit tests, and what it cannot

Every requirement id of the three documents has a test (`tests/coverage.test.ts` pins the list to the spec). Most
run whole against any server; the rules that hold for every answer (FEAT-CORE-006, 007, 013, 017, 019,
FEAT-FILES-002, 015, FEAT-CAL-002, 017) are checked on every answer of the run. Some need more than MCP:

| Requirement | What the kit does | What it needs, or cannot do |
|---|---|---|
| FEAT-CORE-007 | an unknown reference answers `not-found`; errors' shape, codes and messages on every answer | the hooks `stopService`/`startService` for `unavailable` |
| FEAT-CORE-008 | references made by the run read again at its end | not an hour later |
| FEAT-CORE-011 | fifty pairs of concurrent writes with one version | not applicable when `atomicWrites` is false |
| FEAT-CORE-014, FEAT-FILES-031 | a move to a folder of the second location answers `not-found`; a shortcut is a `link` and is not read | the fixture `link`; no argument of Files 1.0 gives a destination by path, so `outside-location` does not arise |
| FEAT-CORE-020 | B reads nothing of an item only A may read, right after A read it | a location both reach with rights per item is not set up |
| FEAT-CORE-021 | looks for every credential in what the provider logged and stored | the hook `logs`, else **manual**; that the service is the only host that receives the credentials needs a network stub |
| FEAT-CORE-022 | a create of `writeBytes + 1` answers `too-large`, creating nothing; a read of an image of `readBytes + 1` | the read only when `writeBytes > readBytes` |
| FEAT-CORE-024 | no input request in a run whose service asks nothing | the hook `askBeforeWrite` for the decline and the accept, with `era` modern |
| FEAT-CORE-026 | the least of each limit; `limit` 0 and 101 | a page cut at `limits.page` only when it is below 50 |
| FEAT-FILES-003 | `/Projects/Al` answers Alpha and not Beta | `folders` and the first location's `path` |
| FEAT-FILES-005, 015, 016, 061, 063 | the document of the store's own | the fixtures `native`, `nativeNotConvertible`; an export larger than `readBytes` needs a stub service |
| FEAT-FILES-012, 017 | | the fixtures `link`, `duplicates` |
| FEAT-FILES-020 | a word of a file of the second location; three common operator syntaxes | a file in the second location |
| FEAT-FILES-050 to 055 | shares to B, read and refused as B | B's address; 052 needs `folders`; 053's messages the hook `messages` |
| FEAT-FILES-070 to 074 | team roots with M, members A and B | M and the addresses; `not-allowed` needs `organization.outside` and a store that refuses it |
| FEAT-CAL-005, 011, 013 | a weekly series | `recurrence`, or the fixture `weeklySeries` |
| FEAT-CAL-009, 017 | B's invitation in A's calendar | `attendees` and A's address, or the fixture `invitation` |
| FEAT-CAL-012 | the query on the titles of A's calendars; one `primary` | a calendar A may only read as `second` for the refusal of a creation |
| FEAT-CAL-015, 061 | | the fixtures `floating`, `conference` |
| FEAT-CAL-040, 042, 050, 051 | the members and refusals | what B receives: the hook `messages` |

The connector-specific requirements of providers.md (FEAT-DAV, FEAT-WEBDAV, FEAT-CALDAV, FEAT-NC) are the Nextcloud
connector's own tests, against stub servers, not this kit's.
