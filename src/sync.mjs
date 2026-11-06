// Background work: the model catalog sync, health probes, and the auto-UA
// version check.
import { gateBridgeTools } from "./bridge.mjs"
import { config, fallbackModelsPinned, saveConfig } from "./config.mjs"
import { traceHeaders } from "./headers.mjs"
import { log } from "./log.mjs"
import { ALLOWED, NOT_CHAT_SERVABLE, modelFormat } from "./model.mjs"
import { clientIp, ipOmit } from "./net.mjs"
import { bridgePreamble } from "./preamble.mjs"
import { SESSION_HEADERS, identityFor, uaFingerprint } from "./session.mjs"
import { modelHealth, syncState } from "./stats.mjs"
import { upstreamFetch } from "./tls.mjs"
import { MODEL_LIST_BASE, VALID_MODEL_ID } from "./util.mjs"
import { chatToolsToResponses } from "./wire/responses.mjs"


let modelsCache = { at: 0, data: [], ok: false }

let modelsFetching = null

async function fetchModels() {
  if (modelsCache.at && Date.now() - modelsCache.at < config.cacheMs) return modelsCache
  if (modelsFetching) return modelsFetching
  modelsFetching = (async () => {
    try {
      const res = await upstreamFetch(`${MODEL_LIST_BASE}/models`, {
        headers: { "user-agent": config.ua },
        signal: AbortSignal.timeout(15_000),
      })
      if (res.ok) {
        const parsed = await res.json()
        const upstreamModels = parsed.data ?? []
        const allowed = ALLOWED()
        const dead = new Set(syncState.dead)
        let free
        if (syncState.ok && syncState.at) {
          const live = new Set([...syncState.working, ...syncState.rateLimited])
          free = upstreamModels.filter((m) => (live.has(m.id) || allowed.has(m.id)) && !dead.has(m.id))
        } else {
          free = upstreamModels.filter((m) => (m.id.endsWith("-free") || allowed.has(m.id)) && !dead.has(m.id))
        }
        modelsCache = { at: Date.now(), data: free, ok: true }
      } else {
        modelsCache = { at: Date.now(), data: modelsCache.data, ok: false }
      }
    } catch {
      modelsCache = { at: Date.now(), data: modelsCache.data, ok: false }
    }
    return modelsCache
  })()
  try {
    return await modelsFetching
  } finally {
    modelsFetching = null
  }
}


async function syncModels() {
  if (syncState.running) return syncState
  syncState.running = true
  syncState.at = Date.now()
  const start = Date.now()
  try {
    const res = await upstreamFetch(`${MODEL_LIST_BASE}/models`, {
      headers: { "user-agent": config.ua },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`upstream /models → ${res.status}`)
    const parsed = await res.json()
    const upstreamIds = new Set((parsed.data ?? []).map((m) => m.id))
    const isFree = (id) => VALID_MODEL_ID.test(id) && !NOT_CHAT_SERVABLE.some((re) => re.test(id))
    const current = [...config.fallbackModels].filter(isFree)
    // Everything the upstream currently offers for free. The user's list is
    // merged with this, so a model that exists but is temporarily blocked still
    // gets (re)added — the list self-heals instead of staying shrunken.
    const discovered = [...upstreamIds].filter((id) => id.endsWith("-free") && isFree(id))
    const candidates = [...new Set([...current, ...discovered])]
    const working = []
    const rateLimited = []
    const dead = []
    const flaky = []
    const gated = []
    // Only definitively-gone models are dropped from the user's list; `flaky`
    // ones stay configured so they recover on their own.
    const removeFromCurrent = new Set()
    const auth = probeAuthHeader()
    let idx = 0
    // Probes run serially with a beat between hops. The gate blanket-403s a
    // rapid model-hop burst from one identity: with 3 concurrent workers the
    // identical request shape that streams 200 one-at-a-time landed all 8
    // models in the gate-blocked bucket within a single 1.8s sync (measured
    // both ways). ~0.4s apart reads as one focused client, not a scan.
    const probe = async () => {
      while (idx < candidates.length) {
        const id = candidates[idx++]
        try {
          const r = await probeModel(id, auth)
          let bodyErr = ""
          try {
            const j = await r.json()
            if (j && (j.error || j.type === "error")) {
              const e = j.error ?? j
              bodyErr = (e.type || "") + " " + (e.message || "")
            }
          } catch {}
          if (r.ok && !bodyErr) { working.push(id); modelHealth.set(id, 0) }
          else if (r.status === 429 && (!bodyErr || /free.?usage.?limit/i.test(bodyErr))) {
            // 429 with the aggregate free-tier quota error (`FreeUsageLimitError …
            // OpenCode Go`) is a *shared-bucket cooldown*, not model death and not
            // the user's own usage. It must never reach the fail counter — the
            // reporter's “8 dead” list came exactly from these falling through to
            // it three syncs in a row and being silently removed from the list.
            rateLimited.push(id)
            modelHealth.set(id, 0)
          }
          else {
            // Only drop a model from the user's config on definitive proof that it
            // is gone: "not supported", 404, 410 Gone, "no such model", "has been
            // deprecated". Everything else (403 FreeTierError, 429, timeouts, 5xx)
            // is a *temporary* access or capacity condition — the model comes back
            // on its own, so deleting it would silently shrink the user's list and
            // lose it forever.
            const gone =
              r.status === 404 ||
              r.status === 410 ||
              /model_not_found|no such model|does not exist|is not supported|not supported|has been deprecated|no longer available/i.test(bodyErr)
            // Key/auth problems are not model problems either.
            const authErr = /AuthError|invalid api key|missing api key/i.test(bodyErr)
            // 403 FreeTierError even though the probe was agent-shaped (tools +
            // stream, see agentProbePayload). The gate refused the exact shape
            // a real client sends — likely a session/trust condition the probe
            // can't satisfy, so it says nothing about the model's health. Never
            // call it flaky, never remove it.
            const isGated = /FreeTierError|free tier can only/i.test(bodyErr)
            // Temporary blocks: keep the model, just remember it is unhealthy.
            const temporary = /RegionError|not available in your country|rate.?limit|free.?usage.?limit|overloaded/i.test(bodyErr)
            if (gone) { dead.push(id); removeFromCurrent.add(id) }
            else if (isGated) { gated.push(id) }
            else if (authErr) { flaky.push(id) }
            else {
              if (temporary) {
                modelHealth.set(id, 0)
                flaky.push(id)
              } else {
                const fails = (modelHealth.get(id) ?? 0) + 1
                modelHealth.set(id, fails)
                if (fails >= 3) { dead.push(id); removeFromCurrent.add(id) }
                else flaky.push(id)
              }
            }
          }
          if (idx < candidates.length) await new Promise((r) => setTimeout(r, 400))
        } catch {
          const fails = (modelHealth.get(id) ?? 0) + 1
          modelHealth.set(id, fails)
          if (fails >= 3) { dead.push(id); removeFromCurrent.add(id) }
          else flaky.push(id)
        }
      }
    }
    await probe()
    // Keep the user's order, drop only definitively-gone models, then append
    // anything upstream offers that the user doesn't have yet. Temporary blocks
    // never remove a model, and new models appear without any manual step.
    const newList = current.filter((id) => !removeFromCurrent.has(id))
    // Only auto-add newly discovered models that are actually reachable (ok,
    // rate-limited or free-tier-gated). A model that errors on its first probe
    // is retired upstream and shouldn't be pushed at the user.
    for (const id of discovered) {
      if (!newList.includes(id) && !removeFromCurrent.has(id) && !flaky.includes(id)) newList.push(id)
    }
    for (const id of working) if (!newList.includes(id)) newList.push(id)
    const changed = newList.join(",") !== current.join(",")
    if (changed && newList.length) {
      config.fallbackModels = newList
      // Only a user-owned list is written back. If the list is still following
      // models.json, persisting it here would pin this install to today's
      // catalog and it would never see the next bot refresh.
      if (fallbackModelsPinned) {
        try { saveConfig({ fallbackModels: newList }) } catch {}
      }
      log(`auto-sync: updated model list (${working.length} ok, ${rateLimited.length} rate-limited, ${gated.length} gate-blocked, ${flaky.length} flaky, ${dead.length} dead${fallbackModelsPinned ? "" : ", not pinned"})`)
    } else {
      log(`auto-sync: list unchanged (${working.length} ok, ${rateLimited.length} rate-limited, ${gated.length} gate-blocked, ${flaky.length} flaky, ${dead.length} dead)`)
    }
    syncState.working = working
    syncState.rateLimited = rateLimited
    syncState.flaky = flaky
    syncState.gated = gated
    syncState.dead = dead
    syncState.error = ""
    syncState.ok = true
    modelsCache = { at: 0, data: [], ok: true }
  } catch (err) {
    syncState.ok = false
    syncState.error = err.message
    log(`auto-sync failed: ${err.message}`)
  }
  syncState.ms = Date.now() - start
  syncState.running = false
  return syncState
}


// ---- per-IP rate limiting (CWE-770) ---------------------------------------
// Scoped to the inference endpoints only: the dashboard, /health and the
// admin API stay reachable, otherwise the UI's own polling would trip it.
const rateBuckets = new Map()

function rateLimitFor(req) {
  const max = Number(config.rateLimitMax ?? 0)
  if (!Number.isFinite(max) || max <= 0) return { limited: false }
  const window = Number(config.rateLimitWindowMs) > 0 ? Number(config.rateLimitWindowMs) : 60_000
  const ip = clientIp(req)
  // Every caller behind one reverse proxy shares its socket address unless
  // `trustForwarded` is on, so keying by IP alone made the limit one global
  // budget for the whole proxy. Loopback callers get the same split the identity
  // pool uses (UA family), which separates the agents on one machine without
  // inventing a key from data a caller controls.
  const key = !ip ? "unknown" : ipOmit(ip) ? `local\n${uaFingerprint(req)}` : ip
  const now = Date.now()
  let hits = rateBuckets.get(key)
  if (!hits) {
    hits = []
    rateBuckets.set(key, hits)
  } else {
    // Re-insert so Map order stays least-recently-used first.
    rateBuckets.delete(key)
    rateBuckets.set(key, hits)
  }
  while (hits.length && now - hits[0] >= window) hits.shift()
  if (hits.length >= max) {
    return { limited: true, retryAfter: Math.max(1, Math.ceil((hits[0] + window - now) / 1000)) }
  }
  hits.push(now)
  if (rateBuckets.size > 10_000) {
    // The old sweep walked every bucket on every request past the cap. The map
    // is now LRU-ordered, so dropping from the front is enough: skip the ones
    // that are still live, stop as soon as a fresh one is reached.
    for (const [k, v] of rateBuckets) {
      if (rateBuckets.size <= 9000) break
      if (!v.length || now - v[v.length - 1] >= window) rateBuckets.delete(k)
    }
  }
  return { limited: false }
}


let syncTimer = null

function scheduleSync() {
  if (syncTimer) clearTimeout(syncTimer)
  if (!config.autoSync || config.autoSyncIntervalMs <= 0) return
  syncTimer = setTimeout(async () => {
    await syncModels()
    scheduleSync()
  }, config.autoSyncIntervalMs)
  if (syncTimer.unref) syncTimer.unref()
}


// Auto-UA: opencode ships new versions regularly; keeping the injected
// `opencode/<version>` User-Agent current future-proofs the free-tier unlock.
const uaAutoState = { at: 0, version: "" }

async function refreshUA(force = false) {
  if (!config.autoUA) return ""
  const now = Date.now()
  if (!force && uaAutoState.at && now - uaAutoState.at < config.uaRefreshMs) return uaAutoState.version
  uaAutoState.at = now
  try {
    const res = await fetch("https://registry.npmjs.org/opencode-ai/latest", {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return uaAutoState.version
    const data = await res.json()
    const v = String(data?.version ?? "")
    if (!/^\d+\.\d+\.\d+/.test(v)) return uaAutoState.version
    uaAutoState.version = v
    // The v2 CLI advertises `opencode/latest/<version>/cli`; npm only publishes
    // the 1.x line, so it cannot bump a v2-style UA. Leave those installs alone.
    const next = `opencode/latest/${v}/cli`
    const v2Style = /^opencode\/latest\//.test(config.ua)
    if (!v2Style && next !== config.ua && /^opencode\/\d+\.\d+\.\d+/.test(config.ua)) {
      log(`auto-UA: opencode ${v} released — updating User-Agent`)
      try { saveConfig({ ua: next }) } catch {}
    }
    return v
  } catch {
    return uaAutoState.version
  }
}


let uaTimer = null

function scheduleUA() {
  if (uaTimer) clearTimeout(uaTimer)
  if (!config.autoUA || config.uaRefreshMs <= 0) return
  uaTimer = setTimeout(async () => {
    await refreshUA()
    scheduleUA()
  }, config.uaRefreshMs)
  if (uaTimer.unref) uaTimer.unref()
}


// Credentials used by the auto-sync health probe. Lets a user probe the
// anonymous free tier (public) even while BYOK is configured, or require the
// key so probes reflect their own quota.
function probeAuthHeader() {
  const mode = String(config.probeAuth ?? "auto").toLowerCase()
  if (mode === "anonymous") return "Bearer public"
  if (config.defaultZenKey) return `Bearer ${config.defaultZenKey}`
  if (mode === "key") return "Bearer public" // no key configured; anonymous is all we can do
  return "Bearer public"
}


// Health probes have to look like agent traffic or the free-tier gate refuses
// them: its `429 FreeUsageLimitError` covers every request it cannot tie to a
// real opencode client, and a thin `"ping"` with a stub manifest is not one
// (measured: the recipe below streams 200 while a 2 KB same-header request is
// refused in the same second). It wants the *harness system text* — a truncated
// or generic one is refused — and a plausible tool manifest. Sending this shape
// is also what makes sync buckets land in `working` instead of `rateLimited`,
// where a refused probe parks the model display-forever.
function agentProbePayload(id, format) {
  const tools = gateBridgeTools()
  const preamble = bridgePreamble()
  const ask = "Reply with exactly OK1 and nothing else."
  if (format === "responses") {
    const payload = {
      model: id,
      input: [{ role: "user", content: [{ type: "input_text", text: ask }] }],
      max_output_tokens: 32,
      stream: true,
    }
    if (preamble) payload.instructions = preamble
    const converted = chatToolsToResponses(tools)
    if (converted) payload.tools = converted
    return payload
  }
  // Mirror the wire shape the real client sends (stream_options and a real
  // token budget included); no `tool_choice` — the pinned ask keeps the answer
  // text, and the probe only reads the status anyway.
  const payload = {
    model: id,
    messages: [
      ...(preamble ? [{ role: "system", content: preamble }] : []),
      { role: "user", content: ask },
    ],
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: 32000,
  }
  if (tools.length) payload.tools = tools
  return payload
}


// One-shot liveness probe for a model, using the endpoint family that model
// actually lives on. Returns the raw Response so sync can classify it.
async function probeModel(id, auth) {
  const format = modelFormat(id)
  // Probes carry one complete identity pair so the gate sees a single
  // consistent client, not a session that shares a project with nothing.
  const identity = identityFor(null)
  const session = config.injectSession ? identity.session : undefined
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: auth,
    "user-agent": config.ua,
    // v2 wire parity — the gate reads more than the session pair.
    "x-opencode-client": config.clientName,
    "x-opencode-project": identity.project,
  }
  if (session) {
    for (const h of SESSION_HEADERS) headers[h] = session
    // Same affinity pair a real client carries alongside the session pair.
    headers["x-session-affinity"] = session
    headers["x-session-id"] = session
  }
  if (config.tracing) for (const [k, v] of Object.entries(traceHeaders())) headers[k] = v
  const r = await upstreamFetch(`${config.upstream}${format === "responses" ? "/responses" : "/chat/completions"}`, {
    method: "POST",
    headers,
    body: JSON.stringify(agentProbePayload(id, format)),
    signal: AbortSignal.timeout(Math.min(config.timeoutMs, 30_000)),
  })
  // A live model answers the streamed probe with SSE, and sync only needs the
  // status. Hang up instead of waiting for the model to finish its "ping".
  if (r.ok) {
    try { await r.body?.cancel() } catch {}
  }
  return r
}

export {
  modelsCache,
  modelsFetching,
  fetchModels,
  syncModels,
  rateBuckets,
  rateLimitFor,
  syncTimer,
  scheduleSync,
  uaAutoState,
  refreshUA,
  uaTimer,
  scheduleUA,
  probeAuthHeader,
  agentProbePayload,
  probeModel,
}
