// Shared helpers and the small constants more than one layer needs.


const ENV = process.env


// Model ids only ever travel inside JSON bodies, never a URL or a path, so the
// guarantee here is narrow but real: whitespace, quotes, backslashes and shell
// metacharacters can never enter a catalog or config value. `/` and `.` stay
// because provider-qualified ids legitimately use them (`nvidia/nemotron-3-free`).
const VALID_MODEL_ID = /^[A-Za-z0-9._:@+/%-]+$/


// Upstream base URL. OpenCode 2 moved agent traffic to `/inference/openai/v1`
// (the v2 CLI's own catalog says so, and capture of its real requests confirms
// it); the old `/inference/v1` base now treats non-CLI traffic as quota-exhausted
// `429 FreeUsageLimitError`. Configs that still point at the legacy bases are
// migrated on load — they would silently lose every free model otherwise.
const DEFAULT_UPSTREAM = "https://opencode.ai/inference/openai/v1"

// `/models` is only served on the documentend legacy base; discovery keeps it.
const MODEL_LIST_BASE = "https://opencode.ai/inference/v1"

const LEGACY_UPSTREAMS = new Set([
  "https://opencode.ai/zen/v1",
  "https://opencode.ai/zen",
  "https://opencode.ai/inference/v1",
  "https://opencode.ai/inference",
])

function normalizeUpstream(v) {
  const u = String(v ?? "").trim().replace(/\/+$/, "")
  if (!u) return DEFAULT_UPSTREAM
  return LEGACY_UPSTREAMS.has(u.toLowerCase()) ? DEFAULT_UPSTREAM : u
}


// Env-var JSON used to be parsed inline in the object literal above, so one
// malformed variable (a trailing comma in FALLBACK_MODELS) threw during module
// import — before any config, logging or server existed — and killed the
// process with a bare SyntaxError. Parse defensively: a bad value falls back to
// the default and says so, and the rest of the configuration still loads.
function envJson(name, dflt) {
  const raw = ENV[name]
  if (typeof raw !== "string" || !raw.trim()) return dflt
  try {
    return JSON.parse(raw)
  } catch (err) {
    console.error(`zen-proxy: ${name} is not valid JSON (${err.message}); using the default`)
    return dflt
  }
}


function envNum(name, dflt) {
  const raw = ENV[name]
  if (raw == null || raw === "") return dflt
  const n = Number(raw)
  return Number.isFinite(n) ? n : dflt
}


function toBool(v, dflt) {
  if (v === undefined || v === null) return dflt
  if (v === false || v === 0 || v === "0" || v === "false") return false
  return true
}


function num(v, dflt) {
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}


function textOf(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : (p?.text ?? p?.content ?? p?.input_text ?? "")))
      .filter(Boolean)
      .join("")
  }
  return content == null ? "" : String(content)
}

export {
  ENV,
  VALID_MODEL_ID,
  DEFAULT_UPSTREAM,
  MODEL_LIST_BASE,
  LEGACY_UPSTREAMS,
  normalizeUpstream,
  envJson,
  envNum,
  toBool,
  num,
  textOf,
}
