// Harness preamble assembly (config-dependent, so it sits above catalogs).
import { builtInPreamble } from "./catalogs.mjs"
import { config } from "./config.mjs"
import { textOf } from "./util.mjs"

function bridgePreamble() {
  const v = config.agentPreamble
  if (v == null) return builtInPreamble()
  const s = String(v).trim()
  if (s === "" || s === "auto") return builtInPreamble()
  if (s === "off" || s === "none") return ""
  return s
}

// A system text that already carries opencode's full harness block stays
// untouched, so opencode itself (or a chained proxy) can sit behind zen-proxy
// without a doubled preamble. The dedupe key is the `<env>` block, NOT the
// opener sentence: measured 2026-11-05, a system holding only the opener line
// ("You are an AI agent running in OpenCode, a coding agent harness.") is
// answered 429 — the gate wants opener AND `<env>` together, which is exactly
// why 9router's systemCarriesEnv() keys on the tag.
function combinePreamble(systemText) {
  const preamble = bridgePreamble()
  if (!preamble) return systemText
  if (systemText && systemText.includes("<env>")) return systemText
  return systemText ? `${preamble}\n\n${systemText}` : preamble
}

// Prepend the preamble to the first system message of a chat-shaped message
// array — the single-message form the gate was measured against; splitting
// them into two system turns is accepted differently.
function injectPreamble(messages) {
  const preamble = bridgePreamble()
  if (!preamble || !Array.isArray(messages)) return messages
  const at = messages.findIndex((m) => m?.role === "system")
  // System content is a string or text parts; both join into one string. The
  // upstream endpoint takes system text as a string, and a system turn never
  // carries images.
  const textOf = (m) => (typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((p) => p?.text ?? "").filter(Boolean).join("\n\n") : "")
  if (at >= 0) {
    const combined = combinePreamble(textOf(messages[at]))
    if (combined === textOf(messages[at])) return messages
    const out = [...messages]
    out[at] = { ...messages[at], content: combined }
    return out
  }
  return [{ role: "system", content: preamble }, ...messages]
}

export {
  bridgePreamble,
  combinePreamble,
  injectPreamble,
}
