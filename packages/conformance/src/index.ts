/**
 * The conformance tests of the Ayni Feature Profiles as a kit: the *Verify* lines of FEAT-CORE, FEAT-FILES and
 * FEAT-CAL run against any provider's MCP endpoint (common §13), from a test runner or from the CLI
 * `ayni-conformance`, each reported by its requirement id.
 */
export { type RegisterOptions, type RunnerApi, registerConformance } from './register.js'
export { requirementIdsOf, runConformance, testsOf } from './run.js'
export type * from './types.js'
