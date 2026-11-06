// OpenAI Responses translation: chat <-> responses, item sanitising, and the
// streaming event -> delta mapping.
import { randomBytes } from "node:crypto"
import { textOf } from "../util.mjs"


// chat.completions messages -> Responses API `input` items.
// Keeps tool calls and tool results as first-class items so agent tool loops
// survive the translation (the naive "join everything into one string" approach
// silently destroys them).
function chatMessagesToInput(messages) {
  if (!Array.isArray(messages)) return String(messages ?? "")
  const items = []
  for (const m of messages) {
    const role = m?.role ?? "user"
    if (role === "tool" || role === "function") {
      const callId = m?.tool_call_id ?? m?.call_id ?? m?.id ?? "call_0"
      items.push({
        type: "function_call_output",
        call_id: callId,
        output: textOf(m?.content) || " ",
      })
      // Images inside tool results survive as a follow-up user input_image item.
      if (Array.isArray(m?.content)) {
        const imgs = m.content.filter((p) => p?.type === "image_url" && p?.image_url?.url)
        if (imgs.length) {
          items.push({ role: "user", content: imgs.map((p) => ({ type: "input_image", image_url: p.image_url.url })) })
        }
      }
      continue
    }
    // Preserve image_url parts as Responses input_image content blocks.
    if (Array.isArray(m?.content)) {
      const parts = []
      let hasImage = false
      for (const p of m.content) {
        if (typeof p === "string") { if (p) parts.push({ type: "input_text", text: p }) }
        else if (p?.type === "text" && p.text) parts.push({ type: "input_text", text: p.text })
        else if (p?.type === "image_url" && p?.image_url?.url) {
          parts.push({ type: "input_image", image_url: p.image_url.url })
          hasImage = true
        }
      }
      if (hasImage && parts.length) {
        items.push({ role: role === "assistant" ? "assistant" : role, content: parts })
        for (const tc of m?.tool_calls ?? []) {
          items.push({
            type: "function_call",
            call_id: tc?.id ?? "call_0",
            name: tc?.function?.name ?? tc?.name ?? "unknown",
            arguments: tc?.function?.arguments ?? tc?.arguments ?? "{}",
          })
        }
        continue
      }
    }
    const text = textOf(m?.content)
    if (text) items.push({ role: role === "assistant" ? "assistant" : role, content: text })
    for (const tc of m?.tool_calls ?? []) {
      items.push({
        type: "function_call",
        call_id: tc?.id ?? "call_0",
        name: tc?.function?.name ?? tc?.name ?? "unknown",
        arguments: tc?.function?.arguments ?? tc?.arguments ?? "{}",
      })
    }
  }
  return items.length ? items : [{ role: "user", content: "" }]
}


function chatToolsToResponses(tools) {
  if (!Array.isArray(tools)) return undefined
  const out = []
  for (const t of tools) {
    const fn = t?.type === "function" ? (t.function ?? t) : null
    if (!fn?.name) continue
    out.push({
      type: "function",
      name: fn.name,
      ...(fn.description ? { description: fn.description } : {}),
      ...(fn.parameters ? { parameters: fn.parameters } : {}),
      ...(fn.strict != null ? { strict: fn.strict } : {}),
    })
  }
  return out.length ? out : undefined
}


// Responses API result -> chat.completion, preserving tool calls + reasoning.
function responsesToChat(data, requested, servedBy) {
  const output = Array.isArray(data?.output) ? data.output : []
  let text = typeof data?.output_text === "string" ? data.output_text : ""
  if (!text) {
    const parts = []
    for (const item of output) {
      if (item?.type === "message" && Array.isArray(item.content)) {
        for (const c of item.content) if (c?.type === "output_text" && c.text) parts.push(c.text)
      }
    }
    text = parts.join("")
  }
  const toolCalls = output
    .filter((i) => i?.type === "function_call")
    .map((i, n) => ({
      id: i.call_id ?? i.id ?? `call_${n}`,
      type: "function",
      function: { name: i.name ?? "unknown", arguments: typeof i.arguments === "string" ? i.arguments : JSON.stringify(i.arguments ?? {}) },
    }))
  const reasoning = output
    .filter((i) => i?.type === "reasoning")
    .flatMap((i) => (Array.isArray(i.summary) ? i.summary.map((s) => s?.text ?? "") : []))
    .filter(Boolean)
    .join("\n")
  const u = data?.usage ?? {}
  const message = { role: "assistant", content: text || null }
  if (reasoning) message.reasoning_content = reasoning
  if (toolCalls.length) message.tool_calls = toolCalls
  return {
    id: data?.id ?? `chatcmpl-${randomBytes(12).toString("hex")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requested,
    ...(servedBy && servedBy !== requested ? { zen_served_by: servedBy } : {}),
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length ? "tool_calls" : data?.status === "incomplete" ? "length" : "stop",
      },
    ],
    usage: {
      prompt_tokens: u.input_tokens ?? 0,
      completion_tokens: u.output_tokens ?? 0,
      total_tokens: u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
    },
  }
}


// Responses input -> chat.completions `messages`. A real Responses body
// carries `input`, not `messages`: a string, or the item list the Responses
// spec uses — message items (with input_text/input_image parts),
// function_call items and their function_call_output results. Reasoning items
// are skipped: they carry provider-side state no chat upstream can use, the
// same way a chat caller re-sends the transcript without them.
function responsesInputToMessages(input) {
  if (typeof input === "string") return input ? [{ role: "user", content: input }] : []
  if (!Array.isArray(input)) return input == null ? [] : [{ role: "user", content: textOf(input) }]
  const messages = []
  for (const item of input) {
    if (item?.type === "message" || (item?.type == null && (item?.role ?? item?.content))) {
      const role = item?.role ?? "user"
      const content = item?.content
      if (typeof content === "string") {
        if (content) messages.push({ role, content })
      } else if (Array.isArray(content)) {
        const parts = []
        for (const p of content) {
          if (typeof p === "string") { if (p) parts.push({ type: "text", text: p }) }
          // `output_text` is what an assistant item carries when a caller
          // replays a prior /responses answer back as input. Without it every
          // prior assistant turn was dropped and the model lost its own history.
          else if ((p?.type === "input_text" || p?.type === "text" || p?.type === "output_text") && p.text) parts.push({ type: "text", text: p.text })
          else if (p?.type === "input_image" && (p.image_url ?? p.url)) parts.push({ type: "image_url", image_url: p.image_url ?? p.url })
        }
        if (parts.length) messages.push({ role, content: parts })
      }
      continue
    }
    if (item?.type === "function_call") {
      messages.push({
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: item?.call_id ?? item?.id ?? "call_0",
            type: "function",
            function: { name: item?.name ?? "unknown", arguments: typeof item?.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}) },
          },
        ],
      })
      continue
    }
    if (item?.type === "function_call_output") {
      messages.push({ role: "tool", tool_call_id: item?.call_id ?? item?.id ?? "call_0", content: item?.output ?? " " })
      continue
    }
    // reasoning, error and anything else unknown has no chat counterpart to
    // preserve; walk past it.
  }
  return messages.length ? messages : [{ role: "user", content: "" }]
}


// Responses input as an item array: a string becomes the user message the
// real Responses API would have carried as an item. Used where a Responses
// body reaches a responses-family upstream and its items must not pass through
// a chat round-trip.
function responsesInputItemArray(input) {
  if (typeof input === "string") return input ? [{ type: "message", role: "user", content: input }] : []
  if (Array.isArray(input)) return input
  return input == null ? [] : [{ type: "message", role: "user", content: textOf(input) }]
}


// Prior-turn reasoning items cannot survive a stateless pooled-credential call:
// the Responses API only lets the account that issued `encrypted_content`
// decrypt it, and `Bearer public` is a pool — replaying one answers 400
// "reasoning encrypted_content was not issued to this caller". With `store:false`
// (what this gateway uses) dropping just `encrypted_content` gets the item
// rejected as "not found or was deleted". Dropping the item is the only shape
// that works, and it is what lets multi-turn tool loops complete at all.
// Tool plumbing is clamped the same way: a call_id over 64 chars is an
// InputValidationError, arguments must be a JSON string or "{}", and a call with
// no name is unrunnable. Mirrors 9router's sanitizeResponsesItems.
const MAX_CALL_ID = 64

function clampCallId(id) {
  if (typeof id !== "string" || !id) return `call_${Date.now()}_${(clampCallId.seq = (clampCallId.seq ?? 0) + 1)}`
  return id.length > MAX_CALL_ID ? id.slice(0, MAX_CALL_ID) : id
}

function coerceArgs(v) {
  if (v == null || v === "") return "{}"
  if (typeof v !== "string") {
    try {
      return JSON.stringify(v)
    } catch {
      return "{}"
    }
  }
  try {
    JSON.parse(v)
    return v
  } catch {
    return "{}"
  }
}

function sanitizeResponsesItems(items) {
  if (!Array.isArray(items)) return items
  const out = []
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      out.push(item)
      continue
    }
    if (item.type === "reasoning") continue
    delete item.encrypted_content
    delete item.reasoning_encrypted_content
    if (item.type === "function_call") {
      if (!item.name || typeof item.name !== "string" || !item.name.trim()) continue
      item.name = item.name.trim().slice(0, 64)
      item.call_id = clampCallId(item.call_id)
      item.arguments = coerceArgs(item.arguments)
    } else if (item.type === "function_call_output") {
      item.call_id = clampCallId(item.call_id)
      if (typeof item.output !== "string") item.output = item.output != null && typeof item.output === "object" ? JSON.stringify(item.output) : String(item.output ?? "")
    }
    out.push(item)
  }
  return out
}


// A Responses request body -> the chat-shaped body the request loop already
// understands. Only the fields that have a chat counterpart travel;
// `instructions` becomes the system message, Responses tools (flat) become
// chat tools (nested), `max_output_tokens` maps onto both token keys.
function responsesInputToChatBody(body) {
  const chat = { model: body?.model }
  const messages = responsesInputToMessages(sanitizeResponsesItems(body.input))
  const sys = typeof body.instructions === "string" && body.instructions ? [{ role: "system", content: body.instructions }] : []
  chat.messages = sys.length ? [...sys, ...messages] : messages
  if (body.stream != null) chat.stream = !!body.stream
  if (body.temperature != null) chat.temperature = body.temperature
  if (body.top_p != null) chat.top_p = body.top_p
  const mt = Number(body.max_output_tokens ?? body.max_tokens)
  if (Number.isFinite(mt) && mt > 0) {
    chat.max_tokens = Math.floor(mt)
    chat.max_completion_tokens = Math.floor(mt)
  }
  if (body.parallel_tool_calls != null) chat.parallel_tool_calls = body.parallel_tool_calls
  // Thinking is part of the request, not a transport detail: a Responses caller
  // sends `reasoning:{effort,summary}` and a chat-shaped caller sends
  // `reasoning_effort`. Both must survive the translation or the model answers
  // with its default tier while the client believes it asked for another one.
  if (body.reasoning != null) chat.reasoning = body.reasoning
  if (body.reasoning_effort != null) chat.reasoning_effort = body.reasoning_effort
  if (Array.isArray(body.tools) && body.tools.length) {
    const tools = []
    for (const t of body.tools) {
      const name = t?.name ?? t?.function?.name
      if (!name) continue
      if (t?.type === "function" && t?.function) {
        tools.push(t)
        continue
      }
      tools.push({
        type: "function",
        function: { name, ...(t?.description ? { description: t.description } : {}), parameters: t?.parameters ?? { type: "object", properties: {} } },
      })
    }
    if (tools.length) chat.tools = tools
  }
  const tc = body.tool_choice
  if (typeof tc === "string") chat.tool_choice = tc
  else if (tc && typeof tc === "object" && (tc.type === "function" || tc.name)) {
    chat.tool_choice = { type: "function", function: { name: tc.function?.name ?? tc.name } }
  }
  return chat
}


// The inverse of responsesToChat: a collected chat.completion shaped back into
// a Responses response object, for a Responses-shaped caller whose model lives
// on /chat/completions.
function chatToResponses(content, requested, servedBy) {
  const msg = content?.choices?.[0]?.message ?? {}
  const output = []
  if (msg.reasoning_content) output.push({ type: "reasoning", summary: [{ text: msg.reasoning_content }] })
  const text = typeof msg.content === "string" ? msg.content : textOf(msg.content)
  if (text) output.push({ type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] })
  for (const tc of msg.tool_calls ?? []) {
    output.push({
      type: "function_call",
      id: tc?.id ?? `fc_${randomBytes(8).toString("hex")}`,
      call_id: tc?.id ?? "call_0",
      name: tc?.function?.name ?? tc?.name ?? "unknown",
      arguments: typeof tc?.function?.arguments === "string" ? tc.function.arguments : JSON.stringify(tc?.function?.arguments ?? {}),
    })
  }
  const u = content?.usage ?? {}
  // `finish_reason: "length"` means the model was cut off at the token cap.
  // Reporting that as "completed" tells a Responses caller it got a whole
  // answer; the Responses vocabulary has `incomplete` + `incomplete_details`
  // for exactly this.
  const truncated = content?.choices?.[0]?.finish_reason === "length"
  return {
    id: content?.id ? `resp_${content.id.replace(/^resp_/, "")}` : `resp_${randomBytes(12).toString("hex")}`,
    object: "response",
    created_at: content?.created ?? Math.floor(Date.now() / 1000),
    status: truncated ? "incomplete" : "completed",
    ...(truncated ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
    model: requested,
    ...output.length ? { output } : { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "", annotations: [] }] }] },
    usage: {
      input_tokens: u.prompt_tokens ?? 0,
      output_tokens: u.completion_tokens ?? 0,
      total_tokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
    },
    ...(servedBy && servedBy !== requested ? { zen_served_by: servedBy } : {}),
  }
}


// Filter the output items of a collected Responses object: bridge calls the
// caller never offered are removed entirely, a pinned call keeps only its own
// `name`. Everything that is not a function_call stays.
function filterResponsesOutput(data, callOk = null) {
  if (!data || !Array.isArray(data.output)) return data
  const output = data.output.filter((item) => (item?.type === "function_call" ? callOk !== null && callOk(item) : true))
  if (output.length !== data.output.length) data.output = output
  return data
}


// Responses SSE event -> chat.completion.chunk deltas.
//
// A Responses call is announced once with `id` (fc_…) and `call_id` (call_…),
// while its argument deltas reference it by `item_id`. Storing only `call_id`
// and looking up only `item_id` made every lookup miss and fall back to index 0,
// which merged two concurrent calls' arguments into the first one. Both names
// are indexed here, and an unresolvable delta is attached to the most recent
// call rather than silently rewriting call 0.
function callIndexFor(state, data, create = false) {
  const keys = [data?.item_id, data?.call_id, data?.id].filter((v) => typeof v === "string" && v)
  for (const key of keys) {
    const hit = state.byId?.get?.(key)
    if (hit != null) return hit
  }
  if (!create) return state.tools.length ? state.tools.length - 1 : 0
  const index = state.tools.length
  for (const key of keys) state.byId?.set?.(key, index)
  return index
}


function responsesEventToDeltas(event, data, state) {
  const type = event || data?.type || ""
  state.byId ??= new Map()
  const out = []
  if (type === "response.output_text.delta" && data?.delta) out.push({ content: data.delta })
  else if ((type === "response.reasoning_text.delta" || type === "response.reasoning_summary_text.delta") && data?.delta)
    out.push({ reasoning_content: data.delta })
  else if (type === "response.output_item.added" && data?.item?.type === "function_call") {
    const item = data.item
    const index = callIndexFor(state, item, true)
    const id = item.call_id ?? item.id ?? `call_${index}`
    state.tools[index] = { id }
    out.push({ tool_calls: [{ index, id, type: "function", function: { name: item.name ?? "unknown", arguments: "" } }] })
  } else if (type === "response.function_call_arguments.delta" && data?.delta) {
    const index = callIndexFor(state, data)
    if (!state.tools[index]) state.tools[index] = { id: data.call_id ?? `call_${index}` }
    out.push({ tool_calls: [{ index, function: { arguments: data.delta } }] })
  }
  return out
}


function usageToChat(u = {}) {
  return {
    prompt_tokens: u.input_tokens ?? 0,
    completion_tokens: u.output_tokens ?? 0,
    total_tokens: u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
  }
}

export {
  chatMessagesToInput,
  chatToolsToResponses,
  responsesToChat,
  responsesInputToMessages,
  responsesInputItemArray,
  MAX_CALL_ID,
  clampCallId,
  coerceArgs,
  sanitizeResponsesItems,
  responsesInputToChatBody,
  chatToResponses,
  filterResponsesOutput,
  callIndexFor,
  responsesEventToDeltas,
  usageToChat,
}
