// The one place a URL becomes a handler.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { config, uiHtml } from "./config.mjs"
import { json } from "./net.mjs"
import { adminAuth, adminWriteGuard, handleApiConfig, handleApiKeys, handleCountTokens, handleLogs, handleModels, handleStatus, handleTest } from "./routes/admin.mjs"
import { handleChat, handleMessages } from "./routes/inference.mjs"
import { requestStats, syncState } from "./stats.mjs"
import { modelsCache, rateLimitFor, syncModels } from "./sync.mjs"

const __dirname = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../")


async function router(req, res) {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`)
  // One trailing slash is tolerated on every route: SDKs and base URLs
  // regularly produce "/v1/chat/completions/" and the exact match used to 404
  // it with no hint about the cause. The root stays "/", doubled slashes stay
  // a 404, and all-cases trimming is deliberate ("//v1//chat" is not ours).
  const p = url.pathname !== "/" && url.pathname.endsWith("/") ? url.pathname.replace(/\/+$/, "") : url.pathname

  if (req.method === "GET" && (p === "/" || p === "/index.html" || p === "/ui")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    return res.end(uiHtml || "<h1>UI not found</h1>")
  }
  if (req.method === "GET" && p.startsWith("/assets/")) {
    const file = path.join(__dirname, "assets", path.basename(p))
    try {
      const data = fs.readFileSync(file)
      const types = {
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".svg": "image/svg+xml", ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon",
      }
      res.writeHead(200, {
        "content-type": types[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        "cache-control": "public, max-age=3600",
      })
      return res.end(data)
    } catch {
      return json(res, 404, { error: "not found" })
    }
  }
  if ((req.method === "GET" || req.method === "HEAD") && p === "/health") {
    // Cache-only on purpose. /health is unauthenticated, and a fresh upstream
    // fetch per poll let any monitor (or anyone who can reach the port) drive
    // the proxy's upstream quota. It reports the last known state; the first
    // poll after startup may be "unknown", which a monitor reads as 200 with
    // ok:null rather than as a failure.
    const cache = modelsCache
    // Monitors (uptime pingers, container checks) probe with HEAD and inspect
    // only the status line; a HEAD reply carries no body by definition.
    if (req.method === "HEAD") return res.end()
    return json(res, 200, { ok: cache.at ? cache.ok : null, upstream: config.upstream, sync: syncState.at ? { at: syncState.at, ok: syncState.ok } : null })
  }

  if (p.startsWith("/api/")) {
    if (p === "/api/config") return handleApiConfig(req, res)
    if (p === "/api/keys") return handleApiKeys(req, res)
    if (p === "/api/status" && req.method === "GET") return handleStatus(req, res)
    if (p === "/api/logs" && req.method === "GET") return handleLogs(req, res)
    // Mutating admin routes go through the same origin/content-type gate, so a
    // browser cannot forge a config change or a sync either.
    if (p === "/api/test" && req.method === "POST") {
      if (!adminAuth(req, res) || !adminWriteGuard(req, res)) return
      return handleTest(req, res)
    }
    if (p === "/api/sync" && req.method === "POST") {
      if (!adminAuth(req, res) || !adminWriteGuard(req, res)) return
      syncModels().then((s) => json(res, 200, { ok: s.ok, ...s }))
      return
    }
    if (p === "/api/reset" && req.method === "POST") {
      if (!adminAuth(req, res) || !adminWriteGuard(req, res)) return
      requestStats.total = 0
      requestStats.errors = 0
      requestStats.recent = []
      requestStats.perMinute.clear()
      requestStats.window60 = []
      return json(res, 200, { ok: true })
    }
    return json(res, 404, { error: "not found" })
  }

  if (req.method === "GET" && (p === "/v1/models" || p === "/models")) return handleModels(req, res)
  const isInference = p === "/v1/chat/completions" || p === "/chat/completions" || p === "/v1/responses" || p === "/responses"
  const isMessages = p === "/v1/messages" || p === "/messages"
  if (req.method === "POST" && (isInference || isMessages)) {    // Throttle only the inference endpoints — the dashboard, /health and the
    // admin API must never be locked out by a client's burst.
    const rl = rateLimitFor(req)
    if (rl.limited) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": String(rl.retryAfter) })
      return res.end(
        JSON.stringify(
          isMessages
            ? { type: "error", error: { type: "rate_limit_error", message: `rate limit exceeded, retry in ${rl.retryAfter}s` } }
            : { error: { type: "rate_limit_error", message: `rate limit exceeded, retry in ${rl.retryAfter}s` } },
        ),
      )
    }
    return isMessages ? handleMessages(req, res) : handleChat(req, res, p === "/v1/responses" || p === "/responses")
  }
  if (req.method === "POST" && (p === "/v1/messages/count_tokens" || p === "/messages/count_tokens")) {
    return handleCountTokens(req, res)
  }
  json(res, 404, { error: { type: "not_found", message: p } })
}

export {
  router,
}
