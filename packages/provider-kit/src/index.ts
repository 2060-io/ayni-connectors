/**
 * What every provider of the Ayni Feature Profiles shares: an MCP server over Streamable HTTP that declares the
 * profiles, versions and capabilities a connector implements, registers their tools from the connector's handlers,
 * checks each call and each result against the contract, maps errors to the profile's codes, pages, and reads the
 * account from each request.
 */
export * from './account.js'
export * from './cursor.js'
export * from './errors.js'
export * from './http.js'
export * from './providers.js'
export * from './server.js'
