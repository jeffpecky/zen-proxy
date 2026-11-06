// The Responses-lane relays: upstream Responses, chat rendered as Responses, and
// the passthrough shape.
import { chatMessagesToInput, chatToolsToResponses, responsesEventToDeltas, usageToChat } from "./wire/responses.mjs"
import { randomBytes } from "node:crypto"
import { sseChunks, chatBlockTerminal, appendSse, flushSse, relayWall, clientGone, markStreamFailure, waitDrain } from "./sse.mjs"

// The proxy always streams upstream even when the caller asked for one JSON
// reply, so `stream_options` has to be requested here rather than forwarded
// from a caller who never asked to stream. Without it the gateway sends no
// usage chunk at all and every collected reply reported zero tokens.
function withStreamUsage(body, model = body.model) {
  const opts = body.stream_options && typeof body.stream_options === "object" ? body.stream_options : {}
  const out = { ...body, stream_options: { ...opts, include_usage: true } }
  // The chat endpoint validates reasoning_effort against a strict enum and 400s
  // "Invalid option" for anything else — including "auto", which adaptive
  // thinking arrives as, and Claude Code's "ultra". Omit "auto" (that is what
  // adaptive means: the model picks), and map the rest into what this model
  // actually serves. 9router does the same two steps for the same reason.
  const effort = normalizeEffort(out.reasoning_effort, model)
  if (effort) out.reasoning_effort = effort
  else delete out.reasoning_effort
  return out
}


// Build a Responses API request from a chat.completions body.

// Build a Responses API request from a chat.completions body.
function responsesRequest(body, model, isStream) {
  // `store:false` matches the CLI (9router forces it too): a server-stored
  // response belongs to the account that created it, and `Bearer public` is a
  // pool — a later turn can land on another account and 404 the reference.
  const payload = { model, input: chatMessagesToInput(body.messages), stream: !!isStream, store: false }
  if (body.temperature != null) payload.temperature = body.temperature
  if (body.top_p != null) payload.top_p = body.top_p
  if (body.parallel_tool_calls != null) payload.parallel_tool_calls = body.parallel_tool_calls
  const tools = chatToolsToResponses(body.tools)
  if (tools) payload.tools = tools
  if (body.tool_choice != null) {
    const tc = body.tool_choice
    payload.tool_choice = typeof tc === "string" ? tc : { type: "function", name: tc?.function?.name ?? tc?.name }
  }
  // Reasoning-first models (muse-spark, gpt-5/6) burn hundreds of tokens on
  // reasoning before emitting text, so a tiny cap yields an empty completion.
  // Only forward a budget the caller actually asked for.
  const mt = body.max_completion_tokens ?? body.max_tokens
  if (mt != null && Number.isFinite(Number(mt)) && Number(mt) > 0) payload.max_output_tokens = Number(mt)
  // The Responses endpoint takes thinking as reasoning:{effort,summary} and
  // rejects `reasoning_effort` outright ("unknown variant"). Chat callers and
  // Anthropic's thinking:{type:"enabled",budget_tokens} both arrive in shapes
  // it will not read, so normalize here or the caller silently loses thinking.
  const reasoning = responsesReasoning(body, model)
  if (reasoning) payload.reasoning = reasoning
  return payload
}


// Reasoning levels this gateway actually serves, per model family. Transcribed
// from 9router's thinkingLevels table for the free ids; `null` means "forward
// whatever the caller asked" — unknown models are not ours to clamp.

// Reasoning levels this gateway actually serves, per model family. Transcribed
// from 9router's thinkingLevels table for the free ids; `null` means "forward
// whatever the caller asked" — unknown models are not ours to clamp.
const THINKING_LEVELS = [
  [/deepseek-v4\.1-flash-free/, ["low", "high", "max"]],
  [/mimo.*v2\.6/, ["none", "minimal", "low", "medium", "high", "xhigh", "max"]],
  [/deepseek-v4\./, ["none", "low", "medium", "high", "xhigh", "max"]],
  [/gpt-5|gpt-6|muse-spark|grok-/, ["none", "minimal", "low", "medium", "high", "xhigh", "max"]],
]

function thinkingLevelsFor(model) {
  const id = String(model ?? "")
  for (const [re, levels] of THINKING_LEVELS) if (re.test(id)) return levels
  return null
}


// "ultra" is Claude Code's top tier and does not exist upstream; map down to
// the best level the model does serve, exactly as 9router does. "auto" means
// "let the model decide", which is the same as sending nothing.

// "ultra" is Claude Code's top tier and does not exist upstream; map down to
// the best level the model does serve, exactly as 9router does. "auto" means
// "let the model decide", which is the same as sending nothing.
function normalizeEffort(effort, model) {
  let e = String(effort ?? "").toLowerCase().trim()
  if (!e || e === "auto") return null
  const levels = thinkingLevelsFor(model)
  if (!levels) return e
  if (levels.includes(e)) return e
  if (e === "ultra" || e === "max") {
    if (levels.includes("max")) return "max"
    if (levels.includes("xhigh")) return "xhigh"
    if (levels.includes("high")) return "high"
  }
  // An unsupported level is a 400 upstream; the nearest lower tier is the
  // honest reading of what the caller asked for.
  const order = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
  const want = order.indexOf(e)
  if (want < 0) return levels[levels.length - 1]
  for (let i = want; i >= 0; i--) if (levels.includes(order[i])) return order[i]
  return levels[0]
}


// Chat-shaped body -> the Responses `reasoning` object (or null for none).
// `model` is passed explicitly: the body may still name the caller's alias
// while the loop is already serving a different candidate.

// Chat-shaped body -> the Responses `reasoning` object (or null for none).
// `model` is passed explicitly: the body may still name the caller's alias
// while the loop is already serving a different candidate.
function responsesReasoning(body, model = body?.model) {
  const current = body?.reasoning && typeof body.reasoning === "object" && !Array.isArray(body.reasoning) ? body.reasoning : null
  let effort = body?.reasoning_effort ?? current?.effort
  // Anthropic thinking:{type:"enabled",budget_tokens}: no effort enum, only a
  // token budget. Map it onto the tiers so adaptive thinking does not vanish.
  if (!effort && body?.thinking && typeof body.thinking === "object") {
    if (body.thinking.type === "disabled") return null
    const b = Number(body.thinking.budget_tokens)
    effort = !Number.isFinite(b) ? "medium" : b <= 2048 ? "low" : b <= 8192 ? "medium" : b <= 24576 ? "high" : "max"
  }
  const normalized = normalizeEffort(effort, model)
  if (!normalized) return null
  return { ...(current ?? {}), effort: normalized, summary: current?.summary || "auto" }
}


// Stream a Responses SSE body back as chat.completion.chunk SSE.

// Stream a Responses SSE body back as chat.completion.chunk SSE.
function relayResponsesStream(req, res, upstreamRes, requested, strip = false, pin = null, keepable = null) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  const id = `chatcmpl-${randomBytes(12).toString("hex")}`
  const created = Math.floor(Date.now() / 1000)
  const base = { id, object: "chat.completion.chunk", created, model: requested }
  // The pinned filter spans blocks like every other one: a call's name and its
  // argument chunks arrive in separate events under the same call id.
  const state = { tools: [], usage: null, finish: "stop", dropped: new Set(), kept: false, count: 0, renumber: new Map() }
  let sawFinish = false
  let upstreamErr = null
  const reader = upstreamRes.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const wall = relayWall()
  wall.signal.addEventListener("abort", () => {
    reader.cancel().catch(() => {})
  })
  res.on?.("close", () => {
    if (!res.writableEnded) wall.abort()
  })
  const cleanup = () => wall.release()
  const send = (choices, extra) =>
    res.write(`data: ${JSON.stringify({ ...base, choices, ...(extra ?? {}) })}\n\n`)

  const pump = async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        wall.touch()
        buffer = appendSse(buffer, decoder.decode(value, { stream: true }))
        let idx
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          if (!block.trim()) continue
          let event = ""
          let raw = ""
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim()
            else if (line.startsWith("data:")) raw = line.slice(5).trim()
          }
          if (!raw || raw === "[DONE]") continue
          let data
          try {
            data = JSON.parse(raw)
          } catch {
            continue
          }
          if (data?.response?.usage) state.usage = data.response.usage
          if (data?.type === "response.completed" || data?.type === "response.incomplete") {
            sawFinish = true
            // `strip` (the tool-less bridge) and the pinned filter both swallow
            // calls: a finish that claims tool_calls must not outlive them.
            state.finish =
              data.type === "response.incomplete"
                ? "length"
                : strip
                  ? "stop"
                  : pin || keepable
                    ? // A filtered turn keeps the tool_calls claim only when a
                      // call survived the filter.
                      state.kept
                      ? "tool_calls"
                      : "stop"
                    : state.tools.length
                      ? "tool_calls"
                      : "stop"
            continue
          }
          if (data?.type === "error" || data?.error) {
            if (!upstreamErr) upstreamErr = data?.error?.message ?? (typeof data?.message === "string" ? data.message : null)
            if (!upstreamErr) upstreamErr = "upstream stream error"
            continue
          }
          for (let delta of responsesEventToDeltas(event, data, state)) {
            if (strip && delta.tool_calls) delete delta.tool_calls
            else if ((pin || keepable) && Array.isArray(delta.tool_calls)) {
              const kept = []
              for (const tc of delta.tool_calls) {
                const idx = tc?.index ?? 0
                if (tc?.function?.name) {
                  if (pin) {
                    if (tc.function.name === pin) {
                      if (!state.renumber.has(idx)) state.renumber.set(idx, state.count++)
                      state.kept = true
                    } else {
                      state.dropped.add(idx)
                      continue
                    }
                  } else if (keepable && !keepable(tc.function.name)) {
                    state.dropped.add(idx)
                    continue
                  } else {
                    if (!state.renumber.has(idx)) state.renumber.set(idx, state.count++)
                    state.kept = true
                  }
                } else if (state.dropped.has(idx)) continue
                if (state.renumber.has(idx)) tc.index = state.renumber.get(idx)
                kept.push(tc)
              }
              if (kept.length) delta.tool_calls = kept
              else delete delta.tool_calls
            }
            if (Object.keys(delta).length === 0) continue
            send([{ index: 0, delta, finish_reason: null }])
          }
        }
        await waitDrain(res)
      }
      if (sawFinish) {
        send([{ index: 0, delta: {}, finish_reason: state.finish }], state.usage ? { usage: usageToChat(state.usage) } : {})
        res.write("data: [DONE]\n\n")
      } else {
        // Upstream never declared completion: end with the failure instead of
        // a finish_reason the model never reached (measured: hostile mid-cut).
        if (!req.signal?.aborted && !clientGone(res)) {
          markStreamFailure(res)
          res.write(`data: ${JSON.stringify({ error: { type: "upstream_error", message: upstreamErr ?? (wall.state.stalled ? "upstream stalled past the relay wall" : "upstream stream ended mid-reply") } })}\n\n`)
          res.write("data: [DONE]\n\n")
        }
      }
      await waitDrain(res)
      res.end()
    } catch (err) {
      if (!req.signal?.aborted && !clientGone(res)) {
        markStreamFailure(res)
        res.write(`data: ${JSON.stringify({ error: { type: "upstream_error", message: upstreamErr ?? err?.message ?? "upstream stream ended mid-reply" } })}\n\n`)
        res.write("data: [DONE]\n\n")
      }
      res.end()
    } finally {
      cleanup()
    }
  }
  return pump()
}


// chat.completions SSE -> Responses SSE, for a Responses-shaped caller whose
// model lives on /chat/completions. Event dialect mirrors what the upstream
// gateway itself emits for native /responses traffic, emitted live — the
// callers here are agents, and buffering the stream would throw the latency
// away.

// chat.completions SSE -> Responses SSE, for a Responses-shaped caller whose
// model lives on /chat/completions. Event dialect mirrors what the upstream
// gateway itself emits for native /responses traffic, emitted live — the
// callers here are agents, and buffering the stream would throw the latency
// away.
function relayChatAsResponsesStream(req, res, upstreamRes, requested, strip = false, pin = null, keepable = null) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  const id = `resp_${randomBytes(12).toString("hex")}`
  const created = Math.floor(Date.now() / 1000)
  const evt = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  evt("response.created", { response: { id, object: "response", created_at: created, status: "in_progress", model: requested, output: [] } })

  // Output items are created lazily at their first delta, so a reply with no
  // text or no calls produces no empty items. Reasoning deltas are delivered
  // as reasoning_text events live, without item framing of their own — the
  // same as the upstream relay emits them.
  const items = []
  const st = {
    message: null, // { index, text } — opened at the first content delta
    calls: new Map(), // chat index -> { index, id, callId, name, args }
    usage: null,
    finished: false, // a finish chunk or [DONE] was seen upstream
    reason: null, // the chat finish_reason, so a capped reply can say so
    dropped: new Set(), // pinned-filter: chat indices that name a stray call
  }

  // Same relay wall as the pumps that hold their own reader: unlike them this
  // one had NO timer, so a dead upstream stalled the stream forever. Cancelling
  // the generator ends the loop cleanly into the mid-reply handling below.
  const chunksIter = sseChunks(upstreamRes)
  const wall = relayWall()
  wall.signal.addEventListener("abort", () => { chunksIter.return?.()?.catch?.(() => {}) })
  res.on?.("close", () => {
    if (!res.writableEnded) wall.abort()
  })
  const cleanup = () => wall.release()

  const pump = async () => {
    try {
      for await (const chunk of chunksIter) {
        wall.touch()
        if (chatBlockTerminal(chunk)) st.finished = true
        let raw = ""
        for (const line of chunk.split("\n")) if (line.startsWith("data:")) raw = line.slice(5).trim()
        if (!raw || raw === "[DONE]") continue
        let d
        try {
          d = JSON.parse(raw)
        } catch {
          continue
        }
        if (d?.error) throw new Error(d.error.message ?? "upstream stream error")
        if (d?.usage) st.usage = d.usage
        const choice = d?.choices?.[0]
        if (!choice) continue
        if (choice.finish_reason) st.reason = choice.finish_reason
        const delta = choice.delta ?? {}
        if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
          evt("response.reasoning_text.delta", { delta: delta.reasoning_content })
        }
        if (typeof delta.content === "string" && delta.content) {
          if (!st.message) {
            const index = items.length
            const item = { type: "message", role: "assistant", content: [] }
            items.push(item)
            st.message = { index, text: "" }
            evt("response.output_item.added", { output_index: index, item: { ...item, status: "in_progress" } })
            evt("response.content_part.added", { output_index: index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } })
          }
          st.message.text += delta.content
          evt("response.output_text.delta", { output_index: st.message.index, content_index: 0, delta: delta.content })
        }
        // Responses replies put tool calls after the message as sibling output
        // items, not interleaved into the message's content parts — so each
        // call opens its own item the first time its (renumbered) chunk shows.
        for (const tc of strip ? [] : delta.tool_calls ?? []) {
          const tIndex = tc.index ?? 0
          // Same per-index contract the other relays carry: the name names the
          // call once, argument chunks follow under the same index nameless.
          if (tc.function?.name) {
            if (pin && tc.function.name !== pin) {
              st.dropped.add(tIndex)
              continue
            }
            if (!pin && keepable && !keepable(tc.function.name)) {
              st.dropped.add(tIndex)
              continue
            }
          } else if (st.dropped.has(tIndex)) {
            continue
          }
          if (!st.calls.has(tIndex)) {
            const index = items.length
            const item = { type: "function_call", id: `fc_${randomBytes(8).toString("hex")}`, call_id: tc.id ?? `call_${index}`, name: tc.function?.name ?? "unknown", arguments: "" }
            const entry = { index, item, args: "" }
            st.calls.set(tIndex, entry)
            items.push(item)
            evt("response.output_item.added", { output_index: index, item: { ...item, status: "in_progress" } })
          }
          const entry = st.calls.get(tIndex)
          if (tc.function?.arguments) {
            entry.args += tc.function.arguments
            evt("response.function_call_arguments.delta", { item_id: entry.item.id, output_index: entry.index, delta: tc.function.arguments })
          }
        }
      }
      // Stream complete: close what was opened in output order, then completed.
      if (!st.finished) {
        // The chat-chunk stream never reached a finish chunk (measured: hostile
        // mid-cut): emitting response.completed would tell the caller a turn
        // ended that upstream never finished. The Responses dialect carries
        // mid-stream failure as an `error` event.
        if (!req.signal?.aborted && !clientGone(res)) {
          markStreamFailure(res)
          evt("error", { error: { type: "api_error", message: wall.state.stalled ? "upstream stalled past the relay wall" : "upstream stream ended mid-reply" } })
        }
        res.end()
        return
      }
      const output = items.map((item) => {
        if (item.type === "message") {
          item.id = `msg_${id}`
          item.status = "completed"
          item.content = [{ type: "output_text", text: st.message?.text ?? "", annotations: [] }]
        }
        if (item.type === "function_call") {
          const entry = [...st.calls.values()].find((e) => e.item === item)
          item.status = "completed"
          item.arguments = entry?.args ?? item.arguments
        }
        return item
      })
      if (st.message) evt("response.output_text.done", { output_index: st.message.index, content_index: 0, text: st.message.text })
      for (const entry of st.calls.values()) {
        evt("response.function_call_arguments.done", { item_id: entry.item.id, output_index: entry.index, arguments: entry.args })
      }
      items.forEach((item, i) => {
        evt("response.output_item.done", { output_index: i, item })
      })
      // A reply cut off at the token cap is not a completed answer; the
      // Responses dialect carries that as `incomplete` + `incomplete_details`.
      const truncated = st.reason === "length"
      evt(truncated ? "response.incomplete" : "response.completed", {
        response: {
          id,
          object: "response",
          created_at: created,
          status: truncated ? "incomplete" : "completed",
          ...(truncated ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
          model: requested,
          output,
          usage: {
            input_tokens: st.usage?.prompt_tokens ?? 0,
            output_tokens: st.usage?.completion_tokens ?? 0,
            total_tokens: st.usage?.total_tokens ?? (st.usage?.prompt_tokens ?? 0) + (st.usage?.completion_tokens ?? 0),
          },
        },
      })
      await waitDrain(res)
      res.end()
    } catch (err) {
      // The 200 is on the wire already: announce the collapse in-band.
      if (!req.signal?.aborted && !clientGone(res)) {
        markStreamFailure(res)
        evt("error", { error: { type: "api_error", message: err?.message ?? "upstream stream ended mid-reply" } })
      }
      res.end()
    }
  }
  return pump()
}


// Responses SSE -> client, for a Responses-shaped caller whose model is a
// native /responses one: upstream already speaks the same dialect, so this is
// a passthrough that rewrites the model and drops calls the caller cannot run
// (the bridge manifest's, and everything but the pinned one).

// Responses SSE -> client, for a Responses-shaped caller whose model is a
// native /responses one: upstream already speaks the same dialect, so this is
// a passthrough that rewrites the model and drops calls the caller cannot run
// (the bridge manifest's, and everything but the pinned one).
function relayResponsesPassthrough(req, res, upstreamRes, requested, strip = false, pin = null, keepable = null) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  const dropped = new Set()
  const allowed = new Set()
  // A call identity travels under up to three names: `id` (fc_…), `call_id`
  // (call_…), and, in argument events, `item_id`. The old code recorded a
  // decision under `call_id` but looked argument deltas up by `item_id`, so the
  // two never matched and a dropped call still leaked its whole argument JSON.
  // Every identifier an item carries is remembered under both sets.
  const idsOf = (item) =>
    [item?.id, item?.call_id, item?.item_id].filter((v) => typeof v === "string" && v)
  // One decision rule for every shape a call can arrive in: the added item
  // carries the name, the later chunks reference it by id.
  const decide = (item) => {
    const ids = idsOf(item)
    const name = item?.name
    if (name) {
      if (strip || (pin && name !== pin) || (!pin && keepable && !keepable(name))) {
        for (const id of ids) dropped.add(id)
        return false
      }
      for (const id of ids) allowed.add(id)
      return true
    }
    if (ids.some((id) => allowed.has(id))) return true
    if (ids.some((id) => dropped.has(id))) return false
    // No name and no prior decision: only pass it when nothing is being
    // filtered (a pin, a strip or a keepable rule all mean "unknown = drop").
    return !(pin || strip || keepable)
  }
  const reader = upstreamRes.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let sawFinish = false
  let upstreamErr = null
  const wall = relayWall()
  wall.signal.addEventListener("abort", () => {
    reader.cancel().catch(() => {})
  })
  res.on?.("close", () => {
    if (!res.writableEnded) wall.abort()
  })
  const cleanup = () => wall.release()
  const parseBlock = (block) => {
    let event = ""
    let raw = ""
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim()
      else if (line.startsWith("data:")) raw = line.slice(5).trim()
    }
    if (!raw || raw === "[DONE]") return null
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }
  const pump = async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        wall.touch()
        buffer = appendSse(buffer, decoder.decode(value, { stream: true }))
        let idx
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          if (!block.trim()) continue
          const data = parseBlock(block)
          if (!data) continue
          if (data?.response?.model && typeof data.response.model === "string") data.response.model = requested
          const type = data?.type ?? ""
          if (type === "response.completed" || type === "response.incomplete") sawFinish = true
          else if (type === "error" || data?.error) {
            if (!upstreamErr) upstreamErr = data?.error?.message ?? (typeof data?.message === "string" ? data.message : null)
            if (!upstreamErr) upstreamErr = "upstream stream error"
          }
          if (type === "response.output_item.added" || type === "response.output_item.done") {
            if (data.item?.type === "function_call" && !decide(data.item)) continue
          } else if (type.startsWith("response.function_call_arguments")) {
            const callId = data.item_id ?? data.call_id
            if (strip || dropped.has(callId)) continue
          } else if ((type === "response.completed" || type === "response.incomplete") && Array.isArray(data.response?.output)) {
            data.response.output = data.response.output.filter((item) => (item?.type === "function_call" ? decide(item) : true))
          }
          res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
          await waitDrain(res)
        }
      }
      const tail = flushSse(buffer)
      if (tail.trim()) {
        const data = parseBlock(tail)
        if (data) {
          if (data?.response?.model && typeof data.response.model === "string") data.response.model = requested
          res.write(`event: ${data?.type ?? ""}\ndata: ${JSON.stringify(data)}\n\n`)
          if (data?.type === "response.completed" || data?.type === "response.incomplete") sawFinish = true
        }
      }
      // No completion event ever arrived: the stream died mid-reply (measured
      // against a hostile cut). The Responses dialect says failure as an
      // `error` event; silence reads like a successful partial turn.
      if (!sawFinish && !req.signal?.aborted && !clientGone(res)) {
        markStreamFailure(res)
        res.write(`event: error\ndata: ${JSON.stringify({ type: "error", code: "upstream_error", message: upstreamErr ?? (wall.state.stalled ? "upstream stalled past the relay wall" : "upstream stream ended mid-reply") })}\n\n`)
      }
      await waitDrain(res)
      res.end()
    } catch (err) {
      if (!req.signal?.aborted && !clientGone(res)) {
        markStreamFailure(res)
        res.write(`event: error\ndata: ${JSON.stringify({ type: "error", code: "upstream_error", message: upstreamErr ?? err?.message ?? "upstream stream ended mid-reply" })}\n\n`)
      }
      res.end()
    } finally {
      cleanup()
    }
  }
  return pump()
}

export {
  withStreamUsage,
  responsesRequest,
  THINKING_LEVELS,
  thinkingLevelsFor,
  normalizeEffort,
  responsesReasoning,
  relayResponsesStream,
  relayChatAsResponsesStream,
  relayResponsesPassthrough,
}
