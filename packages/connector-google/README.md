# @ayni.org/ayni-connector-google (private)

The Google connector of Ayni: an MCP server that speaks **Files 1.0** over the Google Drive API v3 and **Calendar
1.0** over the Google Calendar API v3, at one endpoint, with the person's own Google access token of each request
(the profiles' `providers.md` §6, the Ayni Agent's D118 and architecture §10.10). It is built on the
[provider kit](../provider-kit) and shipped as the image `ayni-connector-google`.

It holds **no account, no secret, no client id and no token**: each call carries the person's access token in
`Authorization: Bearer`, which the connector sends to Google's generally available interfaces for that call and keeps
no longer, in no log and no store (TOOL-OAUTH-018). It sends nothing else of an account, and reads nothing else of a
request. One image, no state.

## What it declares

Both profiles are declared to every request, in `server/discover` and in `initialize` alike:

| | `org.ayni/files` (Google Drive) | `org.ayni/calendar` (Google Calendar) |
|---|---|---|
| Capabilities | `search`, `folders`, `trash`, `share`, `versions`, `export`, `team-roots` | `free-busy`, `recurrence`, `attendees`, `respond`, `meeting` |
| Members | `search: { content: true }`, `share: { audiences: ["organization", "anyone"], notify: true }`, `"team-roots": { manager: true }` | `meeting: { label: "Google Meet" }` |
| `atomicWrites` | `false`: Drive takes no precondition on an upload, so the version is compared, then the file written | `true`: the `etag` is sent as `If-Match`, which Google compares in one step |
| `limits` | `page` 100, `readBytes` 10 MiB, `writeBytes` 5,000,000 (Drive's limit of one multipart upload) | the defaults |

## How Google reads as the profiles

| | Drive | Calendar |
|---|---|---|
| A location | a folder: My Drive, a shared drive, a folder shared with the account, or any folder below one; `portable: true` | a calendar of the account's calendar list (`minAccessRole=reader`); `portable: true` |
| A reference | the file id; a shared drive's id is that of its top folder | the calendar id; the event id, an occurrence having one of its own |
| Inside the location | the location is found among the item's parents, one at a time; anything else answers `not-found` | the event is in that calendar for Google |
| A version | `headRevisionId`, or `version` for a document of Google's own | `etag` |
| Content | a text file as text (UTF-8, byte order mark removed); a Google document as its export, `text/markdown` where Drive gives one, else `text/plain` (`native: true`, with its `exportTypes`); any other file as bytes | |
| Others | a shortcut is a `link`, never followed; `shared` when someone reaches the item who does not reach the location (`permissionIds`); a share is `inherited` when every `permissionDetails` of it is | times in the zone the event was set in, else in UTC; `mine` for the organizer's copy; `uid` is `iCalUID`; rooms are not attendees |
| Team roots | shared drives: `drives.create` with the `requestId`; members are the drive's permissions (`reader`, `fileOrganizer` for `editor`, `organizer` for `manager`) | |
| Messages | `sendNotificationEmail`, `emailMessage` | `sendUpdates`: `all`, or `none` for `notify: false` |

## Scopes each tool needs at Google

Which tools a person is given, and so which scopes the agent asks for, is the agent's to say: its table is the
architecture's §10.10 (and §10.13 for the tools of a managed folder). What the connector needs at Google is the
narrowest scope that covers every method a tool calls ([`src/challenge.ts`](src/challenge.ts), `TOOL_SCOPES`), each
under `https://www.googleapis.com/auth/`:

| Scope | Tools |
|---|---|
| `drive.readonly` | `files_roots`, `files_list`, `files_get`, `files_read`, `files_search`, `files_list_trash`, `files_shares`, `files_versions`, `files_export` |
| `drive` | `files_create`, `files_replace`, `files_create_folder`, `files_move`, `files_trash`, `files_restore`, `files_share`, `files_unshare`, `files_create_team_root`, `files_rename_root` |
| `calendar.calendarlist.readonly` | `calendar_calendars` |
| `calendar.events.readonly` | `calendar_list_events`, `calendar_get_event` |
| `calendar.events.freebusy` | `calendar_free_busy` |
| `calendar.events` | `calendar_create_event`, `calendar_update_event`, `calendar_cancel_event`, `calendar_respond` |

A tool never calls a method of another scope: creating an event does not read the calendar list, the free and busy
times are asked of `freeBusy.query` alone.

## What it answers at the level of HTTP

| Request | Answer |
|---|---|
| without a bearer token | `401` with `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"` |
| `GET /.well-known/oauth-protected-resource/mcp` (and without `/mcp`) | `{ "resource": RESOURCE_URL, "authorization_servers": ["https://accounts.google.com"], "bearer_methods_supported": ["header"] }` |
| a call whose token Google refuses (expired, revoked) | `401` with `Bearer error="invalid_token"` and the metadata, so that the client refreshes the token or asks to reconnect |
| a call whose token lacks the tool's scope | `403` with `Bearer error="insufficient_scope", scope="…"` (the tool's scopes above) and the metadata, so that the client asks for more access |
| `GET /healthz` | `200 ok` |
| anything else | the tools' results and errors of the profiles, from the provider kit |

The kit answers a refusal as a tool result; the connector marks those two (`x_tokenRefused`, `x_insufficientScope`
and `x_scope`, members the profiles let a server add) and its own HTTP layer answers them as above. The kit is not
changed.

## Configuration

| Variable | | Meaning |
|---|---|---|
| `RESOURCE_URL` | required | the address of `/mcp` as the agent reaches it, `http://connector-google.internal:8000/mcp`: the `resource` of the metadata, which the agent checks against the source's `url` |
| `PORT` | `8000` | |
| `HOST` | `0.0.0.0` | |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`; JSON lines on standard output, never a token, an address or a content |
| `ALLOWED_HOSTS` | all | the `Host` values answered, comma-separated; any other gets `403` |
| `CURSOR_SECRET` | random per process | the key of the cursors, the same on every replica: needed only to run several replicas behind one address. It is no credential of any service |

No variable changes where a token goes: the connector reaches `https://www.googleapis.com/drive/v3`,
`https://www.googleapis.com/upload/drive/v3` and `https://www.googleapis.com/calendar/v3`, and no other host. A test
gives the base addresses of its stub with the option `testEndpoints` of `createGoogleConnector`, which the command
line never sets and which takes a loopback address only (`127.0.0.1`, `::1`, `localhost`); any other address is
refused when the connector is made. No redirection is followed.

The connector is reached by the agent alone: run it inside the deployment, with no route from outside (common §11).

## Run

```bash
pnpm build
RESOURCE_URL=http://127.0.0.1:8000/mcp pnpm --filter @ayni.org/ayni-connector-google start

# the image, from the repository's root
docker build -f packages/connector-google/Dockerfile -t ayni-connector-google .
docker run --rm -p 8000:8000 -e RESOURCE_URL=http://connector-google.internal:8000/mcp ayni-connector-google
```

The image runs as the user `node`, listens on port 8000, and checks its health at `/healthz`.

## Tests

No test reaches Google or any other service, and none registers a client anywhere. [`tests/stub`](tests/stub) is a
stub of the parts of the Drive API v3 and the Calendar API v3 the connector uses, written after Google's public
references and served on `127.0.0.1`: tokens with their scopes (each method takes the scopes its reference lists),
Google's error bodies, `fields`, page tokens, shared drives, permissions and their inheritance, revisions, exports,
recurring events and their instances, invitations, free and busy times.

- [`conformance.test.ts`](tests/conformance.test.ts): the conformance kit against the connector over the stub,
  Files and Calendar over MCP 2026-07-28 and both over the 2025-era `initialize`: zero failures.
- [`drive.test.ts`](tests/drive.test.ts), [`calendar.test.ts`](tests/calendar.test.ts): each tool with the one scope
  of the table above, Google's limits and refusals, documents of Google's own, shared drives, what Google sends.
- [`server.test.ts`](tests/server.test.ts): the metadata, the `401`, the HTTP answers of a refused token and of a
  missing scope, a token that reaches the stub alone and no log, no redirection followed.
- [`mapping.test.ts`](tests/mapping.test.ts): the mappings on their own.

A passing stub is no proof of Google's behaviour: the points the stub assumes are listed below, to check on a real
account.

## The conformance kit against a real Google account, by hand

For an operator, against a Google Workspace organization kept for tests (never one with real people's data):

1. **Accounts.** Three accounts of the organization, A, B and M (M may create shared drives), and one address
   outside it. Their access tokens come from the organization's own OAuth client (TOOL-OAUTH-017), with the scopes
   of the table above: through the agent's own sign-in, or Google's OAuth 2.0 Playground set to use that client. A
   token lasts an hour: run within it.
2. **Locations and fixtures, made in Drive and Calendar's own interfaces.** In A's My Drive, an empty folder
   `Conformance` (the first location, path `/Conformance`), holding a shortcut to a file of the second location, a
   Google Doc with some text, a Google Sheet, and a folder holding two files named `a.txt`. In B's My Drive, a folder
   shared with A as a viewer, holding a file whose name has a word of three letters (the second location). In
   Calendar, A's own calendar is the first; a calendar of B shared with A to read only is the second; one event
   with Google Meet in A's calendar.
3. **The connector**: `RESOURCE_URL=http://127.0.0.1:8000/mcp node packages/connector-google/build/cli.js`.
4. **The run**, `run.json` given to `npx @ayni.org/ayni-conformance --config run.json` (or a `run.mjs` with hooks):

   ```json
   {
     "url": "http://127.0.0.1:8000/mcp",
     "accounts": {
       "A": { "headers": { "authorization": "Bearer <A's token>" }, "address": "a@<test domain>" },
       "B": { "headers": { "authorization": "Bearer <B's token>" }, "address": "b@<test domain>" },
       "M": { "headers": { "authorization": "Bearer <M's token>" }, "address": "m@<test domain>" }
     },
     "files": {
       "first": { "ref": "<id of Conformance>", "path": "/Conformance" },
       "second": { "ref": "<id of B's folder>" },
       "fixtures": { "link": "<shortcut id>", "native": "<Doc id>", "nativeNotConvertible": "<Sheet id>", "duplicates": "<folder id>" }
     },
     "calendar": {
       "first": { "ref": "<A's address>" },
       "second": { "ref": "<id of B's calendar>" },
       "bCalendar": "<B's address>",
       "fixtures": { "conference": "<event id>" }
     },
     "organization": { "noAccount": "nobody@<test domain>", "outside": "<an address outside>" }
   }
   ```

   Ids are those of Drive's and Calendar's addresses (`/folders/<id>`, the calendar's settings). The messages A, B
   and M receive are read by hand: without the hook `messages`, the kit skips what needs them.
5. **After.** The run leaves its files in A's trash and cancels its events; it cannot delete the shared drives it
   made (Files 1.0 deletes no team root): delete them by hand.

## What the stub assumes of Google, to confirm on a real account

What Google's references do not say, or say otherwise in two places, and which the connector relies on:

| Assumption | Where it matters |
|---|---|
| `files.update` with a multipart upload of `text/markdown` (or `text/plain`) into an existing Google Doc converts it and replaces its content; into a Sheet or a Slides file it is not attempted | `files_replace` of a native document |
| `drives.create` sent again with the same `requestId` and body answers the drive it made (Drive's guide); its reference says `409` instead, which the connector answers `already-exists` | `files_create_team_root`, FEAT-FILES-070 |
| The reasons of a shared drive's refusals: `cannotShareTeamDriveWithNonGoogleAccounts` (seen in a client library's issue, not in Drive's guide) for no Google account, `teamDriveDomainUsersOnlyRestriction` or `shareOutNotPermitted` for an address the organization does not let in | `recipient-refused`, FEAT-FILES-072 |
| `permissionIds` lists everyone who reaches a file, inherited access and a shared drive's members included | `shared`, FEAT-FILES-054 |
| `permissionDetails[].inherited` is given for files of My Drive as for shared drives (the current reference says so) | `inherited`, FEAT-FILES-052 |
| `permissions.create` for someone who already has a permission of the file changes its role | `files_share` of an item |
| `about.get` takes `drive.readonly` (the references of `permissions.list`, `revisions.list` and `files.export` say so for those) | the audience `organization` of `files_share`, which needs `drive` anyway |
| `permissions.list` of a file lists the permissions it inherits from the folders above and from a shared drive's members (its reference does not say) | `inherited`, FEAT-FILES-052 |
| `name contains` matches the start of a word of the name, and `fullText contains` whole words of the name, the description and the text; how Drive splits words is not documented. The connector keeps only items whose name holds every word (search by name) and reads the text for a snippet | `files_search`, FEAT-FILES-020, 021 |
| A backslash in a query string is escaped as `\\` (only `\'` is documented) | names with a backslash |
| The `user` corpus holds every item of a folder shared with the account | `files_list` of a shared folder |
| `files.get` of a shared drive's id answers its top folder | team roots as locations |
| `alt=media` and `files.export` answer from `www.googleapis.com` with no redirection (the connector follows none) | reads, exports |
| An export larger than Drive's 10 MB (taken as 10 MiB) answers `403 exportSizeLimitExceeded` | `files_export`, FEAT-FILES-063 |
| `revisions.list` lists every revision of a file replaced sixty times (its reference warns that a list may be incomplete) | FEAT-FILES-060, 062 |
| A missing scope is answered `403` with `ErrorInfo` `ACCESS_TOKEN_SCOPE_INSUFFICIENT`, or `insufficientPermissions`, or `WWW-Authenticate` `insufficient_scope` | the `403` the connector answers |
| An event created with a `dateTime` and no `timeZone` reads back with no `timeZone` | FEAT-CAL-015 |
| `events.patch` merges `start` and `end` with the members given, and `null` clears one (`date` or `dateTime`, `timeZone`, `conferenceData`) | changes of times, removing a meeting |
| `events.patch` and `events.delete` take an instance's id (Google's guide shows `PUT`), and a change of the series reaches the instances not changed one by one | `scope`, FEAT-CAL-031, 033 |
| An invitation reaches an invited account's primary calendar even with `sendUpdates=none` | FEAT-CAL-009, 017 |
| An attendee's `events.patch` of their own copy, with the same attendees and only their `responseStatus` and `comment` changed, sets their answer; `sendUpdates=all` tells the organizer | `calendar_respond`, FEAT-CAL-050, 051 |
| `conferenceData.createRequest` for `hangoutsMeet` succeeds at once, or within a few seconds of `pending` | FEAT-CAL-060 |
| `freeBusy.query` answers an address of no account with `errors: [{ reason: "notFound" }]`, and a person of the organization's busy times | FEAT-CAL-020 |

## What it does not do, and why

- **A cancellation's `comment`** (capability `attendees`) answers `not-supported`, `field: "comment"`: Google's
  `events.delete` sends no message of the organizer, and dropping it would be ignoring an argument.
- **The time a My Drive item was trashed**: Drive gives `trashedTime` for items of shared drives only. `files_trash`
  answers the time of its own call; `files_list_trash` answers the item's last change for an item of My Drive.
- **Former versions of a Google document**: Drive gives them only through `exportLinks`, on another host than its
  interface; `files_versions` and `files_read` with a former `version` answer `not-supported` for one.
- **A Google Sheet read as text**: Drive exports it to neither Markdown nor plain text; `files_read` answers
  `not-supported`, and `files_export` gives it as `text/csv`.
- **Files over 5 MB**: a resumable upload is not implemented; `writeBytes` is 5,000,000.
- **Floating times**: Google answers every time with an offset; there is none to read in the calendar's zone.
- **A declaration per account**: `team-roots` and the audience `organization` are declared to every account; for a
  personal account, which has neither shared drives nor an organization, Google refuses the call
  (`permission-denied` for a shared drive). Declaring per account would ask Google on every request.
