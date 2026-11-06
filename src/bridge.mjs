// The tool-shaped half of the gate: opencode's manifest bridged into the
// caller's tools, and foreign tool names aliased away.
import { AGENT_TOOL_MAP, FOREIGN_GATE_TOOL_ALIASES, GATED_TOOL_RE, aliasToolsInPlace, loadAgentTools } from "./catalogs.mjs"
import { config } from "./config.mjs"


// The gate takes requests that carry opencode's manifest; callers with none of
// their own — a plain chat, an auto-compaction — still need it attached. The
// manifest is the v2 upload (6 caller-mappable tools: read/edit/glob/grep/
// shell/write; measured 200 against the live gateway with the preamble). The
// model prefers opencode's names, so the relay layers rename manifest calls to
// the caller's equivalents; un-mappable ones (question, subagent, …) never ride.
function gateBridgeTools() {
  return config.agentTools ? loadAgentTools() : []
}


// The subset of opencode tools whose mapped name the caller actually offers.
function agentToolsFor(callerToolNames) {
  if (!config.agentTools) return []
  const wanted = callerToolNames instanceof Set ? callerToolNames : new Set(callerToolNames ?? [])
  return loadAgentTools().filter((t) => wanted.has(AGENT_TOOL_MAP[t.function.name].name))
}


// The manifest rides on every request (the v2 gate refuses anything less), so
// the model may answer with one of its tools even when the caller never
// offered an equivalent — measured 3-6 of 12 against the live gateway on a
// prompt that mentions reading a file. Such a call is a tool the caller cannot
// run, so the reply layer drops it: `stripUnpinnedCalls` for collected
// replies, the same decision per index in the streaming relays (a call's name
// arrives chunks apart from its arguments). Pinned callers keep their stricter
// filter: the reply only carries the pinned call. Callerless bridged requests
// are covered by the blanket strip (`bridged`), so this list is only needed
// for tool-carrying callers.
//
// `viaMap` for the Anthropic route, where the caller's names are the official
// ones (`Read`), and a manifest `read` is runnable iff the caller has that
// mapped name; on the OpenAI-shaped routes the caller's names are already in
// opencode's vocabulary.
//
// A predicate, not a name list: the manifest is not the only source of
// unrunnable calls. Left to its own devices the provider invents tools too —
// `client_nonce_lookup` on a request that mentions nothing of the sort was
// streamed through once — and a Set built from the manifest would let an
// invented name (not in the manifest, not offered) leak straight through. The
// rule is per request: keep only what this caller offered.
//
// The same hole sat open on the Anthropic route: `/v1/messages` callers bring
// their tools in Anthropic shape, and a stray call would arrive under the
// renamed official name. `anthropicToChatBody()` merges the manifest first for
// the gate; this keeps the reply side honest.
function keepableFor(tools, viaMap = false) {
  if (!config.agentTools) return null
  if (!Array.isArray(tools) || !tools.length) return null
  const offered = new Set(tools.map((t) => t?.function?.name ?? t?.name).filter(Boolean))
  if (!offered.size) return null
  return viaMap ? (raw) => offered.has(AGENT_TOOL_MAP[raw]?.name ?? raw) : (raw) => offered.has(raw)
}


function pinnedToolName(toolChoice) {
  if (!toolChoice || typeof toolChoice !== "object") return null
  const fn = toolChoice.function ?? toolChoice
  return typeof fn?.name === "string" && fn.name ? fn.name : null
}


// Prior-turn calls have to follow a rename too, or the model sees its own
// earlier call under the old name and cannot match it to the tool now offered.
function renameHistoryCalls(messages, map) {
  if (!Array.isArray(messages) || !map.size) return messages
  const byOriginal = new Map([...map].map(([alias, original]) => [original, alias]))
  for (const m of messages) {
    if (Array.isArray(m?.tool_calls)) {
      for (const call of m.tool_calls) {
        const name = call?.function?.name
        if (byOriginal.has(name)) call.function.name = byOriginal.get(name)
      }
    }
    if (Array.isArray(m?.content)) {
      for (const block of m.content) {
        if (block?.type === "tool_use" && byOriginal.has(block.name)) block.name = byOriginal.get(block.name)
      }
    }
  }
  return messages
}


function aliasGatedTools(body) {
  // A non-array "tools" ({} from a bad client) would make for-of throw and the
  // request hang without an answer.
  const map = aliasToolsInPlace(Array.isArray(body?.tools) ? body.tools : [], new Map())
  if (!map.size) return map
  // The pin must follow its own tool: with two gated tools, forcing the first
  // alias calls whichever tool was declared first, not the one pinned. Every
  // shape of pin is retargeted — Chat {function:{name}}, Anthropic
  // {type:"tool",name}, Responses {type:"function",name}.
  const aliasFor = (name) => {
    for (const [alias, original] of map) if (original === name) return alias
    return null
  }
  const isGated = (n) => typeof n === "string" && (GATED_TOOL_RE.test(n) || FOREIGN_GATE_TOOL_ALIASES.has(n))
  const choice = body.tool_choice
  if (typeof choice === "string" && isGated(choice)) {
    body.tool_choice = aliasFor(choice) ?? choice
  } else if (choice?.function?.name && isGated(choice.function.name)) {
    choice.function.name = aliasFor(choice.function.name) ?? choice.function.name
  } else if (choice?.name && isGated(choice.name)) {
    choice.name = aliasFor(choice.name) ?? choice.name
  }
  renameHistoryCalls(body.messages, map)
  return map
}


// Both legs write the client's bytes through res.write/res.end, so the reverse
// map is applied once there instead of in every transform and relay.
function restoreToolNames(res, map) {
  if (!map.size) return
  const pairs = [...map.entries()]
  const fix = (chunk) => {
    if (typeof chunk !== "string") return chunk
    let out = chunk
    for (const [alias, name] of pairs) {
      if (out.includes(alias)) out = out.split(`"${alias}"`).join(`"${name}"`)
    }
    return out
  }
  const write = res.write.bind(res)
  const end = res.end.bind(res)
  res.write = (chunk, ...rest) => write(fix(chunk), ...rest)
  res.end = (chunk, ...rest) => end(chunk === undefined ? chunk : fix(chunk), ...rest)
}

export {
  gateBridgeTools,
  agentToolsFor,
  keepableFor,
  pinnedToolName,
  renameHistoryCalls,
  aliasGatedTools,
  restoreToolNames,
}
