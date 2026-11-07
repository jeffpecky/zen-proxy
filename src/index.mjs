// Public surface.
//
// The proxy is a program, not a library, but the test suite drives its parts
// directly. This file re-exports exactly what the tests (and the documented
// integrations) use — nothing more. Everything else stays private to its
// module, so internals can move without touching the public shape.
//
// Nothing in src/ imports this file, so it cannot create a cycle.
export {
  VALID_MODEL_ID,
  toBool,
} from "./util.mjs"
export {
  MAX_BODY,
  config,
  loadConfig,
  saveConfig,
  sanitize,
  maskKey,
  isFallbackModelsPinned,
} from "./config.mjs"
export {
  createApiKey,
  regenerateApiKey,
  revokeApiKey,
  listApiKeys,
  resolveApiKey,
  authRequired,
  ensureDefaultKey,
  hashKey,
  KEY_RE,
} from "./apikeys.mjs"
export { logLines } from "./log.mjs"
export {
  loadShippedModels,
  AGENT_TOOL_MAP,
  loadAgentTools,
  remapAgentTool,
  applyFingerprintTools,
  concealFingerprintToolNames,
  appendMissingFingerprintTools,
  fingerprintToolKey,
} from "./catalogs.mjs"
export {
  OPENCODE_CIPHERS,
  OPENCODE_TLS_PROFILE,
  resetTlsSession,
  upstreamFetch,
} from "./tls.mjs"
export {
  clientIp,
  ipOmit,
  maxBodyBytes,
  readBody,
  authForUpstream,
} from "./net.mjs"
export {
  SESSION_MAX_AGE_MS,
  OPENCODE_SESSION_RE,
  genSessionId,
  translateSessionId,
  sessionFor,
  identityFor,
} from "./session.mjs"
export { zenHeaders, upstreamUserAgent } from "./headers.mjs"
export { aliasGatedTools, restoreToolNames } from "./bridge.mjs"
export {
  effectiveDefault,
  resolveModel,
  modelFormat,
} from "./model.mjs"
export {
  parseRetryAfter,
  retryableUpstream,
  transientUpstream,
  exhaustedFreeVerdict,
} from "./retry.mjs"
export { recordReq, requestStats, syncState } from "./stats.mjs"
export {
  anthropicToChatBody,
  anthropicToChatMessages,
  anthropicToolsToChat,
  chatToAnthropic,
  anthropicError,
} from "./wire/anthropic.mjs"
export {
  responsesToChat,
  responsesEventToDeltas,
  usageToChat,
  sanitizeResponsesItems,
  chatMessagesToInput,
  chatToolsToResponses,
  responsesInputToMessages,
  responsesInputToChatBody,
  chatToResponses,
} from "./wire/responses.mjs"
export { relayStream, relayAnthropicStream } from "./relay-chat.mjs"
export { stripUnpinnedCalls, filterPinnedDelta, rewriteSSE } from "./sse.mjs"
export {
  relayResponsesStream,
  relayChatAsResponsesStream,
  relayResponsesPassthrough,
  withStreamUsage,
  responsesRequest,
  normalizeEffort,
  responsesReasoning,
} from "./relay-responses.mjs"
export {
  fetchModels,
  syncModels,
  rateLimitFor,
  scheduleSync,
  refreshUA,
  scheduleUA,
  probeAuthHeader,
} from "./sync.mjs"
export { handleChat, handleMessages } from "./routes/inference.mjs"
export {
  handleModels,
  handleApiConfig,
  handleApiKeys,
  handleStatus,
  handleTest,
  handleLogs,
} from "./routes/admin.mjs"
export { router } from "./router.mjs"
export { startConfigWatch } from "./server.mjs"
