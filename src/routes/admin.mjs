// Dashboard and admin routes, including their auth and origin guards.
import { authRequired, createApiKey, dashboardAuthRequired, listApiKeys, revokeApiKey } from "../apikeys.mjs"
// re-exported below for the router
import { loadShippedModels } from "../catalogs.mjs"
import { DEFAULT_CONFIG, config, isFallbackModelsPinned, maskKey, sanitize, saveConfig, setFallbackModelsPinned } from "../config.mjs"
import { MAX_LOG, log, logLines } from "../log.mjs"
import { ALLOWED, effectiveDefault, modelFormat } from "../model.mjs"
import { apiKeyHeader, authForUpstream, bearer, clientIp, ipOmit, json, readBody, safeEqual } from "../net.mjs"
import { SESSION_HEADERS, identityFor } from "../session.mjs"
import { observed, requestStats, syncState } from "../stats.mjs"
import { agentProbePayload, fetchModels, scheduleSync, scheduleUA, uaAutoState } from "../sync.mjs"
import { upstreamFetch } from "../tls.mjs"
import { num, textOf, toBool } from "../util.mjs"
import { anthropicError, anthropicSystemText } from "../wire/anthropic.mjs"


async function handleModels(req, res) {
  if (!adminAuth(req, res)) return
  const cache = await fetchModels()
  json(res, 200, { object: "list", data: cache.data, ok: cache.ok })
}


// The dashboard credential. Deliberately separate from the client API keys:
// an `sk-…` key is a model-call credential (same as 9router/OpenRouter/Zen
// keys) and must NOT log anyone into the UI — holding an inference key would
// otherwise be a config takeover on a shared deploy. Only `adminPassword`
// opens the dashboard and `/api/*`.
// A loopback install with nothing configured keeps the open dashboard it has
// always had; the moment auth is on, the password must be presented.
function adminAuth(req, res) {
  const presented = bearer(req) || apiKeyHeader(req)
  const password = String(config.adminPassword ?? "")
  if (password && safeEqual(presented, password)) return true
  if (dashboardAuthRequired()) {
    json(res, 401, { error: "unauthorized" })
    return false
  }
  return true
}


// The admin API changes the upstream the proxy forwards keys to, so a request
// that a web page could forge is a credential-exfiltration path, not just a
// config edit: a cross-origin `text/plain` POST (a "simple request", no
// preflight) would let any site point `upstream` at itself and then read the
// configured Zen key out of every subsequent Authorization header.
//
// Two cheap gates close that: a JSON content type (unforgeable cross-origin
// without a preflight this server never grants) and a same-origin check on
// Host/Origin (also covers DNS rebinding, where Origin and Host disagree).
// Requests with no Host header — raw sockets, HTTP/1.0 clients, the test
// harness — are not browser-driven and stay allowed.
function isLoopbackHost(host) {
  const name = String(host ?? "").trim().toLowerCase().replace(/:\d+$/, "").replace(/^\[|\]$/g, "")
  if (!name) return false
  if (name === "localhost" || name === "::1") return true
  if (/^127\./.test(name)) return true
  // The configured bind address is ours by definition, even if it is a LAN IP.
  return name === String(config.host ?? "").trim().toLowerCase()
}


function originAllowed(req) {
  const host = req.headers.host
  if (typeof host !== "string" || !host) return true
  const bind = String(config.host ?? "").trim().toLowerCase()
  // A server bound to every interface is deliberately reachable over the
  // network, so its Host cannot be constrained to loopback — but the Origin
  // cross-check below still has to hold.
  const bindAll = bind === "0.0.0.0" || bind === "::" || bind === "[::]"
  if (!isLoopbackHost(host) && !bindAll) return false
  const origin = req.headers.origin
  if (typeof origin !== "string" || !origin) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}


// Applied to every mutating /api/* route. Returns true when the caller may
// proceed; otherwise it answers and the handler returns.
function adminWriteGuard(req, res) {
  if (req.method === "GET" || req.method === "HEAD") return true
  if (!originAllowed(req)) {
    json(res, 403, { error: "cross-origin admin request refused" })
    return false
  }
  const ct = String(req.headers["content-type"] ?? "").toLowerCase()
  if (!ct.includes("application/json")) {
    json(res, 415, { error: "content-type must be application/json" })
    return false
  }
  return true
}


async function handleApiConfig(req, res) {
  if (!adminAuth(req, res)) return
  if (!adminWriteGuard(req, res)) return
  if (req.method === "GET") return json(res, 200, { config: sanitize(config) })
  if (req.method === "POST") {
    // Stop following a pinned list and go back to tracking models.json, so this
    // install sees every catalog refresh from now on. Any hand-added models are
    // dropped — that is what "restore defaults" means. User keys are untouched.
    try {
      const body = await readBody(req)
      const parsed = body ? JSON.parse(body) : {}
      if (parsed.fallbackModels !== true) return json(res, 400, { error: "unsupported action" })
      saveConfig({ fallbackModels: undefined })
      scheduleSync()
      log(`model list restored — now following models.json (${config.fallbackModels.length} models)`)
      return json(res, 200, { ok: true, config: sanitize(config) })
    } catch (err) {
      return json(res, 400, { error: err.message })
    }
  }
  if (req.method === "PUT") {
    try {
      const body = JSON.parse(await readBody(req))
      if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("body must be a JSON object")
      const cleaned = {}
      for (const key of Object.keys(DEFAULT_CONFIG)) {
        // apiKeys is managed only through /api/keys. A dashboard round-trip
        // echoes the config back with the hashes stripped by sanitize(), so
        // accepting it here would erase every stored key.
        if (key === "apiKeys") continue
        if (key in body) cleaned[key] = body[key]
      }
      cleaned.port = num(cleaned.port ?? config.port, config.port)
      cleaned.timeoutMs = num(cleaned.timeoutMs ?? config.timeoutMs, config.timeoutMs)
      cleaned.cacheMs = num(cleaned.cacheMs ?? config.cacheMs, config.cacheMs)
      cleaned.autoSyncIntervalMs = num(cleaned.autoSyncIntervalMs ?? config.autoSyncIntervalMs, config.autoSyncIntervalMs)
      cleaned.uaRefreshMs = num(cleaned.uaRefreshMs ?? config.uaRefreshMs, config.uaRefreshMs)
      cleaned.rateLimitMax = num(cleaned.rateLimitMax ?? config.rateLimitMax, config.rateLimitMax)
      cleaned.rateLimitWindowMs = num(cleaned.rateLimitWindowMs ?? config.rateLimitWindowMs, config.rateLimitWindowMs)
      if (cleaned.rateLimitMax < 0) cleaned.rateLimitMax = 0
      if (cleaned.rateLimitWindowMs <= 0) cleaned.rateLimitWindowMs = config.rateLimitWindowMs
      if (cleaned.cacheMs < 0) cleaned.cacheMs = config.cacheMs
      cleaned.trustForwarded = toBool(cleaned.trustForwarded, config.trustForwarded)
      cleaned.autoSync = toBool(cleaned.autoSync, config.autoSync)
      cleaned.autoUA = toBool(cleaned.autoUA, config.autoUA)
      cleaned.injectSession = toBool(cleaned.injectSession, config.injectSession)
      cleaned.proxyStrict = toBool(cleaned.proxyStrict, config.proxyStrict)
      cleaned.requireApiKey = toBool(cleaned.requireApiKey, config.requireApiKey)
      if (!Array.isArray(cleaned.proxyUrls)) cleaned.proxyUrls = config.proxyUrls
      else cleaned.proxyUrls = cleaned.proxyUrls.filter((u) => typeof u === "string" && u.trim())
      if (cleaned.adminPassword === "••••••••") cleaned.adminPassword = config.adminPassword
      if (cleaned.probeAuth != null && !["auto", "key", "anonymous"].includes(String(cleaned.probeAuth))) {
        cleaned.probeAuth = "auto"
      }
      if (cleaned.defaultZenKey === sanitize({ defaultZenKey: config.defaultZenKey }).defaultZenKey) {
        cleaned.defaultZenKey = config.defaultZenKey
      }
      if (!Array.isArray(cleaned.fallbackModels)) {
        cleaned.fallbackModels = config.fallbackModels
      } else {
        // Any dashboard save used to pin the catalog forever, because the
        // dashboard PUTs the whole config it just read back — the model list
        // included — even when the user only changed a port. Pin only when the
        // submitted list actually differs from the catalog the install is
        // following; an unchanged list keeps tracking models.json.
        const submitted = cleaned.fallbackModels.filter((m) => typeof m === "string")
        const shipped = loadShippedModels()
        const sameAsCatalog =
          submitted.length === shipped.length && submitted.every((m, i) => m === shipped[i])
        if (sameAsCatalog) {
          cleaned.fallbackModels = undefined
          setFallbackModelsPinned(false)
        } else {
          setFallbackModelsPinned(true)
        }
      }
      if (!Array.isArray(cleaned.responsesModels)) cleaned.responsesModels = config.responsesModels
      if (typeof cleaned.modelAliases !== "object" || cleaned.modelAliases === null) {
        cleaned.modelAliases = config.modelAliases
      }
      saveConfig(cleaned)
      scheduleSync()
      scheduleUA()
      log("config updated via UI")
      return json(res, 200, { config: sanitize(config) })
    } catch (err) {
      if (err && err.statusCode === 413) {
        return json(res, 413, { error: { type: "invalid_request_error", message: "request body too large" } })
      }
      return json(res, 400, { error: err.message })
    }
  }
  return json(res, 405, { error: "method not allowed" })
}


// ---- key management --------------------------------------------------------
// Same lifecycle as 9router's /api/keys: list, mint, revoke. The difference is
// that only the hash is kept, so the plaintext appears exactly once in the
// mint response and never again.
async function handleApiKeys(req, res) {
  if (!adminAuth(req, res)) return
  if (req.method === "GET") return json(res, 200, { keys: listApiKeys(), authRequired: authRequired() })
  // DELETE is not a "simple request" (no preflighted cross-origin page can send
  // one), so it needs the origin check but not the JSON content-type gate.
  if (req.method === "DELETE") {
    if (!originAllowed(req)) return json(res, 403, { error: "cross-origin admin request refused" })
  } else if (!adminWriteGuard(req, res)) return
  if (req.method === "POST") {
    let name = ""
    try {
      const body = await readBody(req)
      name = String((body ? JSON.parse(body) : {}).name ?? "").slice(0, 80)
    } catch {
      return json(res, 400, { error: "invalid JSON body" })
    }
    const { key, entry } = createApiKey(name)
    log(`api key created: ${entry.name || entry.id}`)
    // 201 with the plaintext — the only time it is ever returned.
    return json(res, 201, { key, id: entry.id, name: entry.name, createdAt: entry.createdAt })
  }
  if (req.method === "DELETE") {
    const id = new URL(req.url, "http://x").searchParams.get("id") || ""
    if (!id) return json(res, 400, { error: "id is required" })
    if (!revokeApiKey(id)) return json(res, 404, { error: "no such key" })
    log(`api key revoked: ${id}`)
    return json(res, 200, { ok: true, keys: listApiKeys() })
  }
  return json(res, 405, { error: "method not allowed" })
}


async function handleStatus(req, res) {
  if (!adminAuth(req, res)) return
  const cache = await fetchModels()
  const now = Date.now()
  while (requestStats.window60.length && requestStats.window60[0] < now - 60_000) requestStats.window60.shift()
  const minute = Math.floor(now / 60000)
  const lastMinute = requestStats.window60.length
  let last5m = 0
  for (const [m, c] of requestStats.perMinute) {
    if (minute - m <= 5) last5m += c
  }
  const authMode = config.defaultZenKey ? (config.apiKeys.length ? "key+byok" : "byok") : config.apiKeys.length ? "key" : "public"
  json(res, 200, {
    uptime: Math.floor(process.uptime()),
    upstreamOk: cache.ok,
    upstream: config.upstream,
    ua: config.ua,
    uaAutoVersion: uaAutoState.version,
    defaultModel: config.defaultModel,
    effectiveDefault: effectiveDefault(),
    auth: { mode: authMode, zenKey: maskKey(config.defaultZenKey), adminPassword: !!config.adminPassword, apiKeys: config.apiKeys.length, required: authRequired() },
    responsesModels: [...(config.responsesModels ?? [])],
    rateLimit: { max: config.rateLimitMax, windowMs: config.rateLimitWindowMs },
    probeAuth: config.probeAuth ?? "auto",
    models: {
      total: cache.data.length,
      allowed: ALLOWED().size,
      // false = following models.json, so catalog refreshes apply automatically.
      // true = this install owns its own list.
      followsCatalog: !isFallbackModelsPinned(),
      served: cache.data.map((m) => m.id),
    },
    sync: {
      ok: syncState.ok,
      at: syncState.at,
      running: syncState.running,
      ms: syncState.ms,
      working: [...syncState.working],
      rateLimited: [...syncState.rateLimited],
      gated: [...syncState.gated],
      flaky: [...syncState.flaky],
      dead: [...syncState.dead],
      // Health learned from real client requests — the only reliable signal for
      // models the free tier hides from the synthetic probe.
      observed: Object.fromEntries(observed),
      error: syncState.error,
    },
    requests: { total: requestStats.total, errors: requestStats.errors, lastMinute, last5m },
    recent: requestStats.recent.map(([k, count, ms]) => ({ ...parseKey(k), count, ms })),
  })
}


function parseKey(key) {
  const [at, model, status] = key.split("|")
  return { at: Number(at), model, status: Number(status) }
}


async function handleTest(req, res) {
  if (!adminAuth(req, res)) return
  try {
    const body = JSON.parse(await readBody(req))
    const model = String(body.model ?? effectiveDefault())
    const start = Date.now()
    // Explicit key override lets the dashboard "test my key" flow verify a typed
    // key before saving it. Falls back to the normal auth path otherwise.
    const auth =
      typeof body.zenKey === "string" && body.zenKey.trim()
        ? `Bearer ${body.zenKey.trim()}`
        : (authForUpstream(req) ?? "Bearer public")
    const format = modelFormat(model)
    const upstreamRes = await upstreamFetch(`${config.upstream}${format === "responses" ? "/responses" : "/chat/completions"}`, {
      method: "POST",
      headers: (() => {
        const h = {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: auth,
          "user-agent": config.ua,
        }
        const identity = identityFor(req)
        // Same identity pair the request path sends, so TEST reports what a
        // real client with these headers would see (v2 parity, project included).
        if (!identity.injected || config.injectSession) {
          for (const name of SESSION_HEADERS) h[name] = identity.session
          h["x-session-affinity"] = identity.session
          h["x-session-id"] = identity.session
        }
        h["x-opencode-client"] = config.clientName
        h["x-opencode-project"] = identity.project
        // clientIp(), not the raw socket: behind a reverse proxy the socket is
        // the proxy's and TEST used to report a different caller IP than the
        // request path reported for the same client (and, with trustForwarded
        // on, the wrong one entirely).
        const ip = clientIp(req)
        if (!ipOmit(ip)) h["x-real-ip"] = ip
        return h
      })(),
      // Same agent-shaped payload the sync probe sends, so TEST reports what a
      // real client would get instead of a gate refusal it never earned.
      body: JSON.stringify(agentProbePayload(model, format)),
      signal: AbortSignal.timeout(config.timeoutMs),
    })
    if (upstreamRes.ok) {
      try { await upstreamRes.body?.cancel() } catch {}
    }
    let detail = ""
    let gated = false
    try {
      const parsed = await upstreamRes.json()
      if (format === "responses") detail = parsed.error?.message ?? (typeof parsed.output_text === "string" ? parsed.output_text : "")
      else detail = parsed.error?.message ?? parsed.choices?.[0]?.message?.content ?? ""
      // A FreeTierError on an agent-shaped probe means the gate refused even the
      // shape a real client sends; flag it, but it still may not be the model's
      // fault, so it is reported as gated rather than broken.
      if (upstreamRes.status === 403 && /FreeTierError|free tier can only/i.test(detail)) gated = true
    } catch {}
    json(res, 200, {
      ok: upstreamRes.ok || gated,
      gated,
      model,
      format,
      status: upstreamRes.status,
      ms: Date.now() - start,
      detail: gated ? "the free-tier gate refused even an agent-shaped probe — real agent traffic may still get through" : detail,
    })
  } catch (err) {
    if (err && err.statusCode === 413) {
      return json(res, 413, { error: { type: "invalid_request_error", message: "request body too large" } })
    }
    json(res, 400, { ok: false, error: err.message })
  }
}


function handleLogs(req, res) {
  if (!adminAuth(req, res)) return
  // `?n=NaN` made `slice(-NaN)` return the whole array, and `?n=1e9` did the
  // same; clamp to what the ring buffer can hold so the query cannot ask for
  // more than exists (or surprise a caller with every line when it meant 100).
  const raw = new URL(req.url, "http://x").searchParams.get("n")
  const n = raw == null || raw === "" ? 200 : Math.floor(Number(raw))
  const limit = Number.isFinite(n) && n > 0 ? Math.min(n, MAX_LOG) : 200
  json(res, 200, { logs: logLines.slice(-limit) })
}


// Claude Code calls this before a session to size the context window. The real
// Anthropic API tokenises server-side; we approximate from character count,
// which is only used for a progress percentage.
async function handleCountTokens(req, res) {
  // Same credential as the inference routes. It costs no upstream quota, but an
  // unauthenticated route on a keyed proxy is still a free oracle for anyone who
  // can reach the port; a request that would be refused on /v1/messages must
  // not be answered here.
  if (!authForUpstream(req)) {
    const e = anthropicError(401, { error: { type: "authentication_error", message: "invalid proxy key" } })
    return json(res, e.status, e.body)
  }
  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    const e = anthropicError(400, { error: { type: "invalid_request_error", message: "invalid JSON body" } })
    return json(res, e.status, e.body)
  }
  const text = anthropicSystemText(body?.system) + "\n" + (Array.isArray(body?.messages) ? body.messages.map((m) => textOf(m?.content)).join("\n") : "")
  // ~4 characters per token is the usual rule of thumb for English + code.
  const input_tokens = Math.max(1, Math.ceil(text.length / 4))
  return json(res, 200, { input_tokens })
}

export {
  handleModels,
  adminAuth,
  isLoopbackHost,
  originAllowed,
  adminWriteGuard,
  handleApiConfig,
  handleApiKeys,
  handleStatus,
  parseKey,
  handleTest,
  handleLogs,
  handleCountTokens,
}
