// Upstream error classification: what is worth retrying, what is a verdict.



function parseRetryAfter(v) {
  if (v == null) return 0
  const n = Number(v)
  if (Number.isFinite(n)) return Math.max(0, n)
  const t = Date.parse(v)
  if (Number.isFinite(t)) return Math.max(0, (t - Date.now()) / 1000)
  return 0
}


const RETRYABLE_ERROR_TYPES = new Set([
  "server_error",
  "api_error",
  "upstream_error",
  "ProviderError",
  "ModelError",
  "MissingSessionID",
  "RegionError",
  "FreeTierError",
  "model_not_found",
])

// Free-tier backends fail with 4xx errors that are really per-model / per-provider
// conditions (console says "Model is unavailable", "not supported", geo blocks…).
// Those are not client bugs — the proxy should roll to the next candidate instead
// of surfacing a hard 4xx. Real request errors (bad JSON, auth, context length…)
// still break out immediately.
function retryableUpstream(status, body) {
  if (status === 429 || status >= 500) return true
  // 410 Gone is what a retired model id returns; auto-sync may not have caught
  // up yet, so the chain has to keep walking instead of surfacing "deprecated".
  if (status === 410) return true
  if (status < 400 || status > 499) return false
  const t = body?.error?.type ?? body?.type ?? ""
  const msg = String(body?.error?.message ?? body?.message ?? "")
  if (RETRYABLE_ERROR_TYPES.has(t)) return true
  return /model is unavailable|not supported|only be used in opencode|free tier can only|no such model|does not exist|has been deprecated|no longer available|overloaded|temporarily.*limit|upstream request failed/i.test(msg)
}


// Transient means waiting and asking the *same* model again can plausibly
// succeed (provider hiccup, rate limit, network blip). Model-level verdicts —
// free-tier gate 403s, geo blocks, retired ids — are deterministic, so those
// skip straight to the next candidate rather than burning retries on a
// foregone conclusion.
function transientUpstream(status, body) {
  if (status === 429 || status >= 500) return true
  const t = body?.error?.type ?? body?.type ?? ""
  return t === "server_error" || t === "api_error" || t === "upstream_error" || t === "ProviderError"
}


// Two different 429s come back from this gateway, and only one of them is the
// caller's own usage running out. The shared-bucket cooldown says its bare
// error text (`FreeUsageLimitError`, a `retry-after` window, nobody's personal
// allowance involved — the gate's own verdict on a request it cannot tie to a
// client). A spent identity answers with the upgrade pitch instead —
// "Free usage limit reached. Subscribe to OpenCode Go" — the same words the
// real CLI logs when its anonymous allowance is genuinely gone (measured
// 2026-10-24). Only the pitch earns escalating the same attempt to BYOK; a
// shared cooldown bought with the user's key would drain paid quota against a
// wall that lifts itself in a few seconds.
function exhaustedFreeVerdict(status, body) {
  if (status !== 429) return false
  const e = body?.error ?? body ?? {}
  const text = `${e.type ?? ""} ${e.message ?? ""}`
  return /free usage limit reached|subscribe to opencode go/i.test(text)
}

export {
  parseRetryAfter,
  RETRYABLE_ERROR_TYPES,
  retryableUpstream,
  transientUpstream,
  exhaustedFreeVerdict,
}
