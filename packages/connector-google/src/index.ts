/**
 * The Google connector of Ayni: an MCP server that speaks Files 1.0 over the Google Drive API v3 and Calendar 1.0 over
 * the Google Calendar API v3 (providers §6), with the person's own Google access token of each request in
 * `Authorization: Bearer` (common §11, TOOL-OAUTH-018).
 */
export { CALENDAR_DECLARATION, calendarProvider } from './calendar.js'
export { driveProvider, FILES_DECLARATION, type GoogleAccount, WRITE_BYTES } from './drive.js'
export {
  GOOGLE_API_HOST,
  GOOGLE_AUTHORIZATION_SERVER,
  GOOGLE_ENDPOINTS,
  type GoogleEndpoints,
  isGoogleEndpoint,
} from './endpoints.js'
export { GoogleError, profileErrorOf } from './google.js'
export { isLogLevel, jsonLogger, type LogLevel } from './log.js'
