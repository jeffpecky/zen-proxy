// The proxy's own credential, for a self-host on a public address.
//
// `proxyKey` on its own is a single shared secret: fine on localhost, but a
// public VPS with nothing configured is an open relay, and a hand-typed
// `proxyKey` is guessable (a 429 every try, but still). This mints a key from
// the CSPRNG, stores only its SHA-256, and lets the operator revoke it. Still
// one user — several keys exist so a leaked one can be dropped without
// rotating the rest.
//
// Format: `sk-` + 43 base64url chars (256 bits). Deliberately NOT the 9router
// scheme (`sk-{machineId}-{keyId}-{hmac8}`): its keyId comes from
// Math.random(), its CRC is a non-secret checksum over public inputs, and
// validating it needs the key in plaintext. A random key cannot be forged, and
// a leaked config or backup contains only hashes.
//
// Stored shape: { id, name, hash, createdAt, lastUsedAt }
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { config, saveConfig } from "./config.mjs"

const KEY_PREFIX = "sk-"
const KEY_BYTES = 32
// 32 bytes -> 43 base64url chars, no padding.
const KEY_RE = /^sk-[A-Za-z0-9_-]{43}$/

function hashKey(key) {
  return createHash("sha256").update(String(key)).digest("hex")
}

function safeEqualStr(a, b) {
  const ha = createHash("sha256").update(String(a ?? "")).digest()
  const hb = createHash("sha256").update(String(b ?? "")).digest()
  return timingSafeEqual(ha, hb)
}

/**
 * Mint a new key. Returns the plaintext ONCE — never written to disk in that
 * form, so it cannot be recovered; mint another instead.
 */
export function createApiKey(name = "") {
  const key = KEY_PREFIX + randomBytes(KEY_BYTES).toString("base64url")
  const entry = {
    id: randomBytes(6).toString("hex"),
    name: String(name || "").slice(0, 80),
    hash: hashKey(key),
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  }
  saveConfig({ apiKeys: [...config.apiKeys, entry] })
  return { key, entry }
}

export function revokeApiKey(id) {
  const apiKeys = config.apiKeys.filter((k) => k.id !== id)
  if (apiKeys.length === config.apiKeys.length) return false
  saveConfig({ apiKeys })
  return true
}

export function listApiKeys() {
  // Hashes stay internal: exposing one invites offline work on a leaked
  // config, and nothing needs it.
  return config.apiKeys.map(({ hash, ...rest }) => rest)
}

/**
 * Resolve a presented key to its entry, or null. Constant-time over the hash,
 * so a wrong key cannot be found by timing.
 *
 * A plaintext `proxyKey` also resolves, so an existing install keeps working.
 */
export function resolveApiKey(presented) {
  const raw = String(presented ?? "").trim()
  if (!raw) return null
  if (config.proxyKey && safeEqualStr(raw, config.proxyKey)) {
    return { id: "proxyKey", name: "proxyKey", legacy: true }
  }
  if (!KEY_RE.test(raw)) return null
  const digest = Buffer.from(hashKey(raw), "hex")
  for (const entry of config.apiKeys) {
    let stored
    try {
      stored = Buffer.from(String(entry.hash || ""), "hex")
    } catch {
      continue
    }
    if (stored.length !== digest.length) continue
    if (timingSafeEqual(digest, stored)) {
      try {
        entry.lastUsedAt = new Date().toISOString()
      } catch {}
      return entry
    }
  }
  return null
}

/**
 * Is auth required? Yes when any credential exists, when REQUIRE_API_KEY=1, or
 * when bound to a non-loopback address. Publishing an unauthenticated proxy to
 * a network is never the intent.
 */
export function authRequired() {
  if (config.proxyKey || config.apiKeys.length) return true
  if (config.requireApiKey) return true
  // Behind a reverse proxy the bind address is still loopback, so this cannot
  // be the only signal — REQUIRE_API_KEY covers that deploy.
  const host = String(config.host ?? "").trim().toLowerCase()
  return !(host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]")
}

/**
 * Mint the first credential for an install that has none, the way 9router
 * auto-provisions a "Default Key" so the endpoint works out of the box.
 *
 * Stored as `proxyKey` rather than in the hashed list on purpose: it is the one
 * key the operator must be able to read back (from the config file or the
 * dashboard) after the log scrolls away, and a hash cannot be shown again. The
 * file is 0600, and `apiKeys` remains the place for keys that are only ever
 * presented, never displayed.
 *
 * Only fires when auth is actually required — a loopback install with no
 * credentials keeps the anonymous tier it has always had.
 */
export function ensureDefaultKey() {
  if (!authRequired()) return null
  if (config.proxyKey || config.apiKeys.length) return null
  const key = KEY_PREFIX + randomBytes(KEY_BYTES).toString("base64url")
  saveConfig({ proxyKey: key })
  return key
}

export { hashKey, KEY_RE, KEY_PREFIX }
