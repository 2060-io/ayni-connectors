/**
 * Errors of a profile's tools (common §9): a refusal or a failure is a tool execution error of MCP, `isError: true`,
 * with `{ "error": { "code", "message", … } }` in `structuredContent` and as JSON in one `text` block. The message is
 * one sentence in English, with no credential, no address of the service and no name of an item outside the location.
 */
import type { ErrorCode, ProfileErrorContent } from '@ayni.org/ayni-feature-profiles'

export type ErrorMembers = Omit<ProfileErrorContent['error'], 'code' | 'message'>

/** An error a provider answers: thrown by a handler, mapped to the tool's error result by the kit. */
export class ProfileError extends Error {
  public readonly code: ErrorCode
  public readonly members: ErrorMembers

  public constructor(code: ErrorCode, message: string, members: ErrorMembers = {}) {
    super(message)
    this.name = 'ProfileError'
    this.code = code
    this.members = members
  }

  public toContent(): ProfileErrorContent {
    return { error: { code: this.code, message: this.message, ...this.members } }
  }
}

export function isProfileError(error: unknown): error is ProfileError {
  return error instanceof ProfileError
}

/** The errors of the tables, with a default message each. */
export const errors = {
  invalidArgument: (field: string, message = `The argument "${field}" is not valid.`) =>
    new ProfileError('invalid-argument', message, { field }),
  notSupported: (message = 'This server does not support this.', field?: string) =>
    new ProfileError('not-supported', message, field ? { field } : {}),
  notFound: (message = 'No such item in this location.') => new ProfileError('not-found', message),
  outsideLocation: (message = 'The destination would leave the location.') =>
    new ProfileError('outside-location', message),
  alreadyExists: (message = 'An item of this name is already there.') => new ProfileError('already-exists', message),
  versionMismatch: (currentVersion: string, message = 'The item changed since the version given.') =>
    new ProfileError('version-mismatch', message, { currentVersion }),
  tooLarge: (limitBytes: number, sizeBytes?: number, message = 'The content is larger than this server takes.') =>
    new ProfileError('too-large', message, { limitBytes, ...(sizeBytes !== undefined ? { sizeBytes } : {}) }),
  permissionDenied: (message = 'The account may not do this.') => new ProfileError('permission-denied', message),
  accountRefused: (message = 'The request carries no credentials the service accepts.') =>
    new ProfileError('account-refused', message),
  rateLimited: (retryAfterSeconds?: number, message = 'The service asks to wait.') =>
    new ProfileError('rate-limited', message, retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  unavailable: (message = 'The service cannot be reached, or failed.') => new ProfileError('unavailable', message),
  badCursor: (message = 'The cursor is unknown, expired, or was given for other arguments.') =>
    new ProfileError('bad-cursor', message),
  recipientRefused: (
    reason: 'no-account' | 'not-allowed' | 'too-many',
    message = 'The store cannot make this address a member.'
  ) => new ProfileError('recipient-refused', message, { reason }),
}

/** A message with every secret of the account replaced: no credential leaves in an error (FEAT-CORE-007, 019). */
export function scrub(text: string, secrets: readonly string[]): string {
  let out = text
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join('[redacted]')
  return out
}
