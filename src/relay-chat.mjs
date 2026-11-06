// The chat.completions relays, including the Anthropic translation on the way out.
import { remapAgentTool } from "./catalogs.mjs"
import { json } from "./net.mjs"
import { STOP_REASON } from "./wire/anthropic.mjs"
import { randomBytes } from "node:crypto"
import { chatBlockTerminal, chatBlockError, appendSse, flushSse, relayWall, clientGone, markStreamFailure, waitDrain, pinStreamState, rewriteSSE } from "./sse.mjs"

function relayAnthropicStream(req, res, chunks, requested, servedBy, strip = false, pin = null, keepable = null) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    // Streaming responses get no JSON body a client could inspect, so the
    // serving model is exposed as headers instead.
    ...(servedBy && servedBy !== requested ? { "x-zen-served-by": servedBy, "x-zen-fallback": "true" } : {}),
  })
  const id = `msg_${randomBytes(12).toString("hex")}`
  const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)

  // Content blocks are numbered in the order they open. Thinking and text used
  // to both claim index 0, which is a malformed stream: two blocks with the
  // same index, and every delta/stop attributed to whichever the client opened
  // first. A single counter keeps thinking, text and tool blocks distinct.
  const st = { textOpen: false, textIndex: -1, thinkOpen: false, thinkIndex: -1, blocks: new Map(), finish: "stop", finished: false, usage: null, dropped: new Set(), kept: false, callKept: false, nextBlock: 0 }
  emit("message_start", {
    message: {
      id,
      type: "message",
      role: "assistant",
      model: requested,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })

  const openBlock = (content_block) => {
    const index = st.nextBlock++
    emit("content_block_start", { index, content_block })
    return index
  }
  // Tool blocks in the plain path keep their upstream index + 1 (the layout
  // Anthropic clients have always been fed by this proxy), so the shared
  // counter has to jump past whatever index that produced.
  const takeToolBlock = (tIndex) => {
    const index = Math.max(st.nextBlock, tIndex + 1)
    st.nextBlock = index + 1
    return index
  }
  const closeText = () => {
    if (st.textOpen) {
      emit("content_block_stop", { index: st.textIndex })
      st.textOpen = false
    }
  }
  const closeThink = () => {
    if (st.thinkOpen) {
      emit("content_block_stop", { index: st.thinkIndex })
      st.thinkOpen = false
    }
  }

  // Canceling the chunks generator makes the loop below end cleanly and reach
  // the same mid-reply handling, where the stall is named for what it is. The
  // same cancel happens when the client goes away: the turn is over, so stop
  // pulling tokens upstream instead of paying for a reply nobody will read.
  const wall = relayWall()
  wall.signal.addEventListener("abort", () => { chunks.return?.()?.catch?.(() => {}) })
  res.on?.("close", () => {
    if (!res.writableEnded) wall.abort()
  })
  const cleanup = () => wall.release()

  const pump = async () => {
    try {
      for await (const chunkText of chunks) {
        wall.touch()
        if (chatBlockTerminal(chunkText)) st.finished = true
        {
          for (const line of chunkText.split("\n")) {
            if (!line.startsWith("data:")) continue
            const raw = line.slice(5).trim()
            if (!raw || raw === "[DONE]") continue
            let d
            try {
              d = JSON.parse(raw)
            } catch {
              continue
            }
            if (!d || typeof d !== "object") continue
            // Upstream declares the reply failed with an explicit error chunk;
            // dropping it (the old behavior) presented a truncated stream as a
            // clean end_turn. Reaching the catch emits the real `error` event.
            if (d.error) throw new Error(d.error.message ?? "upstream stream error")
            if (d.usage) st.usage = d.usage
            const choice = d.choices?.[0]
            const delta = choice?.delta ?? {}
            // The bridge tools exist only to satisfy the gate; a caller that
            // offered none must never see a call to one (see stripToolCalls).
            if (choice?.finish_reason) st.finish = strip && choice.finish_reason === "tool_calls" ? "stop" : choice.finish_reason
            if (typeof delta.content === "string" && delta.content) {
              closeThink()
              if (!st.textOpen) {
                st.textIndex = openBlock({ type: "text", text: "" })
                st.textOpen = true
              }
              emit("content_block_delta", { index: st.textIndex, delta: { type: "text_delta", text: delta.content } })
            }
            if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
              if (!st.textOpen && !st.thinkOpen) {
                st.thinkIndex = openBlock({ type: "thinking", thinking: "", signature: "" })
                st.thinkOpen = true
              }
              emit("content_block_delta", { index: st.thinkIndex, delta: { type: "thinking_delta", thinking: delta.reasoning_content } })
            }
            for (const tc of strip ? [] : delta.tool_calls ?? []) {
              closeThink()
              closeText()
              const tIndex = tc.index ?? 0
              // A call's name arrives in its first chunk; argument chunks for it
              // follow under the same index with `name: null`. So the keep/drop
              // decision is made at the name chunk and remembered per index —
              // otherwise a strip would leak the dropped call's arguments.
              if (tc.function?.name) {
                // A call the caller cannot run — a manifest name with no
                // equivalent of the caller's, or a completely invented one —
                // never reaches it: the decision is made on the raw name
                // before any agent-tool remapping could rename it.
                if (!pin && keepable && !keepable(tc.function.name)) {
                  st.dropped.add(tIndex)
                  continue
                }
                const mapped = remapAgentTool(tc.function.name, "{}")
                const resolved = mapped ? mapped.name : tc.function.name
                if (pin && resolved !== pin) {
                  st.dropped.add(tIndex)
                  continue
                }
                if (pin) st.kept = true
                st.callKept = true
              } else if (st.dropped.has(tIndex)) {
                continue
              }
              const blockIndex = st.blocks.has(tIndex) ? st.blocks.get(tIndex).index : takeToolBlock(tIndex)
              if (!st.blocks.has(tIndex)) {
                const rawName = tc.function?.name ?? "unknown"
                const mapped = remapAgentTool(rawName, "{}")
                st.blocks.set(tIndex, {
                  index: blockIndex,
                  id: tc.id ?? `toolu_${randomBytes(8).toString("hex")}`,
                  raw: rawName,
                  name: mapped ? mapped.name : rawName,
                  args: "",
                })
                emit("content_block_start", {
                  index: blockIndex,
                  content_block: { type: "tool_use", id: st.blocks.get(tIndex).id, name: st.blocks.get(tIndex).name, input: {} },
                })
              }
              if (tc.function?.arguments) st.blocks.get(tIndex).args += tc.function.arguments
            }
          }
        }
      }
      if (!st.finished) {
        // The upstream stream closed without a finish chunk or [DONE]: claiming
        // message_stop would present a truncated reply as a completed turn
        // (measured: hostile mid-cut). Anthropic carries mid-stream failure as
        // an `error` event — emit it, close nothing further, stop. A wall abort
        // cancelled the generator into done — name the stall for what it is.
        closeThink()
        closeText()
        emit("error", { error: { type: "api_error", message: wall.state.stalled ? "upstream stalled past the relay wall" : "upstream stream ended mid-reply" } })
        res.end()
        return
      }
      closeThink()
      closeText()
      for (const t of st.blocks.values()) {
        // Rename the caller's argument keys here too — streamed arguments are
        // accumulated and only emitted at the end of the block.
        const mapped = remapAgentTool(t.raw, t.args || "{}")
        const json = mapped ? mapped.args : t.args || "{}"
        emit("content_block_delta", { index: t.index, delta: { type: "input_json_delta", partial_json: json } })
        emit("content_block_stop", { index: t.index })
      }
      const u = st.usage ?? {}
      // The model claimed a tool call but every call got filtered away: the
      // message ends without one, so it cannot claim tool_use.
      // A tool_calls claim that outlived its calls (pin kept nothing, or every
      // call in a stub-riding turn was the dropped stub) must not survive.
      const claimed = pin ? st.kept : keepable ? st.callKept : true
      const finish = st.finish === "tool_calls" && !claimed ? "stop" : st.finish
      emit("message_delta", {
        delta: { stop_reason: STOP_REASON[finish] ?? "end_turn", stop_sequence: null },
        usage: { input_tokens: u.prompt_tokens ?? 0, output_tokens: u.completion_tokens ?? 0 },
      })
      emit("message_stop", {})
      // No `data: [DONE]` here: that sentinel belongs to the OpenAI dialect.
      // Anthropic clients end the stream on message_stop and an unexpected
      // [DONE] is, at best, ignored junk.
      await waitDrain(res)
      res.end()
    } catch (err) {
      if (!req.signal?.aborted && !clientGone(res)) {
        closeThink()
        closeText()
        // The 200 is already on the wire; Anthropic's mid-stream failure event
        // is the only way left to tell the caller the turn collapsed.
        markStreamFailure(res, err?.message ?? "upstream stream ended mid-reply")
        emit("error", { error: { type: "api_error", message: err?.message ?? "upstream stream ended mid-reply" } })
      }
      res.end()
    } finally {
      cleanup()
    }
  }
  return pump()
}


// A caller that sent no tools cannot run one, and the gateway hands them back
// anyway — it ignores tool_choice "none" and answers a plain summarization
// prompt with real read calls, which pi treats as a hard failure. So drop them
// from the reply, and never claim a tool call in finish_reason.

function relayStream(req, res, upstreamRes, requested, strip = false, pin = null, keepable = null) {
  res.writeHead(200, {
    "content-type": upstreamRes.headers.get("content-type") ?? "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  // One bookkeeping object per request: a pinned call's chunks span several SSE
  // blocks, so the filter cannot see them one at a time. Calls the caller
  // cannot run ride the same per-index bookkeeping for dropping those.
  const pinned = pin || keepable ? pinStreamState(pin, keepable) : null
  const reader = upstreamRes.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let sawFinish = false
  let upstreamErr = null
  const wall = relayWall()
  wall.signal.addEventListener("abort", () => {
    reader.cancel().catch(() => {})
  })
  // The client hung up: stop reading upstream so a turn nobody will read stops
  // consuming quota now rather than at the model's own pace.
  res.on?.("close", () => {
    if (!res.writableEnded) wall.abort()
  })
  const cleanup = () => wall.release()
  const midReplyError = (message) => {
    // The 200 line is already on the wire — an in-band error chunk plus the
    // [DONE] sentinel is the only honest ending left. SDKs raise on error
    // chunks instead of returning a silent half-turn.
    if (!req.signal?.aborted && !clientGone(res)) {
      markStreamFailure(res, message)
      res.write(`data: ${JSON.stringify({ error: { type: "upstream_error", message } })}\n\n`)
      res.write("data: [DONE]\n\n")
    }
    res.end()
  }
  const pump = async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          const tail = flushSse(buffer)
          if (tail.trim()) res.write(tail)
          // Upstream closed without delivering a finish chunk or [DONE]: the
          // reply died in flight, and a silent end reads like a successful
          // empty turn (measured against a hostile mid-cut). A wall abort
          // cancels the reader into done — name the stall for what it is.
          if (!sawFinish) midReplyError(upstreamErr ?? (wall.state.stalled ? "upstream stalled past the relay wall" : "upstream stream ended mid-reply"))
          else {
            await waitDrain(res)
            res.end()
          }
          return
        }
        wall.touch()
        buffer = appendSse(buffer, decoder.decode(value, { stream: true }))
        let idx
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          if (!upstreamErr) upstreamErr = chatBlockError(block)
          const out = rewriteSSE(block, requested, strip, pinned)
          if (out) res.write(out)
          if (chatBlockTerminal(block)) sawFinish = true
          await waitDrain(res)
        }
      }
    } catch (err) {
      // The reader died (cut, reset, abort). Nothing more can come upstream;
      // surface it in-band before ending.
      midReplyError(upstreamErr ?? err?.message ?? "upstream stream ended mid-reply")
    } finally {
      cleanup()
    }
  }
  return pump()
}


// The proxy always streams upstream even when the caller asked for one JSON
// reply, so `stream_options` has to be requested here rather than forwarded
// from a caller who never asked to stream. Without it the gateway sends no
// usage chunk at all and every collected reply reported zero tokens.

export {
  relayAnthropicStream,
  relayStream,
}
