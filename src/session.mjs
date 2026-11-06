// Session identity: minting ids in opencode's format, translating a caller's
// id into one, and the per-bucket pool that a 429 rotates.
import { randomBytes, createHash } from "node:crypto"
import { config } from "./config.mjs"
import { clientIp, ipOmit } from "./net.mjs"
import { advanceProxy, lastProxyUrl, resetTlsSession } from "./tls.mjs"


// opencode's free tier requires every request to carry session identity: upstream
// returns 400 `MissingSessionID` with no session header, and 403 `FreeTierError`
// when only one of the pair is present. The real CLI sends BOTH headers with the
// same value, so we mint stable per-client session IDs and inject both.
// Generic agents send neither, which is why the proxy has to add them.
//
// The ID itself has to look like a real one. Upstream decodes the leading 12 hex
// characters as a creation timestamp and rejects IDs that do not carry a plausible
// one (`403 FreeTierError`, the same error as a missing header), so a naive
// `ses_<random hex>` is refused. This mirrors the generator opencode itself uses:
// `ses_` + 12 hex digits of ~(ms * 0x1000 + counter) + 14 random base62 chars.
// The trailing characters are random and not checked; the leading 12 are.
const SESSION_HEADERS = ["x-opencode-session", "x-opencode-session-id"]

const SESSION_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

// A session stays valid as long as its embedded timestamp is recent. Re-mint on a
// schedule so a proxy left running for days does not start failing on a stale ID.
const SESSION_MAX_AGE_MS = 30 * 60_000

let sessionClock = { ms: 0, ctr: 0 }

// What a real session id looks like. Upstream decodes the leading 12 hex as a
// creation timestamp and refuses anything else, so a caller-supplied id that
// does not match this shape must never be forwarded verbatim (9router validates
// with the same regex, opencode.js:27).
const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/

function genSessionId(now = Date.now()) {
  if (now !== sessionClock.ms) {
    sessionClock.ms = now
    sessionClock.ctr = 0
  }
  sessionClock.ctr++
  const stamp = BigInt(now) * 0x1000n + BigInt(sessionClock.ctr)
  const masked = ~stamp
  const hex = Array.from({ length: 6 }, (_, i) => Number(masked >> BigInt(40 - 8 * i) & 0xffn).toString(16).padStart(2, "0")).join("")
  const tail = Array.from(randomBytes(14), (b) => SESSION_ALPHABET[b % 62]).join("")
  return { value: "ses_" + hex + tail, at: now }
}

// A caller's own session id: an id already in the CLI's shape is forwarded
// untouched, anything else (a UUID from a generic client, a placeholder) is
// translated deterministically per (session, tool, epoch) so one conversation
// keeps one stable upstream identity across turns. Digest-derived timestamps
// were measured to pass only 1/10 while Date.now() passed 10/10, so the
// translation mints with the current clock and memoizes instead of deriving the
// time field (9router arrived at the same conclusion, opencode.js:73-78).
//
// The epoch is what makes a 429 able to move a translated id: a memo hit would
// otherwise hand the SAME refused session back to every retry, while a valid
// native id is left alone (9router rotates only the ids it minted itself,
// opencode.js:171-185).
const translatedSessions = new Map()

const MAX_TRANSLATED_SESSIONS = 5000

// One counter per caller bucket, bumped by a 429. Small enough that a bucket
// that saw many 429s does not leak entries.
const sessionEpochs = new Map()

const MAX_SESSION_EPOCHS = 1000

function sessionEpoch(key) {
  const entry = sessionEpochs.get(key)
  return entry ? entry.epoch : 0
}

function bumpSessionEpoch(key) {
  const current = sessionEpochs.get(key)
  sessionEpochs.delete(key)
  sessionEpochs.set(key, { epoch: (current?.epoch || 0) + 1 })
  for (const oldest of sessionEpochs.keys()) {
    if (sessionEpochs.size <= MAX_SESSION_EPOCHS) break
    sessionEpochs.delete(oldest)
  }
}

function translateSessionId(sessionId, clientTool = "", epoch = 0) {
  const raw = String(sessionId ?? "").trim()
  if (OPENCODE_SESSION_RE.test(raw)) return raw
  const key = `${clientTool || "generic"}\0${epoch}\0${raw}`
  const hit = translatedSessions.get(key)
  if (hit && Date.now() - hit.at < SESSION_MAX_AGE_MS) return hit.value
  const minted = genSessionId()
  if (translatedSessions.size >= MAX_TRANSLATED_SESSIONS) {
    translatedSessions.delete(translatedSessions.keys().next().value)
  }
  translatedSessions.set(key, minted)
  return minted.value
}

function sessionFor(req) {
  const identity = identityFor(req)
  return { value: identity.session, injected: identity.injected }
}

// One identity pair per caller bucket, minted together and rotated together:
// a session id and its project hash describe the same "one CLI conversation in
// one project directory" to upstream, so they must never be split across
// mints. Runtimes differ here only in what the caller already carries: a
// caller-supplied session (a real OpenCode client riding the proxy) is passed
// through untouched, and a configured `projectHash` pins the project half
// while sessions keep rotating on the usual schedule.
const IDENTITY_POOL_MAX = 2000

function identityBucketKey(req) {
  const ip = req ? (ipOmit(clientIp(req)) ? "local" : clientIp(req)) : "server"
  return `${ip}\n${uaFingerprint(req)}`
}

// The caller's user-agent reduces to a stable family: versions change with
// every CLI release (and must not fragment an identity), but two different
// agents on one machine still land in different buckets.
function uaFingerprint(req) {
  const ua = String(req?.headers?.["user-agent"] ?? "").trim().toLowerCase()
  if (!ua) return "anon"
  return `${ua.replace(/v?\d[\w.+-]*/g, "v").replace(/\s+/g, " ").slice(0, 80)}`
}

// The project half mirrors the CLI derivation for a one-off workspace:
// sha1("directory:<path>") with an unpredictable path, so the value is
// indistinguishable on the wire from a real client's stale project hash.
function genProjectHash() {
  return createHash("sha1").update(`directory:${randomBytes(18).toString("hex")}`).digest("hex")
}

const identityPool = new Map()

function mintedIdentity(req, now) {
  const key = identityBucketKey(req)
  const hit = identityPool.get(key)
  if (hit && now - hit.at < SESSION_MAX_AGE_MS) {
    // Re-insert on hit so the map stays in least-recently-used order.
    identityPool.delete(key)
    identityPool.set(key, hit)
    return hit
  }
  const fresh = { ...genSessionId(now), project: genProjectHash() }
  identityPool.delete(key)
  identityPool.set(key, fresh)
  // The pool is LRU-ordered now, so eviction is "drop from the front" instead
  // of a full sort/scan of up to IDENTITY_POOL_MAX entries on every mint.
  for (const oldest of identityPool.keys()) {
    if (identityPool.size <= IDENTITY_POOL_MAX) break
    identityPool.delete(oldest)
  }
  return fresh
}

function identityFor(req, now = Date.now()) {
  const incoming = req?.headers?.["x-opencode-session"]
  if (typeof incoming === "string" && incoming.trim()) {
    const callerProject = req?.headers?.["x-opencode-project"]
    return {
      // Validated, not trusted: a caller's UUID or placeholder would be refused
      // upstream (the prefix decodes as a timestamp), so an off-shape id is
      // translated deterministically instead of forwarded. The epoch moves the
      // memo after a 429 so a translated id can rotate; a caller's own valid id
      // is returned untouched and therefore never rotates behind its back.
      session: translateSessionId(incoming, uaFingerprint(req), sessionEpoch(identityBucketKey(req))),
      injected: false,
      project:
        typeof callerProject === "string" && callerProject.trim()
          ? callerProject.trim()
          : config.projectHash || projectHash(),
    }
  }
  if (config.projectHash) {
    return { session: mintedIdentity(req, now).value, injected: true, project: config.projectHash }
  }
  const minted = mintedIdentity(req, now)
  return { session: minted.value, injected: true, project: minted.project }
}

// A 429 from this gateway is not "your quota is spent" as often as it is "this
// egress flow is in a drained bucket": upstream keys the free tier on the TLS
// connection's exit, and the session id rides inside that connection. Rotating
// the minted identity alone therefore changes nothing — the next request reuses
// the wreq keep-alive socket. The retry ladder drops all three together:
// forget the identity, close that egress's TLS session, and step the proxy
// cursor to the next exit IP. A single-entry proxy list (or none) can only
// manage the first two; the boot log says so.
function rotateEgress(req) {
  // A caller that brought its own session keeps it — rewriting another
  // client's identity is not ours to do. That holds only for an id already in
  // the CLI's shape: an off-shape caller id was translated by us, so it is ours
  // to rotate, and leaving it memoized would retry the exact session that was
  // just refused. The transport half rotates either way.
  const incoming = req?.headers?.["x-opencode-session"]
  if (typeof incoming === "string" && incoming.trim()) {
    if (!OPENCODE_SESSION_RE.test(incoming.trim())) bumpSessionEpoch(identityBucketKey(req))
  } else {
    identityPool.delete(identityBucketKey(req))
  }
  resetTlsSession(lastProxyUrl)
  return advanceProxy()
}

function projectHash() {
  if (config.projectHash) return config.projectHash
  if (!cachedProjectHash) cachedProjectHash = createHash("sha1").update(`directory:${process.cwd()}`).digest("hex")
  return cachedProjectHash
}


// Project identity mirrors opencode's own derivation for a non-VCS directory:
// sha1("directory:<resolved path>") — one stable value per proxy install.
let cachedProjectHash = ""

export {
  SESSION_HEADERS,
  SESSION_ALPHABET,
  SESSION_MAX_AGE_MS,
  sessionClock,
  OPENCODE_SESSION_RE,
  genSessionId,
  translatedSessions,
  MAX_TRANSLATED_SESSIONS,
  sessionEpochs,
  MAX_SESSION_EPOCHS,
  sessionEpoch,
  bumpSessionEpoch,
  translateSessionId,
  sessionFor,
  IDENTITY_POOL_MAX,
  identityBucketKey,
  uaFingerprint,
  genProjectHash,
  identityPool,
  mintedIdentity,
  identityFor,
  rotateEgress,
  projectHash,
  cachedProjectHash,
}
