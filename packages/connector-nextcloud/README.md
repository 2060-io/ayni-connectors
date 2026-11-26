# @ayni.org/ayni-connector-nextcloud (private)

The Nextcloud connector of Ayni: an MCP server that speaks **Files 1.0** over WebDAV (RFC 4918) and **Calendar 1.0**
over CalDAV (RFC 4791), with a Nextcloud's own interfaces for what the protocols lack (search, the trash bin,
versions, the OCS Share API, Team folders), and any other WebDAV or CalDAV server, such as Stalwart, with fewer
operations (the profiles' `providers.md` §1 to §5, normative: FEAT-DAV, FEAT-WEBDAV, FEAT-CALDAV, FEAT-NC; the Ayni
Agent's D124 and D145 to D150). It is built on the [provider kit](../provider-kit) and shipped as the image
`ayni-connector-nextcloud`.

It holds **no account, no secret and no state**: each request carries the account in its `Ayni-*` headers, which the
connector uses for that request and keeps no longer, in no log and no store (FEAT-DAV-004, FEAT-CORE-021). The
credentials go, as HTTP Basic over TLS with the server's certificate checked, to the hosts of the request's own
addresses and to no other (FEAT-DAV-002). One image, no state.

## The headers it takes

| Header | Value | For |
|---|---|---|
| `Ayni-Nextcloud` | the `https` address of a Nextcloud (`https://cloud.example.org`, or with a path, `https://example.org/cloud`) | a Nextcloud: its files at `/remote.php/dav/files/{user}/`, its calendars from `/remote.php/dav/`, its OCS interfaces |
| `Ayni-Dav-Files` | the `https` address of the WebDAV collection that is the account's own folder | Files, on any other server |
| `Ayni-Dav-Calendars` | the `https` address of the CalDAV server (its root will do), or of the account's calendar home | Calendar, on any other server |
| `Ayni-Dav-Username` | the account's user name (a Nextcloud also takes the account's email) | all |
| `Ayni-Dav-Password` | its password; at a Nextcloud, a person's app password, and the managing account's login password (below) | all |

Files is declared to a request that carries `Ayni-Nextcloud` or `Ayni-Dav-Files`, Calendar to one that carries
`Ayni-Nextcloud` or `Ayni-Dav-Calendars` (FEAT-DAV-001); a request with both `Ayni-Nextcloud` and an `Ayni-Dav-*`
address is refused as ambiguous. A call without the user name or the password answers `account-refused`; a request
that cannot reach its server is declared the core alone, each call answering why (`account-refused`,
`invalid-argument` naming the header, `unavailable`). The password is the one secret of the account: it is scrubbed
from every message; the addresses and the user name are no secret but are never logged either.

## Where the credentials may go (FEAT-DAV-002, 003)

- An address is `https`, with a host, and no user name, password, query or fragment in it; anything else is refused
  with `invalid-argument` and `field` the header's name, before anything is sent.
- Each host of the request is resolved **once per request**; every address it resolves to must be a public unicast
  address (no loopback, private, link-local, shared, documentation, benchmarking, multicast or reserved range, and no
  IPv6 form that carries one), unless the operator lists the host in `DAV_HOSTS`. The connection then goes to the
  address that was checked (no second resolution can point it elsewhere).
- An operator who runs one Nextcloud sets `DAV_HOSTS_ONLY=true`: only the listed hosts are reached at all.
- The server's certificate is checked against the runtime's authorities (and `NODE_EXTRA_CA_CERTS`); nothing is
  pooled between requests; **no redirection is followed**, but one: CalDAV's `/.well-known/caldav` (RFC 6764), on the
  same host only. Every address built from a server's answer (a calendar home, an outbox) must be on the origin of
  the request's address, or the call answers `unavailable`.

## What it declares

| | Nextcloud | Any other WebDAV or CalDAV server |
|---|---|---|
| **Files** | `search` (names, `content: false`), `folders`, `trash` (where the trash bin is on), `share` (where sharing is on: `audiences` `["anyone"]` where public links are on, else `[]`; `notify: true`), `versions` (where versions are on), `team-roots` with `manager: false` (to an account that may set up team folders and make groups only); `atomicWrites: true`; roots `portable: true` | `folders`, and `search` (`content: false`) where `OPTIONS` answers `DASL: <DAV:basicsearch>`; `atomicWrites` true when the server gives entity tags, else false; roots `portable: false` |
| **Calendar** | `free-busy`, `recurrence`, and `attendees` and `respond` where the server announces `calendar-auto-schedule`; `atomicWrites: false` (below); no `meeting`; calendars `portable: false` | the same |

A Nextcloud's parts are read on each request from its OCS capabilities (`files.undelete`, `files.versioning`,
`files_sharing.api_enabled`, `files_sharing.public.enabled`, `files_sharing.sharebymail.enabled`, `groupfolders`).
`team-roots` is declared when two requests that change nothing both succeed: the Team folders app's
`GET /index.php/apps/groupfolders/folders/count` (its administrators and the accounts it was delegated to) and
`GET /ocs/v2.php/cloud/groups/admin/subadmins` (the administrators and the accounts delegated the users' settings,
who may make groups). What a server declares may thus change while it is down: such a request is declared the core.

## How the servers read as the profiles

| | Nextcloud | Plain WebDAV / CalDAV |
|---|---|---|
| A file's or a folder's reference | its file id (`oc:fileid`), found in the account's own tree by a `SEARCH` under the root's folder (FEAT-NC-002) | its path under the account's folder, `/Reports/Q3.md`, each part decoded; `.`, `..`, an empty part or a control character refused (FEAT-WEBDAV-002) |
| A root | the file id of a folder: the account's own (`All files`), a share mounted at the top of its tree, a team folder (`team: true`), or any folder by its path in the account's tree | `/`, or any folder by its path |
| A version | the entity tag | the entity tag; for a server that gives none, the last change and the length (`m:…`) |
| Content | text for `text/*`, JSON and XML types (UTF-8, byte order mark removed), bytes otherwise; the type is the server's | the same |
| `webUrl` | `{server}/index.php/f/{file id}` | none |
| `shared` | the item, or a folder between the root and it, carries `oc:share-types` | (no `share`) |
| A calendar's and an event's reference | the path of the calendar collection; the event's resource, followed for one occurrence by `#` and its original start in UTC (`…/a1b2.ics#20261123T090000Z`) | the same |
| Occurrences | worked out by the connector from the whole object: any `RRULE` of RFC 5545, `RDATE`, `EXDATE`, overriding components (FEAT-CALDAV-003) | the same |
| A change | the object read, changed where asked, everything else kept, `SEQUENCE` raised for a time, the place or the rule, written with `If-Match` (FEAT-CALDAV-004) | the same |
| A creation | a new `UID` and `DTSTAMP`, the `VTIMEZONE` of the zone named (none for `calendar-no-timezone`), `If-None-Match: *` (FEAT-CALDAV-005) | the same |
| `notify: false` | `SCHEDULE-AGENT=CLIENT` on the attendees the server has not invited yet; `Schedule-Reply: F` on an answer (RFC 6638) | the same, with scheduling |
| `mine`, `self` | no `ORGANIZER`, or one of the principal's `calendar-user-address-set`; the same for an attendee's line | the same |

**Shares (FEAT-NC-006).** An address that is a person of the server (the sharees interface's exact match by email)
is shared with that person (`shareType` 0); any other address by email (4), where the server allows it, else
`not-supported` (`field: "recipients"`); `audience: "anyone"` is a public link (3). `reader` is the permission 1,
`editor` 3 for a file and 15 for a folder, never 16. Sharing again with a person changes the role of their share.
`notify` is `sendMail`, `message` the share's `note`, which Nextcloud's mail carries. `files_shares` lists the item's
own shares and those of the root's folder and of the folders between it and the item (`inherited: true`, from the
inherited-shares endpoint), none of a folder above the root; group, federated and team shares, which have no address,
are not listed. Nextcloud adds the permission 16 to a public link of its own accord (a link of 1 reads 17).

**Team folders (§5.1, FEAT-NC-008 to 011).** `files_create_team_root { name, requestId }` makes the groups
`ayni-{requestId}-editors` and `ayni-{requestId}-readers` (a digest of the request id when the name would pass
Nextcloud's 64 characters), a team folder with the name as its mount point, gives it to the editors' group with 15
and the readers' group with 1, and puts the managing account in the readers' group: the Team folders app gives no
file id of a folder, and a member reads it in their own tree. Sent again with the same `requestId`, it finds the
folder by its groups and makes nothing more. On the team root (its own reference as `ref`, by the managing account):
`files_share` puts the one user whose email is the address in the group of the role and takes them out of the other
(`recipient-refused`, `no-account` for no user or several); `files_unshare` takes them out of both (an id of no member
answers `not-found`); `files_shares` lists the members of both groups, the managing account left out, a Share's `id`
being `member:{user id}`; `files_rename_root` changes the mount point (`PUT /apps/groupfolders/folders/{id}`) and keeps
the reference; `files_get { root, ref: root }` gives the name and the `https` `webUrl`.

## What it does not do, and why

- **`atomicWrites: true` for Calendar.** providers §4 says true, CalDAV's entity tags being strong; Nextcloud 35 took
  two changes of one event sent together with one `If-Match` (both 204): its CalDAV compares, then writes. Common §5
  has a provider declare true only where the service does both in one step, so Calendar declares false, for every
  CalDAV server (the connector cannot tell one that does). The connector compares the version itself, and writes
  with `If-Match` all the same.
- **`notify: false` as `SCHEDULE-AGENT=NONE`** (providers §4). Sabre, Nextcloud's CalDAV, skips `CLIENT` alone and
  schedules a `NONE` attendee as any other (seen on Nextcloud 35: the invitation went out); RFC 6638 §7.1 has the
  server send nothing for either, so the connector writes `CLIENT`. On a change, a person the server already invited
  keeps its scheduling: Sabre sends a cancellation to a person changed to `CLIENT`. So a change or a cancellation with
  `notify: false` still reaches the people invited before: the server tells them, the connector cannot stop it.

- **A file's type of its own.** A Nextcloud types a file by its name's extension alone, whatever the `PUT` says (seen
  on Nextcloud 35): a text created as `notes` reads `application/octet-stream`, where FEAT-FILES-014 asks
  `text/plain`. No request of WebDAV or of Nextcloud's interfaces sets a file's type.
- **A comment on a cancellation or an answer** (capabilities `attendees`, `respond`) answers `not-supported` with
  `field: "comment"`: CalDAV's scheduling (RFC 6638, Sabre in Nextcloud) builds its CANCEL and REPLY with no comment
  of the client's, and dropping it would be ignoring an argument.
- **Two team roots of one name**: Nextcloud keeps one mount point per team folder; the second answers
  `already-exists`.
- **`not-allowed` and `too-many`** of `recipient-refused`: an address outside the organization is no account of the
  Nextcloud, and answers `no-account` (FEAT-NC-010).
- **Search of contents, `export`, `meeting`, links**: providers §2 declares none of them.
- **A declaration kept between requests**: each request asks the server again (two to five requests before a call).

## Configuration

| Variable | | Meaning |
|---|---|---|
| `PORT` | `8000` | |
| `HOST` | `0.0.0.0` | |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`; JSON lines on standard output, never a password, a user name, an address or a content |
| `ALLOWED_HOSTS` | all | the `Host` values the connector answers, comma-separated; any other gets `403` |
| `CURSOR_SECRET` | random per process | the key of the cursors, the same on every replica: needed only to run several replicas behind one address |
| `DAV_HOSTS` | none | the hosts the operator lists, comma-separated: reached even when they resolve to a private address (the deployment's own Nextcloud) |
| `DAV_HOSTS_ONLY` | `false` | `true`: the listed hosts alone are reached |
| `DAV_TIMEOUT_MS` | `30000` | the most one request to a server may take |
| `NODE_EXTRA_CA_CERTS` | none | Node's own: a file of certificate authorities to trust beside the runtime's (a server of the operator's own authority) |

The connector is reached by the agent alone: run it inside the deployment, with no route from outside (common §11).
It answers `/mcp` (MCP 2026-07-28, and the 2025-era `initialize`) and `GET /healthz`; it publishes no OAuth metadata,
the account being in headers.

## Run

```bash
pnpm build
DAV_HOSTS=cloud.example.org pnpm --filter @ayni.org/ayni-connector-nextcloud start

# the image, from the repository's root
docker build -f packages/connector-nextcloud/Dockerfile -t ayni-connector-nextcloud .
docker run --rm -p 8000:8000 -e DAV_HOSTS=cloud.example.org -e DAV_HOSTS_ONLY=true ayni-connector-nextcloud
```

The image runs as the user `node`, listens on port 8000, and checks its health at `/healthz`.

## Setting up a Nextcloud for Ayni

What its administrator does once:

1. **People's accounts.** Each person signs in at the Nextcloud, opens Settings, Security, and creates an **app
   password** for Ayni, which they type with their user name in Your accounts. With a second factor or an external
   sign-in, an app password is required.
2. **The Team folders app** (`groupfolders`, "Team folders" in the administration), for the managed folders of team
   spaces.
3. **The managing account** (agent D150): an account of the organization, not a person's, set in the deployment's
   secrets (`NEXTCLOUD_MANAGER_USERNAME`, `NEXTCLOUD_MANAGER_PASSWORD`). Either a member of the group `admin`, or a
   member of a group given both the **Team folders** settings (`OCA\GroupFolders\Settings\Admin`) and the **Users**
   settings (`OCA\Settings\Settings\Admin\Users`, the right to make groups and put people in them), with
   `occ admin-delegation:add`; the Team folders settings alone let it make folders but no groups, and the connector
   then declares no `team-roots` (seen on Nextcloud 35). **Its password must be its login password, not an app
   password**: Nextcloud asks for the password to be confirmed before it makes a group, puts a user in one or changes a
   team folder, and a sign-in with an app password confirms none (seen on Nextcloud 35, `PasswordConfirmationMiddleware`);
   such a call answers `permission-denied` saying so. The other way is for the administrator to list the connector's
   addresses in `config.php`, `'allowed_no_password_confirmation_ranges' => ['10.42.0.0/16']`, which lets an app password
   through from them. The connector declares `team-roots` to that account alone. Each person must have their email set:
   a member is found by it.
4. **Mail** (Administration, Basic settings, Email server), for share notifications and invitations. Sharing by email
   (the app "Share by mail") and public links are declared only where they are on.
5. **The connector's host**: `DAV_HOSTS=cloud.example.org` when the Nextcloud is on the deployment's network (a private
   address), with `DAV_HOSTS_ONLY=true` to reach it alone.

## In the agent-pack

```yaml
tools:
  features:
    files:    { title: Files,    profile: { id: org.ayni/files,    version: "1.0" } }
    calendar: { title: Calendar, profile: { id: org.ayni/calendar, version: "1.0" } }
  sources:
    cloud:                               # Files in Personal, each person with their own account
      type: mcp
      feature: files
      title: Nextcloud
      description: Your files on cloud.example.org
      transport: streamable-http
      url: http://connector-nextcloud.internal:8000/mcp
      headers: { Ayni-Nextcloud: "https://cloud.example.org" }
      account:
        kind: personal
        fields:
          - { name: username, label: User name, pattern: "^[\\x21-\\x7E]{1,128}$" }
          - { name: password, label: App password, pattern: "^[\\x21-\\x7E]{8,255}$" }
        apply:
          - { header: Ayni-Dav-Username, value: "{username}" }
          - { header: Ayni-Dav-Password, value: "{password}" }
      availability: personal
      access: { roles: { employee: ["*"] } }

    cloud-calendar:                      # Calendar in Personal, with the same account
      type: mcp
      feature: calendar
      title: Nextcloud
      description: Your calendars on cloud.example.org
      transport: streamable-http
      url: http://connector-nextcloud.internal:8000/mcp
      headers: { Ayni-Nextcloud: "https://cloud.example.org" }
      account: { kind: personal, from: cloud }
      availability: personal
      access: { roles: { employee: ["*"] } }

    cloud-team:                          # Files in a team space: a team folder the agent makes and keeps (D145, D150)
      type: mcp
      feature: files
      title: Nextcloud
      description: A folder of the organization's Nextcloud that the team shares
      transport: streamable-http
      url: http://connector-nextcloud.internal:8000/mcp
      headers: { Ayni-Nextcloud: "https://cloud.example.org" }
      account: { kind: personal, from: cloud }
      manage:
        as: manager
        apply:
          - { header: Ayni-Dav-Username, value: "${NEXTCLOUD_MANAGER_USERNAME}" }
          - { header: Ayni-Dav-Password, value: "${NEXTCLOUD_MANAGER_PASSWORD}" }
      availability: spaces
      access: { roles: { employee: ["*"] } }

    dav-folder:                          # Files in a team space on any other WebDAV server, with the space's account
      type: mcp
      feature: files
      title: WebDAV folder
      description: A folder on a WebDAV server, with an account of the space
      transport: streamable-http
      url: http://connector-nextcloud.internal:8000/mcp
      account:
        kind: space
        fields:
          - { name: address, label: Address of the folder, pattern: "^https://[\\x21-\\x7E]{4,1000}$" }
          - { name: username, label: User name, pattern: "^[\\x21-\\x7E]{1,128}$" }
          - { name: password, label: App password, pattern: "^[\\x21-\\x7E]{8,255}$" }
        apply:
          - { header: Ayni-Dav-Files, value: "{address}" }
          - { header: Ayni-Dav-Username, value: "{username}" }
          - { header: Ayni-Dav-Password, value: "{password}" }
      availability: spaces
      access: { roles: { employee: ["*"] } }
```

A plain CalDAV server's calendars take `Ayni-Dav-Calendars` the same way (`dav-calendar`, its address the server's
root or the account's calendar home). The managed folder's tools (`files_create_team_root`, `files_rename_root`,
`files_shares`, `files_share`, `files_unshare`) are called by the agent's code with the managing account alone.

## Tests

No test reaches a real or a remote service. [`tests/stub`](tests/stub) is a stub of a Nextcloud and of a plain WebDAV
and CalDAV server, after RFC 4918, 4791, 5323, 6638, 6764 and Nextcloud's documentation, corrected by what Nextcloud 35
was seen to do: HTTPS on `127.0.0.1` under names of its own, with a certificate authority made in memory; file ids,
permissions, mounts of shares and team folders, the trash bin, versions, SEARCH; the OCS Share API with its mails,
the provisioning interface, the Team folders app; principals, calendar homes, `calendar-query` (which ignores
`expand`), `free-busy-query`, the scheduling outbox and the delivery of invitations, changes, cancellations and
answers between its users. It records every request with its credentials.

- [`conformance.test.ts`](tests/conformance.test.ts): the conformance kit against the connector over the stub: Files
  and Calendar of a Nextcloud over MCP 2026-07-28 and over the 2025-era `initialize`, Files of a plain WebDAV server,
  Calendar of a plain CalDAV server with scheduling found from its root. No failure but one divergence of the store,
  pinned exactly: FEAT-FILES-014's `notes` (above).

  | Run | Pass | Fail | Skip | Not applicable |
  |---|---|---|---|---|
  | Nextcloud, Files, 2026-07-28 | 62 | 1 (FEAT-FILES-014, pinned) | 2 | 2 |
  | Nextcloud, Calendar, 2026-07-28 | 51 | 0 | 0 | 5 |
  | Nextcloud, Files, 2025-11-25 | 61 | 1 (FEAT-FILES-014, pinned) | 3 | 2 |
  | Nextcloud, Calendar, 2025-11-25 | 51 | 0 | 0 | 5 |
  | plain WebDAV, Files | 45 | 0 | 2 | 20 |
  | plain CalDAV with scheduling, Calendar | 51 | 0 | 0 | 5 |

  Skipped: FEAT-FILES-012 and 017, whose fixtures (a shortcut, two items of one name) neither WebDAV nor Nextcloud
  can hold; FEAT-FILES-053 in the run of the 2025 era, which has no hook of messages. Not applicable: the
  capabilities not declared (`export`, `meeting`, and those a plain server has not), FEAT-CORE-011 for Calendar
  (`atomicWrites: false`), FEAT-CAL-011 (`recurrence` is declared), FEAT-CORE-014 and 022 for Calendar.
- [`dav.test.ts`](tests/dav.test.ts) FEAT-DAV-001 to 004; [`webdav.test.ts`](tests/webdav.test.ts) FEAT-WEBDAV-001 to
  006; [`caldav.test.ts`](tests/caldav.test.ts) FEAT-CALDAV-001 to 007, and what B receives;
  [`nextcloud.test.ts`](tests/nextcloud.test.ts) FEAT-NC-001 to 011; [`mapping.test.ts`](tests/mapping.test.ts) the
  rules, iCalendar, zones, XML and paths on their own.

## What the stub does after Nextcloud 35, and what it assumes

Seen on Nextcloud 35.0.3 with Team folders 23.0.2 (its container, and its source), and done so by the stub:

| Behaviour | Where it matters |
|---|---|
| `current-user-principal` names `/remote.php/dav/principals/users/{user id}/`, also for a sign-in by email | FEAT-NC-001 |
| An item has one `oc:fileid` for its owner and every sharee; a team folder's root one for every member; a trashed and restored item keeps it | FEAT-NC-002, 003, 011, `trash` |
| `SEARCH` takes its scope as a decoded path (an encoded one finds nothing), never answers the scope itself, finds inside shares and team folders; `like` ignores case and reads `%` and `_` | FEAT-NC-002, 004, FEAT-FILES-020 |
| `PUT` with `If-None-Match: *` or a wrong `If-Match` answers 412; into a missing folder 404 (not 409) | FEAT-WEBDAV-004, FEAT-FILES-008 |
| A file's type comes from its name's extension alone | FEAT-FILES-014 |
| A second concurrent write of a file answers 423 while the first holds its lock | FEAT-CORE-011 |
| `DELETE` goes to the trash bin; a restore whose name is taken is renamed `(restored)`, one whose folder is gone goes to the account's own folder | FEAT-NC-005, FEAT-FILES-041 |
| Versions list the current one too, each named by the second of its change; changes within one second keep one version, an `X-OC-Mtime` of another second keeps each | `versions`, FEAT-FILES-060, 062 |
| A share with a person mails them unless `sendMail` is `false`; the sharees interface matches a person by their exact email; a public link gets the permission 16 added by the server | FEAT-NC-006, FEAT-FILES-053 |
| The Team folders app gives no file id of a folder; its mount point is unique (400 `Mount point already exists`, also for a rename to the same name); a folder is visible in a member's tree on the next request | §5.1 |
| A login password confirms the password of calls marked so, an app password does not; the Team folders settings alone let an account make folders but no groups | FEAT-NC-008, 009, 010 |
| OCS v1 and the Team folders app refuse with `200` and `statuscode` 403, a group that exists is 102; the users' search matches parts of ids, names and emails | §5.1 |
| The calendar home holds the calendars, `contact_birthdays` (read only), the inbox, the outbox and a trash bin; the `DAV` header of the calendars announces `calendar-auto-schedule`; `/.well-known/caldav` redirects to `/remote.php/dav/` | FEAT-CALDAV-002, 006 |
| Scheduling skips `SCHEDULE-AGENT=CLIENT` alone (`NONE` is scheduled); a change of an invited person to `CLIENT` cancels their copy; `Schedule-Reply: F` sends no answer; invitations, changes and cancellations are mailed to the people of the server too | FEAT-CALDAV-006, FEAT-CAL-040, 051 |
| Two changes of one event sent together with one `If-Match` both succeed | Calendar's `atomicWrites` |
| A `MOVE` into the trash bin's restore collection with `Overwrite: F` answers 412 | FEAT-NC-005 |

Assumed after the RFCs and Nextcloud's documentation, not seen:

| Assumption | Where it matters |
|---|---|
| A plain server other than Nextcloud (Stalwart) keeps a `PUT`'s `Content-Type`, gives entity tags, answers `DASL` only where it searches, and puts its calendar home on its own origin | the plain path |
| A plain CalDAV server other than Sabre's reads `SCHEDULE-AGENT=CLIENT` as RFC 6638 says (nothing sent) | `notify: false` on a plain server |
| Nextcloud's version expiry, a background job, keeps what the store's retention keeps | `versions` |
| The trash of a team folder is listed in its members' trash bins with a place under the mount point | `trash` in a team root |
| Advanced permissions (ACL) of a team folder, external storages and encryption change no file id | FEAT-NC-002, 003 |
| A Nextcloud under a path (`https://example.org/cloud`) answers at `{base}/remote.php/dav/`, `{base}/ocs/` and `{base}/index.php/` | the address |

## The conformance kit against a real Nextcloud, by hand

[`scripts/nextcloud-local.mjs`](scripts/nextcloud-local.mjs) runs it against a throwaway official `nextcloud`
container, never in `pnpm test`:

```bash
pnpm build
node packages/connector-nextcloud/scripts/nextcloud-local.mjs --json /tmp/report.json
```

It needs Docker running and nothing else: it starts `nextcloud:35.0.3` (SQLite) and `axllent/mailpit` in a network of
their own, HTTPS made inside the container on a loopback port, installs the Team folders app from the app store, makes
the accounts `ana`, `jonas` and `ayni-manager` (in `admin`) with passwords made in the process and written nowhere,
the two locations of each profile (`/Conformance`, and Jonas's `Shared with Ana` shared to read; Ana's `personal`
calendar in `Europe/Paris`, and Jonas's `Team Alpha` shared to read), a floating event and an event with a
`CONFERENCE`; runs the kit for Files (with Mailpit's messages) and Calendar; prints the totals and every result that
is not a pass; and removes the containers, their volumes and the network, whatever happens. `NEXTCLOUD_IMAGE` and
`MAILPIT_IMAGE` change the images.

Against any other server (Stalwart for the plain path, or a Nextcloud of a test organization), a `run.json` for
`npx @ayni.org/ayni-conformance --config run.json`:

```json
{
  "url": "http://127.0.0.1:8000/mcp",
  "accounts": {
    "A": { "headers": { "Ayni-Dav-Files": "https://dav.example.org/dav/files/a/", "Ayni-Dav-Calendars": "https://dav.example.org/", "Ayni-Dav-Username": "a", "Ayni-Dav-Password": "<A's app password>" }, "address": "a@example.org", "secrets": ["<A's app password>"] },
    "B": { "headers": { "Ayni-Dav-Files": "https://dav.example.org/dav/files/b/", "Ayni-Dav-Calendars": "https://dav.example.org/", "Ayni-Dav-Username": "b", "Ayni-Dav-Password": "<B's app password>" }, "address": "b@example.org", "secrets": ["<B's app password>"] }
  },
  "files": { "first": { "ref": "/Conformance", "path": "/Conformance" }, "second": { "ref": "/Second", "path": "/Second" } },
  "calendar": { "first": { "ref": "<path of A's main calendar>" }, "second": { "ref": "<path of a calendar A may read>" } },
  "organization": { "noAccount": "nobody@example.org" }
}
```

with the connector started with `DAV_HOSTS` naming the server when it is on a private address. For a Nextcloud, the
headers are `Ayni-Nextcloud`, `Ayni-Dav-Username` and `Ayni-Dav-Password`, the references file ids (`oc:fileid` of
`PROPFIND`), and an account `M` that may set up team folders tests `team-roots`. The run leaves its files in A's trash
bin (a plain server has none: empty `/Conformance` by hand) and cancels its events; team folders it made stay.
