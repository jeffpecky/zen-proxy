// Upstream TLS transport: wreq-js impersonating Bun's ClientHello, one pooled
// session per egress, and the egress round-robin the 429 ladder steps through.
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { config } from "./config.mjs"
import { log } from "./log.mjs"
import { ENV } from "./util.mjs"

const __dirname = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../")


// ---- upstream TLS transport ------------------------------------------------
// The free-tier gate keys on the TLS ClientHello, not on headers or bodies:
// one process, one egress IP, one body — 200 under Bun's BoringSSL fetch and
// `429 FreeUsageLimitError` under Node's OpenSSL, in the same second. So the
// proxy's own TLS stack decides the verdict before any of this file's header
// and prompt work is even read.
//
// wreq-js is that transport: BoringSSL in-process, with the profile pinned to
// what Bun 1.3.14 actually sends (captured 2026-10-27 against tls.peet.ws:
// ja4 t13d1714h1_5b57614c22b0_43ade6aba3df, ja3 d871d02cecbde59abbf8f4806134addf).
// Only the cipher-list hash is compared upstream, so the list must stay
// verbatim and in order. ALPN is http/1.1-only because Bun's fetch is; the two
// extensions below are what wreq omits by default and Bun sends. It is the one
// transport for every opencode.ai call (inference, probes, catalog) — a native
// fetch next to it would be the request the gate 429s.
//
// Loaded lazily and optionally: a checkout without the addon still boots, says
// so once, and falls back to the native fetch (which is expected to be refused
// on the free tier). `ZEN_TLS=0` forces the fallback, which is how the tests
// keep their stubbed globalThis.fetch.
const OPENCODE_CIPHERS = [
  "TLS_AES_128_GCM_SHA256",
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256",
  "ECDHE-ECDSA-AES128-GCM-SHA256",
  "ECDHE-RSA-AES128-GCM-SHA256",
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-ECDSA-CHACHA20-POLY1305",
  "ECDHE-RSA-CHACHA20-POLY1305",
  "ECDHE-ECDSA-AES128-SHA",
  "ECDHE-RSA-AES128-SHA",
  "ECDHE-ECDSA-AES256-SHA",
  "ECDHE-RSA-AES256-SHA",
  "AES128-GCM-SHA256",
  "AES256-GCM-SHA384",
  "AES128-SHA",
  "AES256-SHA",
].join(":")

const OPENCODE_TLS_PROFILE = {
  cipherList: OPENCODE_CIPHERS,
  alpnProtocols: ["HTTP1"],
  curvesList: "X25519:P-256:P-384",
  enableOcspStapling: true,
  enableSignedCertTimestamps: true,
}

const TLS_ENABLED = ENV.ZEN_TLS !== "0"


let wreqPromise = null

// Resolution order: an explicit path (ZEN_PROXY_WREQ), the install dir's
// node_modules, this machine's global node_modules. Same fallback a `require`
// from a script in the install tree would get, minus the package.json games.
async function loadWreq() {
  if (!wreqPromise) {
    wreqPromise = (async () => {
      const explicit = ENV.ZEN_PROXY_WREQ
      const specs = explicit ? [path.isAbsolute(explicit) || explicit.startsWith("file:") ? pathToFileURL(explicit).href : explicit] : ["wreq-js"]
      for (const spec of specs) {
        try {
          return await import(spec)
        } catch {}
      }
      for (const base of [path.join(__dirname, "package.json"), path.join(process.cwd(), "package.json")]) {
        try {
          return await import(pathToFileURL(createRequire(base).resolve("wreq-js")).href)
        } catch {}
      }
      throw new Error(`wreq-js not found — npm i wreq-js (or set ZEN_PROXY_WREQ), or ZEN_TLS=0 to run on node's TLS`)
    })().catch((err) => {
      wreqPromise = null
      throw err
    })
  }
  return wreqPromise
}


// Sessions are keyed by proxy URL, exactly as 9router does: wreq's `proxy` is
// session-scoped, so one session per egress keeps its connection pool and TLS
// session tickets on that egress instead of thrashing them across pool members.
// "direct" is the no-proxy key. LRU-capped; eviction closes the pool slot.
const DIRECT_KEY = "direct"

const MAX_TLS_SESSIONS = 32

const tlsSessions = new Map()

let tlsWarned = false


function proxyKey(proxyUrl) {
  return String(proxyUrl || DIRECT_KEY)
}


// Proxy URLs may carry user:pass — never let credentials into a log line.
function maskProxyUrl(proxyUrl) {
  try {
    const u = new URL(proxyUrl)
    return `${u.protocol}//${u.hostname}${u.port ? ":" + u.port : ""}`
  } catch {
    return proxyUrl
  }
}


// The configured egress list. Empty = direct (the behaviour before proxies).
// One entry is still worth having: it is the only way a 429 can land on a
// different exit IP, since a fresh socket to the same IP is the same bucket.
let proxyCursor = 0

function proxyList() {
  return Array.isArray(config.proxyUrls) ? config.proxyUrls.filter((u) => typeof u === "string" && u.trim()) : []
}

// Round-robin by default (a pool with N members should spread load), unless a
// caller pins one.
function pickProxy() {
  const list = proxyList()
  if (!list.length) return null
  return list[proxyCursor++ % list.length]
}

// A 429 means this egress is drained: move the cursor past it before the retry
// so the next attempt cannot land on the same bucket. A single-entry list has
// nowhere else to go — the caller is told that at boot.
function advanceProxy() {
  const list = proxyList()
  if (!list.length) return null
  proxyCursor++
  return list[proxyCursor % list.length]
}


async function tlsSessionGet(proxyUrl) {
  const key = proxyKey(proxyUrl)
  const cached = tlsSessions.get(key)
  if (cached) {
    // LRU touch.
    tlsSessions.delete(key)
    tlsSessions.set(key, cached)
    return cached
  }
  const wreq = await loadWreq()
  if (typeof wreq.createSession !== "function") throw new Error("wreq-js has no createSession")
  const pending = wreq.createSession({
    // alpnProtocols is copied: a mutating build must not poison the const.
    emulation: { tlsOptions: { ...OPENCODE_TLS_PROFILE, alpnProtocols: [...OPENCODE_TLS_PROFILE.alpnProtocols] } },
    ...(key === DIRECT_KEY ? {} : { proxy: key }),
  }).catch((err) => {
    // Only evict our own entry: a concurrent reset may have replaced it, and
    // deleting that one would close a pool slot someone else is using.
    if (tlsSessions.get(key) === pending) tlsSessions.delete(key)
    throw err
  })
  tlsSessions.set(key, pending)
  while (tlsSessions.size > MAX_TLS_SESSIONS) {
    const oldest = tlsSessions.keys().next().value
    const evicted = tlsSessions.get(oldest)
    tlsSessions.delete(oldest)
    evicted.then((s) => s.close?.()).catch(() => {})
  }
  return pending
}

/**
 * Close and forget cached connections. With `proxyUrl`, only that egress —
 * the one a 429 condemned. Without it, every egress (ZEN_TLS reload, shutdown).
 */

function resetTlsSession(proxyUrl) {
  if (proxyUrl === undefined) {
    const all = [...tlsSessions.values()]
    tlsSessions.clear()
    for (const p of all) p.then((s) => s.close?.()).catch(() => {})
    return
  }
  const key = proxyKey(proxyUrl)
  const pending = tlsSessions.get(key)
  tlsSessions.delete(key)
  if (pending) pending.then((s) => s.close?.()).catch(() => {})
}

/**
 * Fetch through the impersonated-TLS session. Returns a native Response so the
 * relays' `.body.getReader()` / `for await` paths work unchanged and the body
 * stays a live stream, never buffered. `timeout: 0` for streams: the handler's
 * own walls own that deadline, and wreq's timeout spans the whole body.
 */

async function tlsFetch(url, init = {}, proxyUrl = null) {
  const session = await tlsSessionGet(proxyUrl)
  const { signal, timeout, ...rest } = init
  const res = await session.fetch(url, {
    ...rest,
    timeout: timeout ?? 0,
    ...(signal ? { signal } : {}),
  })
  const headers = {}
  res.headers?.forEach?.((value, key) => {
    headers[key] = value
  })
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

/**
 * The single way upstream opencode.ai is reached. Every route, probe and sync
 * call goes through here — one transport, one connection model, one place to
 * rotate from. Returns the proxy the call actually used so a 429 handler knows
 * which egress to condemn.
 */

let lastProxyUrl = null

async function upstreamFetch(url, init = {}) {
  if (!TLS_ENABLED) return fetch(url, init)
  const proxyUrl = pickProxy()
  lastProxyUrl = proxyUrl
  try {
    return await tlsFetch(url, init, proxyUrl)
  } catch (err) {
    // strictProxy semantics, as 9router's proxyFetch has them: a proxy that was
    // *intended* but failed must not be replayed over the real IP. Refusing is
    // the point — the direct IP may be one the operator is deliberately keeping
    // off this endpoint. With nothing configured there is nothing to be strict
    // about, so the plain fallback stays.
    if (config.proxyStrict && proxyUrl) {
      throw new Error(`proxy required but failed (strictProxy): ${maskProxyUrl(proxyUrl)} — ${err?.message ?? err}`)
    }
    if (!tlsWarned) {
      tlsWarned = true
      log(`⚠  TLS transport unavailable (${err?.message ?? err}) — falling back to native fetch,`)
      log("   which the free tier refuses with 429 unless a Zen key is configured.")
    }
    return fetch(url, init)
  }
}

export {
  OPENCODE_CIPHERS,
  OPENCODE_TLS_PROFILE,
  TLS_ENABLED,
  wreqPromise,
  loadWreq,
  DIRECT_KEY,
  MAX_TLS_SESSIONS,
  tlsSessions,
  tlsWarned,
  proxyKey,
  maskProxyUrl,
  proxyCursor,
  proxyList,
  pickProxy,
  advanceProxy,
  tlsSessionGet,
  resetTlsSession,
  tlsFetch,
  lastProxyUrl,
  upstreamFetch,
}
