// Config: defaults, the config file, and the live `config` binding the other
// modules read. ESM imports are live bindings, so a reload is visible everywhere.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { BAKED_MODELS, loadShippedModels } from "./catalogs.mjs"
import { log } from "./log.mjs"
import { DEFAULT_UPSTREAM, ENV, envJson, envNum, normalizeUpstream } from "./util.mjs"

const __dirname = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../")

const CONFIG_PATH = process.env.ZEN_PROXY_CONFIG || path.join(__dirname, "zen-proxy.json")

const UI_PATH = path.join(__dirname, "public", "index.html")


// Request bodies get big in real sessions: Claude Code's compaction POSTs the
// whole transcript (base64 images included) and upstream itself accepted a 30MB
// probe untouched. The old 1MB ceiling turned those requests into 413s, which
// Claude Code surfaces as "request size limit reached" and abandons the session.
// The default mirrors Anthropic's own 32MB guidance; `maxBodyBytes` overrides it.
const MAX_BODY = 32 * 1024 * 1024


const DEFAULT_CONFIG = {
  host: ENV.HOST ?? "127.0.0.1",
  port: envNum("PORT", 8181),
  upstream: normalizeUpstream(ENV.ZEN_URL ?? DEFAULT_UPSTREAM),
  // The v2 CLI's own wire format (captured from the real client): channel
  // "latest", artifact "cli", plus the client/project identity headers below.
  ua: ENV.ZEN_UA ?? "opencode/latest/2.1.4/cli",
  // "cli" mirrors x-opencode-client the real CLI sends.
  clientName: ENV.ZEN_CLIENT ?? "cli",
  // Stable per-install project identity (sha1 of "directory:<cwd>"), the same
  // derivation opencode itself uses. Set to override.
  projectHash: ENV.ZEN_PROJECT_HASH ?? "",
  // W3C b3/traceparent propagation headers, as the real CLI sends.
  tracing: ENV.ZEN_TRACING === "0" ? false : true,
  autoUA: ENV.AUTO_UA !== "0",
  uaRefreshMs: envNum("UA_REFRESH_MS", 6 * 3600_000),
  injectSession: ENV.INJECT_SESSION !== "0",
  // Which credentials the auto-sync health probe uses:
  //   "auto"      — use defaultZenKey when set, otherwise anonymous `public`
  //   "key"       — always use defaultZenKey (probe fails if none is set)
  //   "anonymous" — always anonymous `public`, even when a key is configured
  probeAuth: ENV.PROBE_AUTH ?? "auto",
  // "" = auto: at request time the first *healthy* free model becomes the default
  // (see effectiveDefault), so a model that disappears upstream never bricks new
  // installs. Set an explicit model here to pin it.
  defaultModel: ENV.DEFAULT_MODEL ?? "",
  fallbackModels: envJson("FALLBACK_MODELS", loadShippedModels()),
  modelAliases: envJson("MODEL_ALIASES", {}),
  // Harness system text prepended ahead of the caller's instructions on every
  // route, because the gate refuses requests that do not carry opencode's own
  // preamble. Semantics mirror bridgePreamble(): "" / "auto" = the shipped
  // agent-preamble.txt, "off" / "none" = send nothing, anything else = verbatim.
  agentPreamble: ENV.AGENT_PREAMBLE ?? "",
  // Append opencode's own tools to Anthropic /v1/messages requests so the free
  // tier accepts them. Calls to them are renamed back to the caller's tools.
  agentTools: ENV.AGENT_TOOLS !== "0",
  // opencode Zen serves each model on a specific endpoint family
  // (chat/completions | responses | messages). Patterns may end in `*`.
  // Source of truth: https://opencode.ai/docs/zen
  responsesModels: envJson("RESPONSES_MODELS", ["gpt-5*", "gpt-6*", "grok-*", "muse-spark-*"]),
  maxBodyBytes: envNum("MAX_BODY_BYTES", MAX_BODY),
  // How many extra attempts a request gets against the *same* model when it
  // fails transiently (429/5xx/network) before the fallback chain moves on.
  retriesPerModel: envNum("RETRIES_PER_MODEL", 2),
  retryBackoffMs: envNum("RETRY_BACKOFF_MS", 500),
  rateLimitMax: envNum("RATE_LIMIT_MAX", 0),
  rateLimitWindowMs: envNum("RATE_LIMIT_WINDOW_MS", 60_000),
  proxyKey: ENV.PROXY_KEY ?? "",
  // Minted per-caller keys (see src/apikeys.mjs). Only the SHA-256 of each key
  // is stored, so a leaked config file carries no usable credential.
  apiKeys: [],
  // Force auth even on loopback with nothing configured — for a deploy behind a
  // reverse proxy, where config.host is still 127.0.0.1.
  requireApiKey: ENV.REQUIRE_API_KEY === "1",
  defaultZenKey: ENV.ZEN_KEY ?? "",
  // Egress list. Empty = direct. More than one is what makes the 429 rotation
  // mean something: a fresh socket to the same IP is the same quota bucket, so
  // only a different exit IP escapes a drained one. Round-robin per request,
  // and the 429 ladder steps past the drained entry. Accepts http(s) and
  // socks5:// (wreq tunnels both).
  proxyUrls: envJson("PROXY_URLS", []).filter?.((u) => typeof u === "string" && u.trim()) ?? [],
  // With one proxy (or a pool that can go down) a failed tunnel would otherwise
  // silently replay the request over this machine's real IP — leaking the
  // address the proxy exists to hide, and burning its bucket. Strict means
  // refuse instead; it only bites when a proxy was actually configured.
  proxyStrict: ENV.PROXY_STRICT === "1",
  trustForwarded: ENV.TRUST_FORWARDED === "1",
  timeoutMs: envNum("TIMEOUT_MS", 120000),
  // The shipped values must match what the docs promise: a 30s model cache and
  // an hourly discovery pass. Both used to ship as 0, which meant /health (an
  // unauthenticated route) re-fetched the upstream catalog on every poll, and
  // auto-sync never actually re-ran after startup.
  cacheMs: envNum("CACHE_MS", 30000),
  autoSync: ENV.AUTO_SYNC !== "0",
  autoSyncIntervalMs: envNum("AUTO_SYNC_MS", 3600000),
}


// True when the user's own config carries an explicit model list. While it is
// false the list comes from models.json, so catalog refreshes reach installs that
// never touched the setting. It flips to true the moment someone edits the list
// in the dashboard (or sets FALLBACK_MODELS), and "Restore defaults" flips it
// back.
//
// Exposed as a setter because an ESM imported binding is read-only: the admin
// route used to assign this directly, which throws TypeError at runtime. In the
// monolith that was one module and it worked; across a module boundary it has
// to go through a function.
let fallbackModelsPinned = false

function setFallbackModelsPinned(value) {
  fallbackModelsPinned = !!value
  return fallbackModelsPinned
}


// A corrupt config file must not look like a missing one. The old catch-all
// said nothing and silently ran on defaults, so a typo in zen-proxy.json
// (a trailing comma, a hand-edited key) looked exactly like "my settings are
// being ignored" with no clue why. Say what is wrong, loudly, and keep serving
// on defaults rather than exiting.
function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("config file must hold a JSON object")
    const merged = { ...DEFAULT_CONFIG, ...raw }
    // A config file that predates the models.json catalog still holds a list
    // written by an older build. Those are only ever subsets of what we shipped
    // (the runtime sync used to prune dead entries and save the result), so
    // treat them as "never edited" and go back to following models.json —
    // otherwise an existing install would be pinned to a frozen list forever and
    // never see a catalog refresh. Anyone who really wants their own list can
    // re-pin it from the dashboard, which re-adds the key.
    const pinnedList = Array.isArray(raw.fallbackModels) ? raw.fallbackModels.filter((m) => typeof m === "string") : null
    const looksShipped = pinnedList != null && pinnedList.length > 0 && pinnedList.every((m) => BAKED_MODELS.includes(m))
    if (looksShipped) {
      merged.fallbackModels = loadShippedModels()
      fallbackModelsPinned = false
      try {
        // Written straight to disk rather than through saveConfig: loadConfig
        // runs while `config` is still being initialised, so saveConfig cannot
        // read it yet.
        writeConfigFile({ ...raw, fallbackModels: undefined })
        log("model list now follows models.json (was a default list from an older build)")
      } catch {}
    } else {
      fallbackModelsPinned = pinnedList != null && pinnedList.length > 0
      if (!fallbackModelsPinned) merged.fallbackModels = loadShippedModels()
    }
    // Older installs (and the shipped zen-proxy.json) still name the legacy
    // `/zen/v1` base, which upstream now gates. Upgrade it in place so an
    // existing config file keeps working after an update.
    const upstream = normalizeUpstream(merged.upstream)
    if (upstream !== merged.upstream) {
      merged.upstream = upstream
      try {
        writeConfigFile({ ...raw, upstream })
        log(`upstream migrated to ${upstream} (the legacy /zen/v1 base is no longer served)`)
      } catch {}
    }
    return merged
  } catch (err) {
    fallbackModelsPinned = false
    if (err?.code !== "ENOENT") {
      console.error(`zen-proxy: cannot read ${CONFIG_PATH}: ${err.message}`)
      console.error("zen-proxy: running on defaults; fix or delete the file to silence this")
    }
    return { ...DEFAULT_CONFIG, fallbackModels: loadShippedModels() }
  }
}


let config = loadConfig()

let uiHtml = ""
try {
  uiHtml = fs.readFileSync(UI_PATH, "utf8")
} catch {}


function isFallbackModelsPinned() {
  return fallbackModelsPinned
}


function writeConfigFile(obj) {
  // The file holds the Zen key and the proxy key, so it must not inherit the
  // process umask (022 makes it world-readable). Written to a temp file already
  // at 0600 and renamed, so the secret is never readable at the final path.
  const body = JSON.stringify(obj, null, 2)
  const tmp = CONFIG_PATH + ".tmp"
  fs.writeFileSync(tmp, body, { mode: 0o600 })
  try {
    fs.chmodSync(tmp, 0o600)
  } catch {}
  fs.renameSync(tmp, CONFIG_PATH)
}


function saveConfig(next) {
  const merged = { ...config, ...next }
  // Passing `fallbackModels: undefined` means "drop the pinned list and follow
  // models.json again". JSON.stringify omits undefined values, so the key is
  // removed from the file while memory keeps the shipped list in use.
  const unpin = next && "fallbackModels" in next && next.fallbackModels === undefined
  if (unpin) {
    merged.fallbackModels = loadShippedModels()
    fallbackModelsPinned = false
  }
  // While the list is following models.json it must stay out of the config file:
  // any unrelated save (an auto-UA refresh, a key change) would otherwise merge
  // the in-memory list back to disk and silently pin this install to whatever
  // the catalog said today.
  const forDisk = unpin || !fallbackModelsPinned ? { ...merged, fallbackModels: undefined } : merged
  writeConfigFile(forDisk)
  config = merged
  return merged
}


function maskKey(k) {
  if (!k) return ""
  if (k.length <= 12) return "••••••••"
  return k.slice(0, 6) + "••••••" + k.slice(-4)
}


function sanitize(cfg) {
  const out = { ...cfg }
  if (out.proxyKey) out.proxyKey = "••••••••"
  if (out.defaultZenKey) out.defaultZenKey = maskKey(out.defaultZenKey)
  // The hashes are internal: returning them lets a leaked dashboard response be
  // attacked offline, and nothing in the UI needs them. Ids and names suffice.
  if (Array.isArray(out.apiKeys)) out.apiKeys = out.apiKeys.map(({ hash, ...rest }) => rest)
  return out
}

// Reload from disk. A function, not a reassignment at the call site: an ESM
// imported binding is read-only to importers, so the live binding only updates
// when this module reassigns its own variable.
function reloadConfig() {
  config = loadConfig()
  return config
}

export {
  CONFIG_PATH,
  UI_PATH,
  MAX_BODY,
  DEFAULT_CONFIG,
  fallbackModelsPinned,
  setFallbackModelsPinned,
  loadConfig,
  config,
  uiHtml,
  isFallbackModelsPinned,
  writeConfigFile,
  saveConfig,
  maskKey,
  sanitize,
  reloadConfig,
}
