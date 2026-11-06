// Anthropic Messages <-> OpenAI chat.completions translation.
import { randomBytes } from "node:crypto"
import { gateBridgeTools } from "../bridge.mjs"
import { applyFingerprintTools, remapAgentTool } from "../catalogs.mjs"
import { bridgePreamble } from "../preamble.mjs"
import { textOf } from "../util.mjs"


// ---- Anthropic -> chat.completions -----------------------------------------
// Anthropic puts the system prompt at the top level as an array of blocks and
// models tool use inside message content, so a body has to be reshaped before
// it means the same thing on a chat endpoint.
function anthropicSystemText(system) {
  if (!system) return ""
  if (typeof system === "string") return system
  if (!Array.isArray(system)) return String(system)
  return system.map((b) => (typeof b === "string" ? b : (b?.text ?? ""))).filter(Boolean).join("\n\n")
}


// An Anthropic image block carries raw base64; OpenAI-compatible chat endpoints
// want a data: URL in an image_url part.
function anthropicImageUrl(block) {
  const src = block?.source
  if (!src) return null
  if (src.type === "url" && typeof src.url === "string") return src.url
  if (src.type === "base64" && typeof src.data === "string") return `data:${src.media_type ?? "image/png"};base64,${src.data}`
  return null
}


function anthropicToChatMessages(system, messages) {
  const out = []
  const preamble = bridgePreamble()
  const sysText = anthropicSystemText(system)
  // Preamble and the client's instructions go into a *single* system message,
  // preamble first. One message is what the upstream gate was measured against;
  // splitting them into two separate system turns is accepted differently.
  // Nothing the client sent is dropped or reordered — it all still follows.
  const combined = preamble && sysText ? `${preamble}\n\n${sysText}` : preamble || sysText
  if (combined) out.push({ role: "system", content: combined })

  for (const m of Array.isArray(messages) ? messages : []) {
    const role = m?.role === "assistant" ? "assistant" : "user"
    if (typeof m?.content === "string") {
      out.push({ role, content: m.content })
      continue
    }
    const blocks = Array.isArray(m?.content) ? m.content : []
    const turnStart = out.length
    const toolCalls = []
    const parts = []
    // A tool_result is its own chat message with role "tool", not part of the
    // surrounding user turn, so those are flushed out first.
    const flush = () => {
      // `parts` holds block objects, so text has to be unwrapped before joining.
      const text = parts.filter((p) => p?.type === "text" && p.text).map((p) => p.text).join("")
      const images = parts.filter((p) => p?.type === "image_url").map((p) => ({ type: "image_url", image_url: p.image_url }))
      if (text || images.length) {
        out.push({ role, content: images.length ? [...(text ? [{ type: "text", text }] : []), ...images] : text })
      }
      parts.length = 0
    }
    for (const b of blocks) {
      const type = b?.type
      if (type === "text") parts.push({ type: "text", text: b.text ?? "" })
      else if (type === "image") {
        const url = anthropicImageUrl(b)
        if (url) parts.push({ type: "image_url", image_url: { url } })
      } else if (type === "tool_use") {
        toolCalls.push({
          id: b.id ?? "call_0",
          type: "function",
          function: { name: b.name ?? "unknown", arguments: typeof b.input === "string" ? b.input : JSON.stringify(b.input ?? {}) },
        })
      } else if (type === "tool_result") {
        flush()
        // A tool result may carry images: Claude Code's Read on a picture sends
        // an image block inside the tool_result, and nothing else. Chat
        // endpoints reject images in role "tool", so the text stays on the tool
        // message and the pictures follow as a user turn — the same shape the
        // Responses translation already uses. Without this the model only saw
        // an empty text fallback and the picture silently vanished.
        const images = Array.isArray(b.content)
          ? b.content.filter((p) => p?.type === "image").map(anthropicImageUrl).filter(Boolean)
          : []
        out.push({
          role: "tool",
          tool_call_id: b.tool_use_id ?? b.id ?? "call_0",
          content: typeof b.content === "string" ? b.content : textOf(b.content) || " ",
        })
        if (images.length) out.push({ role: "user", content: images.map((url) => ({ type: "image_url", image_url: { url } })) })
      }
    }
    flush()
    if (toolCalls.length) {
      // An assistant turn that carries both text and tool_use is ONE chat
      // message with content *and* tool_calls. Pushing a separate assistant
      // message for the calls produced two assistant turns in a row, which
      // chat endpoints reject or silently misread as two separate replies.
      const last = out[turnStart]
      if (last && last.role === "assistant" && turnStart === out.length - 1) {
        last.tool_calls = toolCalls
        if (!last.content) last.content = ""
      } else {
        out.push({ role: "assistant", content: "", tool_calls: toolCalls })
      }
    }
  }
  if (!out.length) out.push({ role: "user", content: "" })
  return out
}


function anthropicToolsToChat(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined
  const out = []
  for (const t of tools) {
    if (!t?.name) continue
    out.push({
      type: "function",
      function: {
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        parameters: t.input_schema ?? { type: "object", properties: {} },
      },
    })
  }
  return out.length ? out : undefined
}


function anthropicToChatBody(body, model) {
  const payload = {
    model,
    messages: anthropicToChatMessages(body?.system, body?.messages),
    stream: !!body?.stream,
  }
  const mt = Number(body?.max_tokens)
  if (Number.isFinite(mt) && mt > 0) payload.max_tokens = Math.floor(mt)
  if (body?.temperature != null) payload.temperature = body.temperature
  if (body?.top_p != null) payload.top_p = body.top_p
  if (Array.isArray(body?.stop_sequences) && body.stop_sequences.length) payload.stop = body.stop_sequences.slice(0, 4)
  const tools = anthropicToolsToChat(body?.tools)
  // The gate takes opencode's own manifest on every request (a caller's tools
  // plus a `read` stub alone is refused since the v2 gateway). The manifest goes
  // first, the caller's tools after it — minus names that collide with a
  // manifest name — and the caller's prompt and intent stay untouched. (Off in
  // agentTools: false.) A model may still answer with a manifest tool the
  // caller has no equivalent for; `keepableFor` feeds the reply layer,
  // which drops exactly those.
  // The gate takes opencode's own manifest on every request (a caller's tools
  // plus a `read` stub alone is refused since the v2 gateway). Caller tools ride
  // first, then the manifest fills in whatever is missing — so a caller that
  // already declares `read`/`shell` keeps its own definition (normalized in
  // place when its arguments allow) instead of having it silently replaced or
  // dropped by a manifest duplicate. (Off in agentTools: false.)
  const bridge = gateBridgeTools()
  const callerTools = tools ?? []
  const { tools: fingerprintTools } = bridge.length
    ? applyFingerprintTools([...(callerTools ?? [])], false)
    : { tools: callerTools }
  // Manifest first (the shape every shipped test pins), then the caller's tools.
  // Dedupe by name, first wins: a caller tool normalized in place is byte-equal
  // to its manifest twin, and an incompatible one has already moved to
  // `<key>_client`, so nothing the caller declared is silently lost.
  const all = bridge.length ? [...bridge, ...fingerprintTools] : callerTools
  const named = []
  const taken = new Set()
  for (const t of all) {
    const n = t?.function?.name ?? t?.name
    if (!n || taken.has(n)) continue
    taken.add(n)
    named.push(t)
  }
  if (named.length) payload.tools = named
  // Anthropic's tool_choice and opencode's use the same vocabulary once renamed.
  if (typeof body?.tool_choice === "object" && body.tool_choice?.type === "tool") {
    payload.tool_choice = { type: "function", function: { name: body.tool_choice.name } }
  } else if (typeof body?.tool_choice === "object" && body.tool_choice?.type === "any") {
    // "any" means some call must happen; upstream has no object form for that
    // and "required" is its exact match (measured: it used to be dropped and
    // degrade into the model's default guess). pinnedToolName treats it as
    // null, so this cannot read as a pin. Other object shapes stay dropped —
    // forwarding an unknown dialect has never been measured as safe.
    payload.tool_choice = "required"
  } else if (typeof body?.tool_choice === "string") {
    payload.tool_choice = body.tool_choice
  }
  return payload
}


// ---- chat.completions -> Anthropic message ----------------------------------
function parseToolArgs(args) {
  if (typeof args !== "string") return args ?? {}
  try {
    const v = JSON.parse(args)
    return v && typeof v === "object" ? v : {}
  } catch {
    return {}
  }
}


const STOP_REASON = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use", function_call: "tool_use", content_filter: "end_turn" }


function chatToAnthropic(content, requested, servedBy, pin = null) {
  const msg = content?.choices?.[0]?.message ?? {}
  const blocks = []
  if (msg.reasoning_content) blocks.push({ type: "thinking", thinking: msg.reasoning_content, signature: "" })
  const text = typeof msg.content === "string" ? msg.content : textOf(msg.content)
  if (text) blocks.push({ type: "text", text })
  for (const tc of msg.tool_calls ?? []) {
    // A call to an opencode bridge tool comes back under opencode's name; give
    // the caller back the tool it actually offered.
    const mapped = remapAgentTool(tc?.function?.name ?? tc?.name, tc?.function?.arguments ?? tc?.arguments)
    const name = mapped ? mapped.name : (tc?.function?.name ?? tc?.name ?? "unknown")
    // The pin is not enforcement: the provider may answer a pinned request with
    // a call the caller never offered (the injected stub `read` included). A
    // pinned reply keeps the pinned call and nothing else.
    if (pin && name !== pin) continue
    blocks.push({
      type: "tool_use",
      id: tc?.id ?? `toolu_${randomBytes(8).toString("hex")}`,
      name,
      input: parseToolArgs(mapped ? mapped.args : (tc?.function?.arguments ?? tc?.arguments)),
    })
  }
  if (!blocks.length) blocks.push({ type: "text", text: "" })
  const u = content?.usage ?? {}
  // Every call got filtered away and the model still claimed `tool_calls`: the
  // message has no call left to answer, so it cannot end as tool_use.
  const stop = STOP_REASON[content?.choices?.[0]?.finish_reason] ?? "end_turn"
  return {
    id: content?.id ?? `msg_${randomBytes(12).toString("hex")}`,
    type: "message",
    role: "assistant",
    model: requested,
    content: blocks,
    stop_reason: stop === "tool_use" && !blocks.some((b) => b.type === "tool_use") ? "end_turn" : stop,
    stop_sequence: null,
    usage: { input_tokens: u.prompt_tokens ?? 0, output_tokens: u.completion_tokens ?? 0 },
    ...(servedBy && servedBy !== requested ? { zen_served_by: servedBy } : {}),
  }
}


// Anthropic errors are `{type:"error", error:{type,message}}`; upstream speaks
// OpenAI shapes, so translate the ones clients actually branch on.
const ANTHROPIC_ERROR_TYPE = {
  invalid_request_error: "invalid_request_error",
  authentication_error: "authentication_error",
  permission_error: "permission_error",
  not_found_error: "not_found_error",
  request_too_large: "request_too_large",
  rate_limit_error: "rate_limit_error",
  api_error: "api_error",
  overload_error: "overloaded_error",
}

const ANTHROPIC_ERROR_MAP = {
  FreeTierError: "permission_error",
  RegionError: "permission_error",
  MissingSessionID: "api_error",
  AuthError: "authentication_error",
  model_not_found: "not_found_error",
  server_error: "api_error",
  ProviderError: "api_error",
  ModelError: "api_error",
}

function anthropicError(status, err) {
  const type = String(err?.error?.type ?? err?.type ?? "")
  const resolved =
    ANTHROPIC_ERROR_MAP[type] ??
    ANTHROPIC_ERROR_TYPE[type] ??
    (status === 429 ? "rate_limit_error" : status === 401 ? "authentication_error" : status >= 500 ? "api_error" : "invalid_request_error")
  return { status, body: { type: "error", error: { type: resolved, message: String(err?.error?.message ?? err?.message ?? "request failed") } } }
}

export {
  anthropicSystemText,
  anthropicImageUrl,
  anthropicToChatMessages,
  anthropicToolsToChat,
  anthropicToChatBody,
  parseToolArgs,
  STOP_REASON,
  chatToAnthropic,
  ANTHROPIC_ERROR_TYPE,
  ANTHROPIC_ERROR_MAP,
  anthropicError,
}
