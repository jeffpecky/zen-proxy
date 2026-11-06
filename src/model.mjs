// Model resolution: aliases, the effective default, and which endpoint
// family a model is served on.
import { config } from "./config.mjs"
import { syncState } from "./stats.mjs"

// jev-* free models are served on /v1/systemone (structured classification),
// not on a chat/responses endpoint, so they are never routable here.
const NOT_CHAT_SERVABLE = [/^jev-/]


const ALLOWED = () => new Set([...config.fallbackModels, ...Object.values(config.modelAliases)])


// Effective default model: an explicit config.defaultModel always wins; when it's
// empty (auto), prefer the first fallback model the last auto-sync saw as healthy
// so a dead hardcoded default never stalls requests.
function effectiveDefault() {
  if (config.defaultModel) return config.defaultModel
  const synced = new Set([...(syncState.working ?? []), ...(syncState.rateLimited ?? [])])
  for (const m of config.fallbackModels) if (synced.has(m)) return m
  return config.fallbackModels[0] ?? ""
}


function resolveModel(requested) {
  const dflt = effectiveDefault()
  const full = String(requested ?? "").trim()
  // An id may arrive provider-qualified (`anthropic/claude-...`, `openai/gpt-…`)
  // from routers and OpenAI-compatible clients. The bare suffix is what this
  // proxy's catalog uses, so try the full id first and fall back to the suffix —
  // but only split when the suffix actually resolves, otherwise a same-named
  // provider prefix is discarded for nothing.
  const bare = full.includes("/") ? full.split("/").pop() : full
  const allowed = ALLOWED()
  const resolves = (id) => !!id && (!!config.modelAliases[id] || allowed.has(id))
  // `requested` is the name the caller used (so replies echo it back), `target`
  // is what it maps to: an alias target, a catalog id, or the default.
  const name = resolves(full) ? full : bare
  const target = (name && config.modelAliases[name]) || (name && allowed.has(name) ? name : "") || dflt
  const rest = config.fallbackModels.filter((m) => m !== target)
  return { requested: (name && resolves(name) ? name : "") || bare || dflt, candidates: [target, ...rest] }
}


// ---- endpoint family resolution -------------------------------------------
// Zen serves each model on one endpoint family. We translate to/from the
// Responses API ourselves instead of pattern-matching a single vendor in code,
// so new models work by adding a pattern to `responsesModels` in config.
function modelFormat(id) {
  const s = String(id ?? "")
  for (const p of config.responsesModels ?? []) {
    if (typeof p !== "string" || !p) continue
    if (p.endsWith("*") ? s.startsWith(p.slice(0, -1)) : s === p) return "responses"
  }
  return "chat"
}

export {
  NOT_CHAT_SERVABLE,
  ALLOWED,
  effectiveDefault,
  resolveModel,
  modelFormat,
}
