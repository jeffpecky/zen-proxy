// The proxy's own credential, for a self-host on a public address.
//
// The dashboard password (`adminPassword`) is not a client credential: it opens
// the UI and nothing else. Model calls authenticate with one of these keys —
// the same split 9router, OpenRouter and Zen itself use. A key is minted from
// the CSPRNG, stored only as its SHA-256, and revocable; several exist so a
// leaked one can be dropped without rotating the rest.
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

/**
 * Mint the proxy's key, replacing any existing one. The previous key stops
 * authenticating immediately.
 */
export function createApiKey(name = "") {
  const key = KEY_PREFIX + randomBytes(KEY_BYTES).toString("base64url")
  const entry = {
    id: randomBytes(6).toString("hex"),
    name: String(name || "").slice(0, 80),
    // The plaintext is kept so the dashboard can show and copy it, the way
    // OpenRouter/Zen show a key. Only for display: authentication still uses
    // `hash` below, so a config file that leaks still needs the key itself.
    key,
    hash: hashKey(key),
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  }
  // Exactly one key exists at a time: minting replaces whatever was there.
  // A second live key is a second way in that nobody remembers to revoke.
  saveConfig({ apiKeys: [entry] })
  return { key, entry }
}

/**
 * Replace the current key with a fresh one. Same thing as minting, named for
 * what the operator means: regenerate.
 */
export function regenerateApiKey(name = "") {
  const previous = config.apiKeys[0]?.id ?? null
  const out = createApiKey(name || config.apiKeys[0]?.name || "")
  return { ...out, replaced: previous }
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
 * Resolve a presented client key to its entry, or null. Constant-time over the
 * hash, so a wrong key cannot be found by timing.
 *
 * Only minted keys resolve: the dashboard password is NOT a client credential
 * and never authenticates a model call.
 */
export function resolveApiKey(presented) {
  const raw = String(presented ?? "").trim()
  if (!raw) return null
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

function loopbackBind() {
  const host = String(config.host ?? "").trim().toLowerCase()
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]"
}

/**
 * Does the DASHBOARD need a password? Only when one is set or the proxy is
 * reachable off this machine. A loopback dashboard stays open on purpose: it is
 * where the operator reads and copies the API key, and losing that behind a
 * generated password would be a worse first run than an open port on localhost.
 *
 * (Model calls have no such rule: a client key is always required — see
 * authForUpstream().)
 */
export function dashboardAuthRequired() {
  if (config.adminPassword) return true
  return !loopbackBind()
}

/**
 * Provision the credentials a first-time install needs, so the endpoint works
 * out of the box the way 9router's auto-provisioned "Default Key" does.
 *
 * One deliberate difference from 9router: it mints LAZILY, when the dashboard's
 * Endpoint page finds no keys (EndpointPageClient.js:259-271). This mints at
 * boot, because `zen-claude` starts the proxy and calls it immediately with no
 * dashboard visit in between — a lazy mint would leave that path with nothing
 * to present.
 *
 * Two DIFFERENT secrets, because they answer two different questions:
 *   - `adminPassword` opens the dashboard and `/api/*` (9router's role: a
 *     separate password + session, not an API key).
 *   - a minted `sk-…` in the hashed `apiKeys` list calls models (9router's
 *     `apiKeys` table gating `/v1/*`).
 * Neither authenticates the other's job. Returns whichever were created, or
 * null when both already exist.
 *
 * Runs on EVERY bind, loopback included: the key is the only way in — there is
 * no anonymous tier — so an install without one would be a proxy nobody can
 * call. It is also what the dashboard shows and copies.
 */
export function ensureDefaultKey() {
  const out = {}
  if (!config.adminPassword && !loopbackBind()) {
    // A password, not an API key: no `sk-` prefix, and never resolved by
    // resolveApiKey() — a bare random string can only open the dashboard.
    out.adminPassword = randomBytes(18).toString("base64url")
    saveConfig({ adminPassword: out.adminPassword })
  }
  if (!config.apiKeys.length) {
    const { key, entry } = createApiKey("Default Key")
    out.key = key
    out.entry = entry
  }
  return Object.keys(out).length ? out : null
}

export { hashKey, KEY_RE, KEY_PREFIX }
