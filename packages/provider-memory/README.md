# @ayni.org/ayni-provider-memory (private)

An in-memory provider of Files 1.0 and Calendar 1.0 with every capability, on the provider kit. It is the reference
the conformance kit runs against in CI, and a fake for a client's tests (the Ayni Agent's): a real MCP server over
HTTP, with accounts as bearer tokens, a file store and a calendar server in memory, and what a test does at the
service "by other means" (common §13). Not published; every example in it is fictional.

```ts
import { startMemoryProvider } from '@ayni.org/ayni-provider-memory'

const provider = await startMemoryProvider({ files: { capabilities: ['folders', 'search'] } })
const [a] = provider.service.users // fictional accounts, random tokens
// connect a client to provider.url with `Authorization: Bearer ${a.token}`
await provider.running.close()
```

| What | Where |
|------|-------|
| Options | `files` (`capabilities`, `searchContent`, `audiences`, `notify`, `teamRootManager`, `teamRootOutside`, `maxTeamMembers`, `organizationDomains`, `teamRootCreators`, `limits`, `nativeConvertsText`), `calendar` (`capabilities`, `timeZone`, `meetingLabel`); `false` leaves a profile out |
| By other means | `files.seedFolder`, `seedFile` (a native document, two items of one name), `seedLink`, `seedShare`; `calendar.seedCalendar`, `seedEvent` (a floating time, a rule, an organizer and attendees, a `CONFERENCE`) |
| The service | `service.available` (false: every call `unavailable`), `service.askBeforeWrite`, `service.outbox` and `messagesTo(address)` |
| A conformance run | `conformanceSetup(provider, url)`: the locations, fixtures and hooks of a run against it |

Run it on its own: `pnpm --filter @ayni.org/ayni-provider-memory start` (after `pnpm build`) prints the endpoint
and each account's token.

Its tests run the conformance kit four times: every capability over MCP 2026-07-28 and over the 2025-era
`initialize`, the core alone with small pages, and narrower declarations (no content search, one audience, no
telling of recipients, no manager, documents not converted, a calendar without scheduling); and once against a
provider broken on purpose, which must fail.
