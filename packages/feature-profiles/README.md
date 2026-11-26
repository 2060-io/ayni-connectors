# @ayni.org/ayni-feature-profiles

The **Ayni Feature Profiles 1.0** as code: Files 1.0 (`org.ayni/files`) and Calendar 1.0 (`org.ayni/calendar`) on
their common part, for an MCP server that provides a profile and for a client that relies on one (the Ayni Agent
first). The spec is normative: [`2060-io/ayni-spec`, `v4/ayni-feature-profiles/`](https://github.com/2060-io/ayni-spec/tree/main/v4/ayni-feature-profiles).
This package is its machine-readable copy (common §4).

## What it holds

| Export | What it is | Spec |
|--------|-----------|------|
| `FILES_PROFILE`, `CALENDAR_PROFILE`, `PROFILES`, `profileOf(id)` | each profile: identifier, version, prefix, location argument and its three labels, capabilities (the tools each adds, the capabilities it requires), and every tool with its name, title, description (the words the model reads), arguments with their titles, result schema, effect, capability, mark of content written by others, the error codes the profile names for it, whether it lists | files §3 to §4, calendar §3 to §4, common §2, §4, §6, §10 |
| `mcpToolsFor(profile, capabilities)`, `inputSchemaFor(tool, capabilities)` | the MCP definitions (`tools/list`) of the tools of a set of capabilities in use, in the profile's order, with the arguments and values of the others left out: the same bytes for every provider with the same capabilities | common §4, the agent's TOOL-FEAT-010 |
| `checkCall(profile, tool, args, declaration)` | the checks of a call before it reaches the service: unknown argument `invalid-argument`, argument or value of a capability (or of a part of the declaration) not declared `not-supported`, the schema, the rules between arguments, the rules of times, time zones and repetitions | common §4, §9, files §4.4, calendar §3, §4.2 |
| `validateResult`, `validateErrorContent`, `validateDeclaration` | JSON Schema (2020-12) validation of a result's structured content, of an error, of a declaration (with the least of each limit) | FEAT-CORE-001, 006, 007, 026 |
| `effectOfCall(tool, args, isInside)`, `addressesOf`, `insideDomains(domains)` | the effect of one call: `external` once an address the call names is outside the organization, or for `audience: "anyone"` | common §10, the agent's TOOL-FEAT-013 |
| `itemsOfResult`, `foreignItems`, `dropForeignItems` | the items of a result and those that do not carry the location of their call | FEAT-CORE-013, the agent's TOOL-FEAT-015 |
| `parseRule`, `formatRule` | the part of iCalendar `RRULE` that Calendar 1.0 takes | calendar §4.2 |
| `COMMON_ERRORS`, `FILES_ERRORS`, `DEFAULT_LIMITS`, `LEAST_LIMITS`, `PAGE`, `DEFAULT_RULE_OF_EFFECT`, `annotationsOf(effect)` | the tables of the common part; the default call rule of each effect (the agent's TOOL-CAT-007); MCP's hints from an effect (FEAT-CORE-018) | common §7, §9, §10, §12 |
| types `Item`, `Root`, `Share`, `Content`, `CalendarEvent`, `Calendar`, `Attendee`, `FilesDeclaration`, `CalendarDeclaration`, and each tool's arguments and result | the shapes as TypeScript | files §1, calendar §1 |

## Pinned to the spec

[`spec/facts.json`](spec/facts.json) holds what the spec's tables and lines give, read from its documents at the
commit it names: every tool, title, effect, mark, description, argument (title, presence, capability), capability,
error code, limit and requirement id. [`tests/spec-pin.test.ts`](tests/spec-pin.test.ts) checks that all of it is the
package's, and that the package has nothing the spec does not give; the conformance kit's coverage test checks its
requirement ids against the same file.

To follow a change of the spec, with a checkout of `2060-io/ayni-spec`:

```bash
AYNI_SPEC_DIR=../ayni-spec/v4/ayni-feature-profiles AYNI_SPEC_COMMIT=$(git -C ../ayni-spec rev-parse HEAD) \
  UPDATE_SPEC_FACTS=1 pnpm vitest run packages/feature-profiles/tests/spec-facts.test.ts
pnpm fix-format && pnpm test   # the pin test now says what of the code has to follow
```

With `AYNI_SPEC_DIR` alone, the same test checks that `facts.json` is still the spec's.

## Usage

```ts
import { FILES_PROFILE, checkCall, mcpToolsFor } from '@ayni.org/ayni-feature-profiles'

// a client: the tools to give the model for what a server declared
const declaration = { version: '1.0', capabilities: ['folders', 'search'] }
const tools = mcpToolsFor(FILES_PROFILE, declaration.capabilities)

// a server: refuse a call before it reaches the service
const refusal = checkCall(FILES_PROFILE, 'files_list', { root: 'r', colour: 'red' }, declaration)
// { code: 'invalid-argument', field: 'colour', message: 'files_list takes no argument "colour".' }
```
