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
authority; this repository follows it.

## Packages

One package per directory of `packages/`, a pnpm workspace. Planned, in this order:

| Package | npm | What it is |
|---------|-----|------------|
| `packages/feature-profiles` | `@ayni.org/ayni-feature-profiles` | the contracts as code, for a provider (server) and for a client (the Ayni Agent) alike |
| `packages/provider-kit` | `@ayni.org/ayni-provider-kit` | what every connector shares: the MCP server, the declaration, validation, errors, pages, accounts |
| `packages/conformance` | `@ayni.org/ayni-conformance` | the spec's *Verify* lines as a runnable test kit against any provider's MCP endpoint, with a CLI |
| `packages/provider-memory` | private | an in-memory provider of every profile and capability: the conformance kit's reference, and a fake for clients' tests |

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
pnpm test           # vitest
pnpm validate       # format, types, tests
```

## Conventions

Those of the organization's TypeScript template: Biome (no semicolons, single quotes, 120 columns), TypeScript in
strict mode, vitest, Node 24. Commits follow Conventional Commits. No secret, no real person's or customer's name in
the code, the tests or the examples: every example is fictional, and no test contacts a real service.

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) calls the organization's reusable workflow
(`2060-io/organization`, `2060-linter-call.yml`, pinned by SHA): install, build, format, types, tests, and the
validation of a pull request's title. Third-party actions are pinned by their full SHA.

## TODO: release, publishing and images

Not set up yet: each needs settings that only the repository's owner can make.

- **npm releases**: release-please (a manifest, linked versions across the published packages) and a release
  workflow that publishes with npm trusted publishing (OIDC), on the model of `2060-io/credo-ts-ayni-flow`.
- **Docker images**: one image per connector, built and pushed by a workflow on the model of the template's `cd.yml`.

## Licence

[Apache-2.0](LICENSE).
