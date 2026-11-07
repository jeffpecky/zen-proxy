// HTTP plumbing: the request body reader, JSON replies, client address
// resolution, and credential extraction.
import { createHash, timingSafeEqual } from "node:crypto"
import { resolveApiKey } from "./apikeys.mjs"
import { MAX_BODY, config } from "./config.mjs"


function clientIp(req) {
  if (config.trustForwarded) {
    const xff = req.headers["x-forwarded-for"]
    if (typeof xff === "string" && xff.trim()) return xff.split(",")[0].trim()
    const xri = req.headers["x-real-ip"]
    if (typeof xri === "string" && xri.trim()) return xri.trim()
  }
  return req.socket.remoteAddress ?? ""
}


function ipOmit(ip) {
  if (!ip) return true
  const v = ip.replace(/^::ffff:/, "").toLowerCase()
  if (v === "::1" || v === "localhost" || v === "127.0.0.1" || /^127\./.test(v)) return true
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(v)) return true
  if (/^fe80:/.test(v) || /^fc/.test(v) || /^fd/.test(v)) return true
  return false
}


function json(res, status, data) {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(data))
}


// Bodies arrive as Buffers, and `raw += chunk` decodes each chunk on its own.
// A multi-byte UTF-8 character straddling a TCP read boundary is split by that
// decode and comes back as U+FFFD — silent corruption of the user's prompt
// (measured with "héllo 😀 wörld" split inside `é`). Collect Buffers instead and
// decode once, so the decoder is free to hold an incomplete sequence until the
// rest arrives. The limit is likewise a byte ceiling (`maxBodyBytes`), not a
// UTF-16 code-unit count, which used to overshoot by up to 3x.
async function readBody(req, limit = maxBodyBytes()) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(typeof chunk === "string" ? chunk : String(chunk ?? ""))
    total += buf.length
    if (total > limit) {
      const err = new Error("request body too large")
      err.statusCode = 413
      throw err
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString("utf8")
}


// The configured ceiling wins when it is a positive number; 0/absent keeps the
// shipped default (see MAX_BODY).
function maxBodyBytes() {
  const n = Number(config.maxBodyBytes)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : MAX_BODY
}


function bearer(req) {
  const v = req.headers["authorization"]
  return typeof v === "string" && v.startsWith("Bearer ") ? v.slice(7).trim() : ""
}


// Constant-time comparison for secrets. Both sides are hashed first so the
// comparison is length-independent as well: timingSafeEqual throws on unequal
// lengths, and reading that error is itself an oracle.
function safeEqual(a, b) {
  const ha = createHash("sha256").update(String(a ?? "")).digest()
  const hb = createHash("sha256").update(String(b ?? "")).digest()
  return timingSafeEqual(ha, hb)
}


// The Anthropic SDK sends `x-api-key`, the OpenAI SDKs send `Authorization`.
// Both are named here once so the two routes cannot drift apart.
function apiKeyHeader(req) {
  const k = req.headers["x-api-key"]
  return typeof k === "string" ? k.trim() : ""
}


// The single place a request's upstream credential is decided. Both the
// Anthropic and the OpenAI-shaped routes call this, so a token can never be
// usable on one route and meaningless on the other.
//
// When auth is on the caller must present a client key — as a bearer token or
// as `x-api-key` — and that key is NEVER forwarded upstream: it is the proxy's
// own credential, and forwarding it would hand the secret to the free-tier
// gateway. The upstream credential then comes from `x-zen-key`,
// `defaultZenKey`, or the anonymous tier.
//
// With auth off the caller's own credential is forwarded: bearer first, then
// `x-api-key`, which is how an Anthropic-native client supplies a real Zen key.
//
// `x-zen-key` is honoured on every path: the docs promise a per-request Zen
// key and it used to be read only inside one branch, so setting it alone
// silently did nothing.
function zenKeyOverride(req) {
  const zen = req.headers["x-zen-key"]
  return typeof zen === "string" && zen.trim() && zen.trim() !== "public" ? `Bearer ${zen.trim()}` : null
}


function authForUpstream(req) {
  const incoming = bearer(req)
  const key = apiKeyHeader(req)
  const override = zenKeyOverride(req)

  // A minted client key is required on every call. The dashboard password is
  // not one: it opens /api/* and nothing else. A caller's own token is not one
  // either — it is never forwarded, so it identifies nobody.
  const resolved = resolveApiKey(incoming || key)
  if (!resolved) return null
  req._apiKey = resolved
  // Upstream sees the proxy's credential: a per-request x-zen-key, the
  // configured Zen key, or the anonymous tier.
  return override ?? (config.defaultZenKey ? `Bearer ${config.defaultZenKey}` : "Bearer public")
}

export {
  clientIp,
  ipOmit,
  json,
  readBody,
  maxBodyBytes,
  bearer,
  safeEqual,
  apiKeyHeader,
  zenKeyOverride,
  authForUpstream,
}
