// Reading an upstream body as SSE, the walls that bound a stream's lifetime,
// and the pure shaping both relay families share (call arguments, pinned deltas,
// SSE block rewriting). Shared here so the two relay modules never import each
// other.
import { config } from "./config.mjs"
import { usageToChat } from "./wire/responses.mjs"
import { randomBytes } from "node:crypto"

// Turns a Response body into an async iterable of raw SSE text blocks, so the
// Anthropic relay can read chat and Responses streams through one code path.
async function* sseChunks(upstreamRes) {
  const reader = upstreamRes.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      // SSE permits CRLF (and bare CR) line endings, and some gateways emit
      // them. Splitting on "\n\n" alone never matched, so a whole CRLF stream
      // arrived as one giant block with no finish chunk — reported as a false
      // mid-reply cut. Normalise as data arrives, holding back a trailing "\r"
      // so a CRLF pair split across two reads is not mistaken for a bare CR.
      buf = appendSse(buf, decoder.decode(value, { stream: true }))
      let i
      while ((i = buf.indexOf("\n\n")) !== -1) {
        yield buf.slice(0, i + 2)
        buf = buf.slice(i + 2)
      }
    }
    const tail = flushSse(buf)
    if (tail.trim()) yield tail
  } finally {
    try {
      reader.cancel()
    } catch {}
  }
}


// The free-tier gate only answers streaming traffic: a non-streaming request is
// refused with 403 FreeTierError for every model, no matter which one is asked.
// That used to walk the whole fallback chain (~5s), mark every model as failed
// on the dashboard and return a 403 that read like a different model had been
// used. So a non-streaming client request is sent upstream as a stream and the
// SSE is re-assembled into the plain JSON the client asked for.

// The free-tier gate only answers streaming traffic: a non-streaming request is
// refused with 403 FreeTierError for every model, no matter which one is asked.
// That used to walk the whole fallback chain (~5s), mark every model as failed
// on the dashboard and return a 403 that read like a different model had been
// used. So a non-streaming client request is sent upstream as a stream and the
// SSE is re-assembled into the plain JSON the client asked for.
async function collectChatCompletion(upstreamRes) {
  if (!/text\/event-stream/i.test(upstreamRes.headers.get("content-type") ?? "")) return upstreamRes.json()
  const message = { role: "assistant", content: "" }
  const out = {
    id: `chatcmpl-${randomBytes(12).toString("hex")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "",
    choices: [{ index: 0, message, finish_reason: "stop" }],
  }
  const toolCalls = []
  for await (const block of sseChunks(upstreamRes)) {
    let raw = ""
    for (const line of block.split("\n")) if (line.startsWith("data:")) raw = line.slice(5).trim()
    if (!raw || raw === "[DONE]") continue
    let d
    try {
      d = JSON.parse(raw)
    } catch {
      continue
    }
    if (d?.error) throw new Error(d.error.message ?? "upstream stream error")
    if (d?.id) out.id = d.id
    if (d?.model) out.model = d.model
    if (d?.created) out.created = d.created
    if (d?.usage) out.usage = d.usage
    const choice = d?.choices?.[0]
    if (!choice) continue
    const delta = choice.delta ?? {}
    if (typeof delta.content === "string" && delta.content) message.content += delta.content
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content)
      message.reasoning_content = (message.reasoning_content ?? "") + delta.reasoning_content
    for (const tc of delta.tool_calls ?? []) {
      const idx = tc.index ?? 0
      const cur = toolCalls[idx] ?? (toolCalls[idx] = { id: tc.id ?? `call_${idx}`, type: "function", function: { name: "", arguments: "" } })
      if (tc.id) cur.id = tc.id
      if (tc.function?.name) cur.function.name = tc.function.name
      if (tc.function?.arguments) cur.function.arguments += tc.function.arguments
    }
    if (choice.finish_reason) out.choices[0].finish_reason = choice.finish_reason
  }
  const calls = toolCalls.filter(Boolean)
  if (calls.length) {
    message.tool_calls = calls
    if (out.choices[0].finish_reason === "stop") out.choices[0].finish_reason = "tool_calls"
  }
  return out
}


// Same idea for /responses: the finished response object arrives whole in the
// `response.completed` event, which is exactly what responsesToChat expects.

// Same idea for /responses: the finished response object arrives whole in the
// `response.completed` event, which is exactly what responsesToChat expects.
async function collectResponses(upstreamRes) {
  if (!/text\/event-stream/i.test(upstreamRes.headers.get("content-type") ?? "")) return upstreamRes.json()
  let result = null
  for await (const block of sseChunks(upstreamRes)) {
    let raw = ""
    for (const line of block.split("\n")) if (line.startsWith("data:")) raw = line.slice(5).trim()
    if (!raw || raw === "[DONE]") continue
    let d
    try {
      d = JSON.parse(raw)
    } catch {
      continue
    }
    if (d?.error) throw new Error(d.error.message ?? "upstream stream error")
    if (d?.type === "response.completed" || d?.type === "response.incomplete") result = d.response ?? result
    else if (d?.response?.output) result = d.response
  }
  if (!result) throw new Error("stream ended without a completed response")
  return result
}


// Responses SSE -> chat-shaped SSE text blocks, so the Anthropic translator
// only ever has to understand one wire format.

// Responses SSE -> chat-shaped SSE text blocks, so the Anthropic translator
// only ever has to understand one wire format.
async function* responsesChunksAsChat(upstreamRes) {
  const tools = []
  // A call's argument deltas reference it by `item_id`, which is not the
  // `call_id` the added item carried. Both are indexed to the same chat index;
  // the old hardcoded `index: 0` appended every parallel call's arguments to
  // the first call, losing the rest.
  const byId = new Map()
  const indexFor = (obj, create = false) => {
    for (const key of [obj?.item_id, obj?.call_id, obj?.id]) {
      if (typeof key === "string" && byId.has(key)) return byId.get(key)
    }
    if (!create) return tools.length ? tools.length - 1 : 0
    const index = tools.length
    for (const key of [obj?.item_id, obj?.call_id, obj?.id]) if (typeof key === "string" && key) byId.set(key, index)
    return index
  }
  for await (const block of sseChunks(upstreamRes)) {
    let raw = ""
    for (const line of block.split("\n")) {
      if (line.startsWith("data:")) raw = line.slice(5).trim()
    }
    if (!raw || raw === "[DONE]") continue
    let d
    try {
      d = JSON.parse(raw)
    } catch {
      continue
    }
    if (!d || typeof d !== "object") continue
    const out = { id: "chatcmpl-stream", object: "chat.completion.chunk", model: "", choices: [{ index: 0, delta: {} }] }
    let emit = false
    if (d.type === "response.output_text.delta" && d.delta) {
      out.choices[0].delta.content = d.delta
      emit = true
    } else if ((d.type === "response.reasoning_text.delta" || d.type === "response.reasoning_summary_text.delta") && d.delta) {
      out.choices[0].delta.reasoning_content = d.delta
      emit = true
    } else if (d.type === "response.output_item.added" && d.item?.type === "function_call") {
      const index = indexFor(d.item, true)
      tools[index] = { id: d.item.call_id ?? d.item.id ?? `call_${index}` }
      out.choices[0].delta.tool_calls = [{ index, id: tools[index].id, type: "function", function: { name: d.item.name ?? "unknown", arguments: "" } }]
      emit = true
    } else if (d.type === "response.function_call_arguments.delta" && d.delta) {
      out.choices[0].delta.tool_calls = [{ index: indexFor(d), function: { arguments: d.delta } }]
      emit = true
    } else if (d.type === "response.completed" || d.type === "response.incomplete") {
      out.choices[0].finish_reason = d.type === "response.incomplete" ? "length" : tools.length ? "tool_calls" : "stop"
      emit = true
    } else if (d.type === "error" || d.error) {
      // The relay reads an upstream error as a thrown failure (it emits the
      // anthropic `error` event with this message); leaving it out used to
      // present a responses-model failure on /v1/messages as a clean turn.
      out.error = d.error ?? { message: typeof d.message === "string" ? d.message : "upstream stream error" }
      yield `data: ${JSON.stringify(out)}\n\n`
      continue
    }
    if (d.response?.usage) out.usage = usageToChat(d.response.usage)
    if (emit) yield `data: ${JSON.stringify(out)}\n\n`
  }
}


// chat.completions SSE -> Anthropic Messages SSE. Anthropic's stream is a fixed
// envelope: message_start, then one content_block_start/delta/stop per block,
// then message_delta carrying stop_reason and usage, then message_stop. Tool
// arguments arrive as input_json_delta, so they are buffered until the block ends
// rather than being re-parsed per chunk.
// A chat-completions SSE block that ends the reply: the finish chunk (its
// finish_reason becomes a non-null value exactly once) or the [DONE] sentinel.
// Upstreams that close the socket without either died mid-reply, and every
// relay has to say so instead of ending like a clean empty answer — measured
// in the hostile sweep: a mid-flight cut used to read back to agents as a
// "successful" turn that simply held less text than the model said.

// chat.completions SSE -> Anthropic Messages SSE. Anthropic's stream is a fixed
// envelope: message_start, then one content_block_start/delta/stop per block,
// then message_delta carrying stop_reason and usage, then message_stop. Tool
// arguments arrive as input_json_delta, so they are buffered until the block ends
// rather than being re-parsed per chunk.
// A chat-completions SSE block that ends the reply: the finish chunk (its
// finish_reason becomes a non-null value exactly once) or the [DONE] sentinel.
// Upstreams that close the socket without either died mid-reply, and every
// relay has to say so instead of ending like a clean empty answer — measured
// in the hostile sweep: a mid-flight cut used to read back to agents as a
// "successful" turn that simply held less text than the model said.
function chatBlockTerminal(block) {
  const b = block.trim()
  if (b === "data: [DONE]") return true
  if (!b.includes("finish_reason")) return false
  for (const line of b.split("\n")) {
    if (!line.startsWith("data:")) continue
    try {
      if (JSON.parse(line.slice(5).trim())?.choices?.some?.((c) => c?.finish_reason != null)) return true
    } catch {
      // A malformed connector guarded by the string check is not a finish.
      return false
    }
  }
  return false
}


// The real failure text travels as `data: {"error": ...}` blocks; remember it
// so the relay's closing event says why, not just that something went wrong.

// The real failure text travels as `data: {"error": ...}` blocks; remember it
// so the relay's closing event says why, not just that something went wrong.
function chatBlockError(block) {
  const b = block.trim()
  if (!b.startsWith("data: ") || !b.includes('"error"')) return null
  try {
    const d = JSON.parse(b.slice(6))
    return d?.error ? String(d.error.message ?? "upstream stream error") : null
  } catch {
    return null
  }
}


// Append decoded SSE text to a block buffer, normalising CRLF / bare CR line
// endings to \n while holding back a trailing "\r" (it may be the first half of
// a CRLF pair whose \n has not arrived yet). Every splitter uses this so a
// gateway that emits CRLF is not read as one endless block.

// Append decoded SSE text to a block buffer, normalising CRLF / bare CR line
// endings to \n while holding back a trailing "\r" (it may be the first half of
// a CRLF pair whose \n has not arrived yet). Every splitter uses this so a
// gateway that emits CRLF is not read as one endless block.
function appendSse(buffer, text) {
  if (!text) return buffer
  // A CR held back by the previous chunk is still unresolved when this one
  // arrives. If it is followed by \n the pair is a CRLF and must collapse to
  // one \n — leaving it alone broke the "\n\n" block delimiter across the hold,
  // so the block was split at the wrong place and a raw \r leaked into the
  // frame. With nothing following, the held CR was a bare terminator of its own.
  if (buffer.endsWith("\r")) {
    buffer = buffer.slice(0, -1) + "\n"
    if (text.startsWith("\n")) text = text.slice(1)
  }
  const heldCR = text.endsWith("\r")
  const body = heldCR ? text.slice(0, -1) : text
  return buffer + body.replace(/\r\n?/g, "\n") + (heldCR ? "\r" : "")
}


// The held CR from appendSse is resolved by the next chunk — except when there
// is no next chunk, which is exactly how a stream ends. Flushing the raw buffer
// then leaked that \r into the final frame; at end of stream a lone CR really
// was a terminator, so settle it as \n before the block is emitted.

// The held CR from appendSse is resolved by the next chunk — except when there
// is no next chunk, which is exactly how a stream ends. Flushing the raw buffer
// then leaked that \r into the final frame; at end of stream a lone CR really
// was a terminator, so settle it as \n before the block is emitted.
function flushSse(buffer) {
  return buffer.endsWith("\r") ? buffer.slice(0, -1) + "\n" : buffer
}


// Stream relays need walls that no runtime disagrees with. req.signal is
// undefined on node 18+ and current bun (1.3.14) — a stream's upstream fetch
// then ran with NO abort handling, so a dead upstream stalled the caller's
// connection forever (measured: non-stream requests, covered by their
// AbortSignal.timeout, kept working) — while some bun builds expose that
// signal and abort it on the server's own idle clock, making a live stream
// die with "The operation was aborted." (measured report). So every stream
// upstream fetch gets a wall the handler owns: a headers-wall timer that
// aborts if upstream never answers at all, and after the headers land, the
// pump's own wall covers body silence. Aborts carry their honest reason text
// instead of a runtime abort message. The response socket is deliberately
// NOT watched here: node emits res "close" early for otherwise healthy
// requests (measured mid-flight at ~0.5s with a live client on this proxy's
// flow), so any socket-derived kill would abort live streams.

// Stream relays need walls that no runtime disagrees with. req.signal is
// undefined on node 18+ and current bun (1.3.14) — a stream's upstream fetch
// then ran with NO abort handling, so a dead upstream stalled the caller's
// connection forever (measured: non-stream requests, covered by their
// AbortSignal.timeout, kept working) — while some bun builds expose that
// signal and abort it on the server's own idle clock, making a live stream
// die with "The operation was aborted." (measured report). So every stream
// upstream fetch gets a wall the handler owns: a headers-wall timer that
// aborts if upstream never answers at all, and after the headers land, the
// pump's own wall covers body silence. Aborts carry their honest reason text
// instead of a runtime abort message. The response socket is deliberately
// NOT watched here: node emits res "close" early for otherwise healthy
// requests (measured mid-flight at ~0.5s with a live client on this proxy's
// flow), so any socket-derived kill would abort live streams.
function headersWall(timeoutMs = config.timeoutMs) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => {
    ctrl.abort(new Error(`upstream never responded within ${timeoutMs}ms (headers wall)`))
  }, timeoutMs)
  return { signal: ctrl.signal, release() { clearTimeout(timer) } }
}


// Body-silence wall for the stream relays. `timeoutMs` is documented (README,
// config table) as a timeout on *silence*, not on total turn duration, and it
// has to behave that way: coding agents routinely stream for longer than two
// minutes, and a single timer armed at request start truncated every one of
// those with a false "upstream stalled" error. `touch()` re-arms the timer each
// time a chunk arrives, so only a genuinely silent upstream trips it.

// Body-silence wall for the stream relays. `timeoutMs` is documented (README,
// config table) as a timeout on *silence*, not on total turn duration, and it
// has to behave that way: coding agents routinely stream for longer than two
// minutes, and a single timer armed at request start truncated every one of
// those with a false "upstream stalled" error. `touch()` re-arms the timer each
// time a chunk arrives, so only a genuinely silent upstream trips it.
function relayWall(timeoutMs = config.timeoutMs) {
  const ctrl = new AbortController()
  const state = { stalled: false }
  let timer = null
  const arm = () => {
    timer = setTimeout(() => {
      state.stalled = true
      ctrl.abort(new Error(`upstream sent nothing for ${timeoutMs}ms (relay wall)`))
    }, timeoutMs)
  }
  arm()
  return {
    signal: ctrl.signal,
    state,
    touch() {
      clearTimeout(timer)
      arm()
    },
    abort() {
      clearTimeout(timer)
      ctrl.abort(new Error("client went away"))
    },
    release() {
      clearTimeout(timer)
    },
  }
}


// A client that hangs up leaves res destroyed with `writableEnded` still false,
// so the old `!res.writableEnded` guard would try to write an error into a dead
// socket. Check both.

// A client that hangs up leaves res destroyed with `writableEnded` still false,
// so the old `!res.writableEnded` guard would try to write an error into a dead
// socket. Check both.
function clientGone(res) {
  return !!(res.writableEnded || res.destroyed)
}


// A relay that fails after the 200 line is already on the wire cannot change
// the status, but the request was not a success. Every relay marks the response
// so the `finish` recorder logs 502 and counts the error, instead of the old
// unconditional 200 that made a stream of in-band errors read as healthy.

// A relay that fails after the 200 line is already on the wire cannot change
// the status, but the request was not a success. Every relay marks the response
// so the `finish` recorder logs 502 and counts the error, instead of the old
// unconditional 200 that made a stream of in-band errors read as healthy.
function markStreamFailure(res, message) {
  res.streamFailure = message ?? "upstream stream ended mid-reply"
}


// Client-side backpressure: res.write() reports false once the socket buffer is
// full, and the relays ignored the signal, so a slow reader let upstream text
// pile up in memory while the proxy kept pulling. Wait for `drain` between
// blocks instead. Mocks and non-socket responses have no `writableNeedDrain`,
// so this is a no-op there.

// Client-side backpressure: res.write() reports false once the socket buffer is
// full, and the relays ignored the signal, so a slow reader let upstream text
// pile up in memory while the proxy kept pulling. Wait for `drain` between
// blocks instead. Mocks and non-socket responses have no `writableNeedDrain`,
// so this is a no-op there.
function waitDrain(res) {
  if (!res.writableNeedDrain) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      res.off?.("drain", done)
      res.off?.("close", done)
      resolve()
    }
    res.on("drain", done)
    res.on("close", done)
  })
}

// A caller that sent no tools cannot run one, and the gateway hands them back
// anyway — it ignores tool_choice "none" and answers a plain summarization
// prompt with real read calls, which pi treats as a hard failure. So drop them
// from the reply, and never claim a tool call in finish_reason.
function stripToolCalls(chunk, strip) {
  if (!strip) return chunk
  for (const choice of chunk?.choices ?? []) {
    const body = choice?.delta ?? choice?.message
    if (body?.tool_calls) delete body.tool_calls
    if (choice?.finish_reason === "tool_calls") choice.finish_reason = "stop"
  }
  return chunk
}


// The pin is not enforcement: the provider may answer a pinned request with a
// call the caller never offered — the gate stub's `read` included, measured 3-6
// of 12 against the live gateway on a prompt that mentions reading a file. A
// pinned reply keeps the pinned call and nothing else; anything else is a tool
// the pinned-caller contract never allowed. Collected replies are trimmed
// here; streamed ones are filtered chunk by chunk in the relays, which carry
// per-index state because a call's name arrives chunks apart from its
// arguments.
//
// `keepable` (when set, never together with a pin) is the per-request rule
// built by `keepableFor()`: a reply may only carry calls the caller offered.

// The pin is not enforcement: the provider may answer a pinned request with a
// call the caller never offered — the gate stub's `read` included, measured 3-6
// of 12 against the live gateway on a prompt that mentions reading a file. A
// pinned reply keeps the pinned call and nothing else; anything else is a tool
// the pinned-caller contract never allowed. Collected replies are trimmed
// here; streamed ones are filtered chunk by chunk in the relays, which carry
// per-index state because a call's name arrives chunks apart from its
// arguments.
//
// `keepable` (when set, never together with a pin) is the per-request rule
// built by `keepableFor()`: a reply may only carry calls the caller offered.
function stripUnpinnedCalls(content, pin, keepable = null) {
  if ((!pin && !keepable) || !content || typeof content !== "object") return content
  for (const choice of content?.choices ?? []) {
    const body = choice?.message ?? choice?.delta
    if (Array.isArray(body?.tool_calls) && body.tool_calls.length) {
      const nameOf = (tc) => tc?.function?.name ?? tc?.name
      const keep = pin ? (tc) => nameOf(tc) === pin : (tc) => keepable(nameOf(tc))
      const kept = body.tool_calls.filter(keep)
      if (kept.length) body.tool_calls = kept
      else delete body.tool_calls
    }
    // No call survived and the model still claimed `tool_calls`: an empty
    // claim reads like a bug to every client, not like an answer.
    if (choice?.finish_reason === "tool_calls" && !body?.tool_calls?.length) choice.finish_reason = "stop"
  }
  return content
}


// Bookkeeping carried from one SSE block to the next by the streamed pinned
// filter. `tool_calls` chunks are tied together by `index`: the name names the
// call once and every argument chunk follows under the same index with
// `name: null`, so the keep/drop decision has to outlive the block that first
// saw the name. Kept calls are renumbered into one clean sequence.

// Bookkeeping carried from one SSE block to the next by the streamed pinned
// filter. `tool_calls` chunks are tied together by `index`: the name names the
// call once and every argument chunk follows under the same index with
// `name: null`, so the keep/drop decision has to outlive the block that first
// saw the name. Kept calls are renumbered into one clean sequence.
function pinStreamState(pin, keepable = null) {
  return {
    pin,
    keepable,
    byChoice: new Map(),
  }
}

function filterPinnedDelta(parsed, pinState) {
  for (const choice of parsed?.choices ?? []) {
    const key = choice?.index ?? 0
    let s = pinState.byChoice.get(key)
    if (!s) {
      s = { dropped: new Set(), kept: false, count: 0, renumber: new Map() }
      pinState.byChoice.set(key, s)
    }
    const body = choice?.delta ?? choice?.message
    if (Array.isArray(body?.tool_calls) && body.tool_calls.length) {
      const kept = []
      for (const tc of body.tool_calls) {
        const idx = tc?.index ?? 0
        if (tc?.function?.name) {
          if (pinState.pin) {
            if (tc.function.name === pinState.pin) {
              if (!s.renumber.has(idx)) s.renumber.set(idx, s.count++)
              s.kept = true
            } else {
              s.dropped.add(idx)
              continue
            }
          } else if (pinState.keepable && !pinState.keepable(tc.function.name)) {
            // A call the caller cannot run (manifest name or an invented
            // one): drop it by raw name and renumber whatever survives into
            // one clean sequence.
            s.dropped.add(idx)
            continue
          } else {
            if (!s.renumber.has(idx)) s.renumber.set(idx, s.count++)
            s.kept = true
          }
        } else if (s.dropped.has(idx)) {
          continue
        }
        if (s.renumber.has(idx)) tc.index = s.renumber.get(idx)
        kept.push(tc)
      }
      if (kept.length) body.tool_calls = kept
      else delete body.tool_calls
    }
    if (choice?.finish_reason === "tool_calls" && !s.kept) choice.finish_reason = "stop"
  }
}

function rewriteSSE(block, requested, strip = false, pinState = null) {
  if (!block.trim()) return null
  const lines = block.split("\n")
  const out = []
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      const payload = line.slice(6)
      if (payload === "[DONE]") {
        out.push(line)
        continue
      }
      try {
        const parsed = JSON.parse(payload)
        if (parsed && typeof parsed === "object" && "model" in parsed) parsed.model = requested
        stripToolCalls(parsed, strip)
        if (pinState) filterPinnedDelta(parsed, pinState)
        out.push(`data: ${JSON.stringify(parsed)}`)
      } catch {
        out.push(line)
      }
    } else {
      out.push(line)
    }
  }
  return out.join("\n") + "\n\n"
}

export {
  sseChunks,
  collectChatCompletion,
  collectResponses,
  responsesChunksAsChat,
  chatBlockTerminal,
  chatBlockError,
  appendSse,
  flushSse,
  headersWall,
  relayWall,
  clientGone,
  markStreamFailure,
  waitDrain,
  stripToolCalls,
  stripUnpinnedCalls,
  pinStreamState,
  filterPinnedDelta,
  rewriteSSE,
}
