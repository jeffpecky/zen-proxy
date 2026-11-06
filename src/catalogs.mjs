// Shipped catalogs — the free-model list, opencode's tool manifest, its harness
// preamble — plus the pure shaping built on them (fingerprint tools, arg remap).
// No config, no network: everything above this layer can import it cycle-free.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { VALID_MODEL_ID } from "./util.mjs"

const __dirname = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../")



// ---- shipped model catalog -------------------------------------------------
// models.json is the source of truth for which free models we offer. The
// model-sync GitHub Action keeps it current from opencode's public /models
// endpoint — new free models get appended, ones upstream drops get removed — so
// a fresh install always starts on the current list without touching this file.
// Baked in as a last resort so the proxy still runs if models.json is missing
// (an older checkout, or a partial install).
const MODELS_PATH = process.env.ZEN_PROXY_MODELS || path.join(__dirname, "models.json")

const BAKED_MODELS = [
  "space-bunny-free",
  "mimo-v2.6-flash-free",
  "big-pickle",
  "muse-spark-1.3-contributor-free",
  "muse-spark-1.2-contributor-free",
  "nemotron-3.5-lightning-free",
  "longcat-2.5-preview-free",
  "step-5-preview-free",
  "cat-jam-free",
  "deepseek-v4.1-flash-free",
  "nemotron-3.5-super-vl-free",
]

function loadShippedModels() {
  try {
    const parsed = JSON.parse(fs.readFileSync(MODELS_PATH, "utf8"))
    const models = Array.isArray(parsed?.models) ? parsed.models : []
    const clean = models.filter((id) => typeof id === "string" && VALID_MODEL_ID.test(id))
    if (clean.length) return clean
  } catch {}
  return [...BAKED_MODELS]
}


// ---- opencode agent preamble ------------------------------------------------
// The free tier refuses traffic that doesn't carry opencode's own agent framing,
// so an Anthropic client (Claude Code) whose system prompt is Anthropic's gets
// `403 FreeTierError` no matter how correctly it is translated. We put this
// captured opencode preamble *in front of* the client's instructions and leave
// everything the client sent intact and in order — the client's prompt is larger
// and comes later, so it still governs behaviour, but the request is now shaped
// like agent traffic and is accepted.
//
// The exact text matters: the gate is not satisfied by neutral or generic agent
// boilerplate (tested), only by opencode's real framing, and it degrades if the
// preamble is truncated much below this length. It is prepended, never
// substituted, so the client's own system prompt is always preserved. The text
// itself ships as agent-preamble.txt and is loaded by bridgePreamble().

// ---- opencode agent tools ---------------------------------------------------
// Measured behaviour of the free tier's gate: a request is accepted when it
// carries a valid session pair, `stream: true`, and opencode's *own* tool
// manifest alongside the caller's tools. The caller's system prompt is fine as
// it stands — it does not have to be opencode's — so Claude Code's instructions
// are passed through untouched.
//
// The model still prefers opencode's tool names (it can see both), so on the way
// back we rename them to the caller's equivalents and rename their arguments. We
// only offer an opencode tool when the caller actually has the counterpart, so
// the model can never pick a tool the caller is unable to run.
const AGENT_TOOLS_PATH = process.env.ZEN_PROXY_AGENT_TOOLS || path.join(__dirname, "agent-tools.json")

const AGENT_TOOL_MAP = {
  read: { name: "Read", args: { filePath: "file_path" } },
  edit: { name: "Edit", args: { filePath: "file_path", oldString: "old_string", newString: "new_string", replaceAll: "replace_all" } },
  write: { name: "Write", args: { filePath: "file_path" } },
  // null means "this argument has no counterpart on the caller's tool; drop it".
  bash: { name: "Bash", args: { workdir: null } },
  // v2 renamed the shell tool; callers still see `Bash`.
  shell: { name: "Bash", args: { workdir: null } },
  grep: { name: "Grep", args: {} },
  glob: { name: "Glob", args: {} },
  list: { name: "LS", args: {} },
}

let agentToolsCache = null

function loadAgentTools() {
  if (agentToolsCache) return agentToolsCache
  agentToolsCache = []
  try {
    const parsed = JSON.parse(fs.readFileSync(AGENT_TOOLS_PATH, "utf8"))
    // Accept both the wrapped {"tools":[…]} and a bare array capture.
    const tools = Array.isArray(parsed?.tools) ? parsed.tools : Array.isArray(parsed) ? parsed : []
    // chatToolsToResponses() drops tools without type, which would make the
    // bridge tool unconvertible and kill the process mid-request.
    agentToolsCache = tools.filter((t) => t?.type === "function" && t?.function?.name && AGENT_TOOL_MAP[t.function.name])
  } catch {}
  return agentToolsCache
}


// An opencode tool call rewritten as the caller's tool call.
function remapAgentTool(name, rawArgs) {
  const spec = AGENT_TOOL_MAP[name]
  if (!spec) return null
  let args = {}
  try {
    args = typeof rawArgs === "string" ? JSON.parse(rawArgs || "{}") : rawArgs ?? {}
  } catch {
    args = {}
  }
  const out = {}
  for (const [k, v] of Object.entries(args)) {
    if (k in spec.args) {
      if (spec.args[k] === null) continue
      out[spec.args[k]] = v
    } else {
      out[k] = v
    }
  }
  return { name: spec.name, args: JSON.stringify(out) }
}


// ---- fingerprint tools ------------------------------------------------------
// The free tier requires OpenCode's own `read` and `shell` declared with their
// EXACT descriptions and parameter schemas. A stubbed description, a renamed
// schema, or `tool_choice:"none"` is answered 403 FreeTierError (9router probes
// 2026-10-26). Caller tools otherwise ride untouched.
//
// zen-proxy used to merge the manifest first and then DROP any caller tool whose
// name collided with a manifest name. That satisfies the gate but silently
// deletes the caller's own `read`/`shell` — a tool loop that then cannot run
// what the model was just told it could. The rule here is 9router's:
//
//   1. a caller tool already carrying OpenCode's exact definition → keep as-is
//   2. same name but different wording, and its parameters can carry OpenCode's
//      → adopt OpenCode's definition IN PLACE (caller keeps its own name, so
//      there is no alias to restore)
//   3. otherwise move the caller tool to `<key>_client` and append OpenCode's
//      copy under the real name
//   4. any remaining missing fingerprint tool is appended
const FINGERPRINT_TOOL_NAMES = ["read", "shell"]

function fingerprintDefinition(key) {
  return loadAgentTools().find((t) => t.function.name === key)?.function
}

function fingerprintToolKey(name) {
  const trimmed = String(name ?? "").trim()
  return FINGERPRINT_TOOL_NAMES.includes(trimmed) ? trimmed : ""
}

function toolDefinition(tool) {
  const fn = tool?.function
  return fn && typeof fn === "object" && !Array.isArray(fn) ? fn : tool
}

function isFingerprintDefinition(tool, key) {
  const def = toolDefinition(tool)
  const want = fingerprintDefinition(key)
  if (!def || !want) return false
  return def.description === want.description && JSON.stringify(def.parameters) === JSON.stringify(want.parameters)
}

// OpenCode composes the shell description from `process.platform`, so the same
// tool on Windows says "Commands run on Windows using pwsh." while the capture
// says "Commands run on Linux using bash." — a two-word difference that an exact
// compare rejects, so compare the *arguments* instead.
function canNormalizeInPlace(tool, key) {
  const want = fingerprintDefinition(key)
  const props = toolDefinition(tool)?.parameters?.properties
  if (!want?.parameters?.properties || !props || typeof props !== "object" || Array.isArray(props)) return false
  const wanted = Object.keys(want.parameters.properties)
  const declared = Object.keys(props)
  if (declared.some((name) => !wanted.includes(name))) return false
  return (want.parameters.required ?? []).every((name) => declared.includes(name))
}

function withFingerprintDefinition(tool, key) {
  const want = fingerprintDefinition(key)
  if (!want) return tool
  const fn = tool?.function
  const def = { description: want.description, parameters: want.parameters }
  return fn && typeof fn === "object" && !Array.isArray(fn)
    ? { ...tool, function: { ...fn, ...def } }
    : { ...tool, ...def }
}

// Sent-name -> original-name, for the reply/history side to restore.
function concealFingerprintToolNames(tools) {
  const map = new Map()
  if (!Array.isArray(tools) || !tools.length) return { tools, map }
  const taken = new Set(tools.map(toolNameOf).filter(Boolean))
  const seen = new Set()
  const out = []
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
      out.push(tool)
      continue
    }
    const key = fingerprintToolKey(toolNameOf(tool))
    if (!key) {
      out.push(tool)
      continue
    }
    // Duplicate declarations of one name are rejected upstream; keep the first.
    if (seen.has(key)) continue
    seen.add(key)
    if (isFingerprintDefinition(tool, key)) {
      out.push(tool)
      continue
    }
    if (canNormalizeInPlace(tool, key)) {
      out.push(withFingerprintDefinition(tool, key))
      continue
    }
    let alias = `${key}_client`
    for (let i = 2; taken.has(alias); i++) alias = `${key}_client${i}`
    taken.add(alias)
    map.set(alias, key)
    out.push(withToolName(tool, alias))
  }
  return { tools: out, map }
}

// Append OpenCode's definition for each fingerprint tool the list does not
// already carry under that exact name.
function appendMissingFingerprintTools(tools, flat) {
  const appended = []
  if (!Array.isArray(tools)) return appended
  for (const name of FINGERPRINT_TOOL_NAMES) {
    if (tools.some((tool) => fingerprintToolKey(toolNameOf(tool)) === name)) continue
    const src = fingerprintDefinition(name)
    if (!src) continue
    tools.push(
      flat
        ? { type: "function", name, description: src.description, parameters: src.parameters, strict: false }
        : { type: "function", function: { name, description: src.description, parameters: src.parameters } },
    )
    appended.push(name)
  }
  return appended
}
/**
 * The request-side tool pass, on top of the manifest merge:
 *   1. caller tools colliding with a fingerprint name are normalized or aliased
 *   2. the foreign gate-word aliases are applied (reportfindings, terminal)
 *   3. `read` and `shell` are guaranteed present with OpenCode's definitions
 * Returns the sent-name -> original-name map for the reply/history side.
 */

function applyFingerprintTools(tools, flat) {
  const { tools: normalized, map } = concealFingerprintToolNames(tools)
  const all = Array.isArray(normalized) ? normalized : []
  aliasToolsInPlace(all, map)
  appendMissingFingerprintTools(all, flat)
  return { tools: all, map }
}


// The gate weighs the *system prompt*, not just the tools. A request whose
// system text is not opencode's own harness preamble is refused with
// `429 FreeUsageLimitError` however verisimilar the rest of it is (measured
// against the live gateway: the full captured preamble streams 200; the same
// request with a generic assistant prompt, with the opening line alone, or
// with the preamble cut at ~1.8 KB is refused, all within one minute). The
// captured text ships as agent-preamble.txt; config semantics:
//   "" / "auto" — the built-in preamble (default; the shipped file)
//   "off"/"none" — no preamble (BYOK use, or when the wire is different)
//   anything else — used verbatim as the preamble
const AGENT_PREAMBLE_PATH = process.env.ZEN_PROXY_AGENT_PREAMBLE || path.join(__dirname, "agent-preamble.txt")

const PREAMBLE_MARKER = "You are an AI agent running in OpenCode"


// The gate fingerprints tooling traffic by the Working directory it reads out of
// the `<env>` block: a plausible project directory passes, an install tree does
// not (9router measured `...\npm\node_modules\9router\app` answering 429
// deterministically while `Documents\anything` passed). A proxy installed to
// ~\.zen-proxy and started from there would therefore poison every request —
// silently, and regardless of how perfect the headers and TLS are. So the
// captured block is re-stamped at load with a plausible user workspace instead
// of the install path. Everything else in the capture stays byte-identical.
function sanitizeEnvWorkDir(dir) {
  const d = String(dir ?? "")
  const installTree =
    d === __dirname ||
    /(?:^|[\\/])node_modules(?:[\\/]|$)/.test(d) ||
    /(?:^|[\\/])\.zen-proxy(?:[\\/]|$)/.test(d) ||
    /(?:^|[\\/])zen-proxy(?:[\\/]|$)/.test(d)
  return installTree ? path.join(process.env.HOME || process.env.USERPROFILE || "", "Documents", "opencode") : d
}

const ENV_WORK_DIR = sanitizeEnvWorkDir(process.cwd())


function stampPreamble(text) {
  if (!text || !text.includes("<env>")) return text
  return text
    .replace(/^(\s*Working directory: ).*$/m, `$1${ENV_WORK_DIR}`)
    .replace(/^(\s*Workspace root folder: ).*$/m, `$1${ENV_WORK_DIR}`)
    .replace(/^(\s*Platform: ).*$/m, `$1${process.platform}`)
}


let agentPreambleCache = null

function builtInPreamble() {
  if (agentPreambleCache === null) {
    try {
      agentPreambleCache = stampPreamble(fs.readFileSync(AGENT_PREAMBLE_PATH, "utf8"))
    } catch {
      agentPreambleCache = ""
    }
  }
  return agentPreambleCache
}


function toolNameOf(tool) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return ""
  const flat = typeof tool.name === "string" ? tool.name.trim() : ""
  if (flat) return flat
  const fn = tool.function
  return fn && typeof fn === "object" && !Array.isArray(fn) && typeof fn.name === "string" ? fn.name.trim() : ""
}


function withToolName(tool, name) {
  const fn = tool?.function
  return fn && typeof fn === "object" && !Array.isArray(fn) ? { ...tool, function: { ...fn, name } } : { ...tool, name }
}


// Rename caller tool names the gate refuses to see (the `terminal` substring and
// the fixed foreign-gate names) into `map`. Mutates `tools` in place and extends
// the caller's sent-name -> original-name map. Kept separate from the pin/history
// rewrites so the fingerprint pass can reuse it without a body.
function aliasToolsInPlace(tools, map) {
  const declared = new Set(tools.map(toolNameOf).filter(Boolean))
  for (const t of tools) {
    const name = toolNameOf(t)
    if (!name) continue
    // Substring gate words first ("terminal" — case-insensitive, matched on the
    // name only: history text mentioning the word passes), then the fixed
    // name aliases. Both ride the same rename/restore machinery. The alias must
    // never contain the gate word (9router measured `reportfindings_client`
    // still 429ing; the gate matches the spelling, not the token).
    const alias = GATED_TOOL_RE.test(name) ? "run_command" : FOREIGN_GATE_TOOL_ALIASES.get(name)
    if (!alias) continue
    let unique = alias
    for (let i = 2; declared.has(unique) || map.has(unique); i++) unique = `${alias}_${i}`
    declared.add(unique)
    map.set(unique, name)
    if (t.function) t.function.name = unique
    else t.name = unique
  }
  return map
}


// ---- Anthropic Messages API layer ------------------------------------------
// zen-proxy also speaks the Anthropic Messages protocol (`POST /v1/messages`)
// so Claude Code can point straight at it. Requests are translated to whichever
// endpoint family the target model actually lives on, and the reply is
// translated back. See the note above AGENT_TOOLS_PATH for why an opencode
// preamble is prepended to the client's system prompt.


// Anthropic clients authenticate with `x-api-key`; the OpenAI-compatible SDKs
// use `Authorization: Bearer`. authForUpstream() accepts either, for every route.

// opencode's free tier refuses any request whose declared tool name contains
// "terminal" (case-insensitive substring) with 429 FreeUsageLimitError — no
// matter the quota, exit, session or payload size, and the same body with only
// that name changed answers normally (decolua/9router#5319). Only `tools[]` is
// inspected: history and system prompt are not. So the declaration travels
// under an alias and the caller's name is restored on the way back.
const GATED_TOOL_RE = /terminal/i

// Claude Code 2.1.x ships a single tool name the gate treats as a foreign-agent
// marker: `ReportFindings` beside `ScheduleWakeup`/`DeferredToolPlaceholder` is
// answered 429, and the identical body passes once that one name is renamed —
// so the gate reads the spelling, not the token (9router, probes 2026-10-29).
// The alias must not CONTAIN the original: `reportfindings_client` still 429s.
const FOREIGN_GATE_TOOL_ALIASES = new Map([["ReportFindings", "review_findings"]])

export {
  MODELS_PATH,
  BAKED_MODELS,
  loadShippedModels,
  AGENT_TOOLS_PATH,
  AGENT_TOOL_MAP,
  agentToolsCache,
  loadAgentTools,
  remapAgentTool,
  FINGERPRINT_TOOL_NAMES,
  fingerprintDefinition,
  fingerprintToolKey,
  toolDefinition,
  isFingerprintDefinition,
  canNormalizeInPlace,
  withFingerprintDefinition,
  concealFingerprintToolNames,
  appendMissingFingerprintTools,
  applyFingerprintTools,
  AGENT_PREAMBLE_PATH,
  PREAMBLE_MARKER,
  sanitizeEnvWorkDir,
  ENV_WORK_DIR,
  stampPreamble,
  agentPreambleCache,
  builtInPreamble,
  toolNameOf,
  withToolName,
  aliasToolsInPlace,
  GATED_TOOL_RE,
  FOREIGN_GATE_TOOL_ALIASES,
}
