# ayni-connectors

The providers of the **Ayni Feature Profiles** over MCP, in one repository: the contracts as code, what every
connector shares, a conformance kit that anyone can run against their own provider, and the connectors themselves,
each shipped as a Docker image of its own.

A feature profile is the public contract of one feature (Files, Calendar): the exact MCP tools every provider of it
exposes, with their names, descriptions, arguments, results, effects and errors, so that two providers can be
exchanged without the model, the rules or the words people read changing. The profiles are normative in
[`2060-io/ayni-spec`](https://github.com/2060-io/ayni-spec), directory
[`v4/ayni-feature-profiles/`](https://github.com/2060-io/ayni-spec/tree/main/v4/ayni-feature-profiles): the common
part (FEAT-CORE), Files 1.0 (FEAT-FILES), Calendar 1.0 (FEAT-CAL) and the first providers. The spec is the
authority; this repository follows it, and the tests pin the code to what the spec's tables give at one commit
([`packages/feature-profiles/spec/facts.json`](packages/feature-profiles/spec/facts.json)).

## Packages

| Package | npm | What it is |
|---------|-----|------------|
| [`packages/feature-profiles`](packages/feature-profiles) | `@ayni.org/ayni-feature-profiles` | the contracts as code, for a provider (server) and for a client (the Ayni Agent) alike: tools, descriptions, titles, JSON Schemas, effects, capabilities, errors, declarations, limits, and the checks of a call |
| [`packages/provider-kit`](packages/provider-kit) | `@ayni.org/ayni-provider-kit` | what every connector shares: the MCP server (Streamable HTTP), the declaration, validation of calls and results, errors, pages and cursors, accounts |
| [`packages/conformance`](packages/conformance) | `@ayni.org/ayni-conformance` | the spec's *Verify* lines as a test kit against any provider's MCP endpoint, from a test runner or the CLI `ayni-conformance`, reported per requirement id |
| [`packages/provider-memory`](packages/provider-memory) | private | an in-memory provider of Files 1.0 and Calendar 1.0 with every capability: the conformance kit's reference in CI, and a fake for clients' tests |
| [`packages/connector-google`](packages/connector-google) | private, image `ayni-connector-google` | Google Drive (Files) and Google Calendar (Calendar) over the Drive API v3 and the Calendar API v3, with the person's own Google access token of each request; the conformance kit passes it over a stub of Google in CI |
| [`packages/connector-nextcloud`](packages/connector-nextcloud) | private, image `ayni-connector-nextcloud` | Files over WebDAV and Calendar over CalDAV, with a Nextcloud's own interfaces (search, trash bin, versions, OCS shares, Team folders) and any other WebDAV or CalDAV server with fewer operations; the account in the `Ayni-*` headers of each request; the conformance kit passes it over a stub of a Nextcloud and of a plain server in CI, and a script runs it against a throwaway Nextcloud by hand |

```
feature-profiles ◄── provider-kit ◄── provider-memory, connector-google, connector-nextcloud
        ▲
        └──────── conformance (an MCP client; tests any provider)
```

## Requirements

- Node.js 24
- pnpm, the version pinned in [`package.json`](package.json) (`packageManager`): `corepack enable` picks it up, or
  run `npx -y pnpm@<version>`

## Run

```bash
pnpm install
pnpm build          # every package, in dependency order
pnpm check-format   # Biome
pnpm fix-format     # Biome, writing its fixes
pnpm check-types    # each package's build config, then the tests
pnpm test           # vitest: the contracts pinned to the spec, the kit, and the conformance kit against the in-memory provider
pnpm validate       # format, types, tests
```

To try a client against a provider: `pnpm build && pnpm --filter @ayni.org/ayni-provider-memory start` serves the
in-memory provider on `http://127.0.0.1:8000/mcp` and prints the fictional accounts' bearer tokens.

To test a provider of your own: see [`packages/conformance`](packages/conformance), `npx @ayni.org/ayni-conformance
--config run.json`.

## MCP

The official TypeScript SDK at the revision the spec names, **MCP 2026-07-28**: `@modelcontextprotocol/server` and
`@modelcontextprotocol/client` 2.x. The v1.x line of `@modelcontextprotocol/sdk` implements MCP up to 2025-11-25 and
does not plan 2026-07-28 (its README), so it cannot answer `server/discover`, where common §3 declares a profile.
Every provider of this repository also answers the 2025-era `initialize` (the SDK's stateless serving), with the same
declaration in `capabilities.extensions`: the Ayni Agent's client of today (`@modelcontextprotocol/sdk` 1.32) uses
them as they are, which the kit's tests check with that client, and the conformance kit runs in both eras.

## Roadmap

The connectors, each a package of its own and an image of its own, built on the kit and passing the conformance kit
against stub services in CI. The Google connector ([`packages/connector-google`](packages/connector-google)) and the
Nextcloud connector ([`packages/connector-nextcloud`](packages/connector-nextcloud)) are built:

| Package | Image | What it is | Spec |
|---------|-------|-----------|------|
| `packages/connector-google` | `ayni-connector-google` | Google Drive (Files) and Google Calendar (Calendar) over the Drive API v3 and the Calendar API v3, with the person's own Google access token in `Authorization`; publishes Protected Resource Metadata naming Google's authorization server. Files: `folders`, `search` (with content), `trash`, `share` (`organization`, `anyone`), `versions`, `export`, `team-roots` (shared drives, `manager: true`), `atomicWrites: false`; Calendar: every capability (Google Meet), `atomicWrites: true` | providers.md §6, the Google columns of files §6 and calendar §6 |
| `packages/connector-nextcloud` | `ayni-connector-nextcloud` | Nextcloud over WebDAV and CalDAV and Nextcloud's own interfaces (search, trash bin, versions, the OCS Share API, Team folders), and any other WebDAV or CalDAV server with fewer operations; the account in the `Ayni-Nextcloud`, `Ayni-Dav-Files`, `Ayni-Dav-Calendars`, `Ayni-Dav-Username` and `Ayni-Dav-Password` headers (`headerAccount` of the kit). Files: `search` (names), `folders`, `trash`, `share` (people, `anyone`), `versions`, `team-roots` (to the managing account, `manager: false`), each where the server has it on, `atomicWrites: true`; a plain server `folders`, `search` with `DASL`; Calendar: `free-busy`, `recurrence`, `attendees` and `respond` with scheduling | providers.md §1 to §5, normative: FEAT-DAV, FEAT-WEBDAV, FEAT-CALDAV, FEAT-NC |

Later: Microsoft 365 through Microsoft Graph (providers.md §7, not specified yet), and the providers of Mail once its
profile is written (providers.md §8).

## Conventions

Those of the organization's TypeScript template: Biome (no semicolons, single quotes, 120 columns), TypeScript in
strict mode, vitest, Node 24; the monorepo layout of `2060-io/credo-ts-ayni-flow` (a pnpm workspace, tsdown builds to
`build/`). Commits follow Conventional Commits. No secret, no real person's or customer's name in the code, the tests
or the examples: every example is fictional (`example.org`, `.invalid` hosts), and no test contacts a real service.

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) calls the organization's reusable workflow
(`2060-io/organization`, `2060-linter-call.yml`, pinned by SHA): install, build, format, types, tests (the conformance
kit against the in-memory provider among them), and the validation of a pull request's title. Third-party actions
are pinned by their full SHA.

## TODO: release, publishing and images

Not set up yet: each needs settings that only the repository's owner can make.

- **npm releases** of `@ayni.org/ayni-feature-profiles`, `@ayni.org/ayni-provider-kit` and
  `@ayni.org/ayni-conformance`: release-please (`release-please-config.json` and `.release-please-manifest.json`, one
  entry per published package, the `linked-versions` plugin) and a `release.yml` that publishes the packages released
  with npm trusted publishing (OIDC, `id-token: write`, `pnpm publish --provenance`), on the model of
  `2060-io/credo-ts-ayni-flow`. `provider-memory` and the connectors stay private on npm.
- **Docker images**: one per connector (`packages/connector-*/Dockerfile`, Node 24, `pnpm deploy --filter` of the
  connector; the Google connector's and the Nextcloud connector's exist and build), built on every pull request and pushed on a release by a workflow on the model of the template's
  `cd.yml` (`resolve-version-call`, tags `X.Y.Z`, `vX.Y`, `latest`, `dev`), gated on the repository variable
  `CD_ENABLED`; a Helm chart per connector (named `<image>-chart`) once `2060-io/ayni-deploy` takes them.

## Licence

[Apache-2.0](LICENSE).
