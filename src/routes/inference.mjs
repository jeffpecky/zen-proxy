// The inference routes: /v1/messages and /v1/chat|/v1/responses.
import { aliasGatedTools, gateBridgeTools, keepableFor, pinnedToolName, restoreToolNames } from "../bridge.mjs"
import { applyFingerprintTools } from "../catalogs.mjs"
import { config, maskKey } from "../config.mjs"
import { zenHeaders } from "../headers.mjs"
import { log } from "../log.mjs"
import { modelFormat, resolveModel } from "../model.mjs"
import { authForUpstream, json, readBody } from "../net.mjs"
import { bridgePreamble, injectPreamble } from "../preamble.mjs"
import { exhaustedFreeVerdict, parseRetryAfter, retryableUpstream, transientUpstream } from "../retry.mjs"
import { rotateEgress } from "../session.mjs"
import { recordObserved, recordReq } from "../stats.mjs"
import { collectChatCompletion, collectResponses, headersWall, responsesChunksAsChat, sseChunks } from "../sse.mjs"
import { relayAnthropicStream, relayStream } from "../relay-chat.mjs"
import { stripToolCalls, stripUnpinnedCalls } from "../sse.mjs"
import { relayChatAsResponsesStream, relayResponsesPassthrough, relayResponsesStream, responsesRequest, withStreamUsage } from "../relay-responses.mjs"
import { maskProxyUrl, upstreamFetch } from "../tls.mjs"
import { anthropicError, anthropicToChatBody, chatToAnthropic } from "../wire/anthropic.mjs"
import { chatToResponses, filterResponsesOutput, responsesInputItemArray, responsesInputToChatBody, responsesToChat, sanitizeResponsesItems } from "../wire/responses.mjs"


async function handleMessages(req, res) {
  const start = Date.now()
  let body
  try {
    body = JSON.parse(await readBody(req))
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      const e = anthropicError(400, { error: { type: "invalid_request_error", message: "body must be a JSON object" } })
      return json(res, e.status, e.body)
    }
  } catch (err) {
    const e = anthropicError(err?.statusCode === 413 ? 413 : 400, {
      error: { type: err?.statusCode === 413 ? "request_too_large" : "invalid_request_error", message: err?.message ?? "invalid JSON body" },
    })
    return json(res, e.status, e.body)
  }

  // Anthropic-shaped tools are {name, input_schema}; the gate only reads the
  // declared name, so the same rename covers this leg.
  const gatedTools = aliasGatedTools(body)
  if (gatedTools.size) {
    restoreToolNames(res, gatedTools)
    log(`   declared tool name "${[...gatedTools.values()].join('", "')}" is gated by the free tier — sent as ${[...gatedTools.keys()].join(", ")}`)
  }
  const { requested, candidates } = resolveModel(body.model)
  const isStream = !!body.stream
  // The credential decision (including `x-api-key`) lives entirely in
  // authForUpstream(), so this route cannot accept a token the OpenAI-shaped
  // routes would reject — see the note there about the proxy key.
  let auth = authForUpstream(req)
  if (!auth) {
    recordReq(req, requested, Date.now() - start, 401)
    const e = anthropicError(401, { error: { type: "authentication_error", message: "invalid proxy key" } })
    return json(res, e.status, e.body)
  }
  // An Anthropic client always sends some token (Claude Code uses whatever
  // ANTHROPIC_AUTH_TOKEN holds, which for a local proxy is usually a placeholder).
  // If upstream rejects it, fall back to the configured key or the anonymous tier
  // rather than failing the request outright.
  const fallbackAuth = config.apiKeys.length || config.adminPassword ? null : config.defaultZenKey ? `Bearer ${config.defaultZenKey}` : "Bearer public"
  let triedFallback = false
  let triedByok = false
  let rotated429 = false

  let lastErr = null
  let lastStatus = 502
  let firstErr = null
  let firstStatus = 0
  let used = requested
  // The model the client chose is tried first; transient failures are retried
  // against that same model before the chain moves on.
  const retries = config.retriesPerModel > 0 ? Math.floor(config.retriesPerModel) : 0
  // Same bridge rule as the chat path: the manifest rides on every request.
  // `bridged` now only means "callerless" — a title-gen helper or a plain API
  // call — which still gets `tool_choice` pinned off so the answer is text.
  const bridge = gateBridgeTools()
  const bridged = bridge.length > 0 && !(body?.tools ?? []).length
  // A caller that pins a tool gets a reply that carries only that call: the
  // provider ignores the pin sometimes, and stray manifest calls (the
  // injected `read` included) are tools the caller cannot meaningfully run.
  // The relay layers keep the pinned call and drop the rest.
  const keepable = bridged ? null : keepableFor(body?.tools, true)
  const pin = bridged ? null : pinnedToolName(body.tool_choice)
  for (const model of candidates) {
    const chosen = model === candidates[0]
    used = model
    const format = modelFormat(model)
    // Upstream only ever sees streams (see collectChatCompletion); whether the
    // client asked for one decides how the reply is shaped, not what is sent.
    // The gate's read stub, when the caller needs one, rides inside the
    // translated body (see anthropicToChatBody) — this must not inject again.
    const chatShaped = anthropicToChatBody(body, model)
    const payload = format === "responses" ? responsesRequest(chatShaped, model, true) : withStreamUsage({ ...chatShaped, stream: true }, model)
    // Callerless bridged request: the manifest and preamble are for the gate;
    // the answer to "summarize this" must be text, not a tool call.
    if (bridged) {
      // /responses takes only "auto"; the chat endpoint takes the pin.
      if (format === "responses") delete payload.tool_choice
      else payload.tool_choice = "none"
    }
    let delayMs = 0
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
      delayMs = 0
      let upstreamRes
      const wall = isStream ? headersWall() : null
      try {
        upstreamRes = await upstreamFetch(`${config.upstream}${format === "responses" ? "/responses" : "/chat/completions"}`, {
          method: "POST",
          headers: zenHeaders(req, auth),
          body: JSON.stringify(payload),
          signal: isStream ? wall.signal : AbortSignal.timeout(config.timeoutMs),
        })
        if (wall) wall.release()
      } catch (err) {
        if (wall) wall.release()
        lastErr = { error: { type: "api_error", message: err.message } }
        lastStatus = 502
        if (attempt < retries) {
          delayMs = config.retryBackoffMs * (attempt + 1)
          continue
        }
        recordObserved(model, false)
        break
      }

      if (upstreamRes.status === 401 && !triedFallback && fallbackAuth && fallbackAuth !== auth) {
        triedFallback = true
        auth = fallbackAuth
        attempt--
        continue
      }

      if (upstreamRes.ok) {
        if (isStream) {
          const chunks = format === "responses" ? responsesChunksAsChat(upstreamRes) : sseChunks(upstreamRes)
          // Fire-and-forget: the pump owns every client-visible failure, but
          // undici can also reject a socket that died behind the Response after
          // the pump is done — measured as process-level "TypeError:
          // terminated" noise. Sink the promise; the log guard stays for real
          // surprises.
          relayAnthropicStream(req, res, chunks, requested, model, bridged, pin, keepable).catch(() => {})
          res.on("finish", () => {
            // A relay that died mid-reply (in-band `error` event) is recorded as
            // the failure it was, not as a clean 200 (see markStreamFailure).
            recordReq(req, `${requested}→${model}`, Date.now() - start, res.streamFailure ? 502 : 200)
            recordObserved(model, !res.streamFailure)
          })
          return
        }
        try {
          const content = format === "responses" ? await collectResponses(upstreamRes) : await collectChatCompletion(upstreamRes)
          const shaped = stripUnpinnedCalls(stripToolCalls(format === "responses" ? responsesToChat(content, requested, model) : content, bridged), pin, keepable)
          recordReq(req, `${requested}→${model}`, Date.now() - start, 200)
          recordObserved(model, true)
          if (model !== requested) {
            res.setHeader?.("x-zen-served-by", model)
            res.setHeader?.("x-zen-fallback", "true")
          }
          return json(res, 200, chatToAnthropic(shaped, requested, model, pin))
        } catch (err) {
          // Upstream said OK but the reply never arrived whole (a mid-stream
          // error chunk, a cut, a hang-abort). Nothing reached the client yet,
          // so the chain can still save the request: fall through like any
          // other upstream failure and keep the real message for the final
          // surface — "bad upstream response" used to hide what actually
          // happened (measured on the hostile gateway).
          lastErr = { error: { type: "api_error", message: err?.message ? String(err.message) : "bad upstream response" } }
          lastStatus = 502
          recordObserved(model, false)
          break
        }
      }

      try {
        lastErr = await upstreamRes.json()
      } catch {
        // The body could not be read as JSON, so there is nothing to match the
        // "model is unavailable" vocabulary against — a bodyless/text 4xx is a
        // deterministic client-visible error. Type it non-retryable: typing it
        // upstream_error used to make both retry predicates fire and walk the
        // whole fallback chain (~40 upstream calls) for e.g. a text/plain 400.
        lastErr = { error: { type: "invalid_request_error", message: `upstream returned ${upstreamRes.status}` } }
      }
      lastStatus = upstreamRes.status
      // A 429 here is a verdict on this egress flow, not on the model: the
      // session id rides inside the TLS connection, so rotating the id alone
      // keeps answering 429. Drop identity, TLS session and exit IP together
      // before anything retries, so the next attempt (same model, next
      // candidate, or BYOK) arrives on a fresh flow.
      if (upstreamRes.status === 429) {
        const nextProxy = rotateEgress(req)
        if (!rotated429) {
          rotated429 = true
          log(`   429 — rotated identity + TLS session${nextProxy ? " → " + maskProxyUrl(nextProxy) : " (no proxy listed: same exit IP)"}`)
        }
      }
      // The one 429 that is the caller's own spent allowance: retry the same
      // attempt under the configured key before the chain moves on. Same
      // attempt budget (attempt-- mirrors the 401 fallback above), once per
      // request, and the key value never reaches the log.
      if (
        upstreamRes.status === 429 &&
        !triedByok &&
        config.defaultZenKey &&
        auth !== `Bearer ${config.defaultZenKey}` &&
        exhaustedFreeVerdict(upstreamRes.status, lastErr)
      ) {
        triedByok = true
        auth = `Bearer ${config.defaultZenKey}`
        log(`   exhausted free allowance on ${model} — same attempt once under BYOK (${maskKey(config.defaultZenKey)})`)
        attempt--
        continue
      }
      const retryAfterMs = Math.min(parseRetryAfter(upstreamRes.headers.get("retry-after")) * 1000, 3000)
      if (transientUpstream(upstreamRes.status, lastErr) && attempt < retries) {
        delayMs = Math.max(config.retryBackoffMs * (attempt + 1), retryAfterMs)
        continue
      }
      recordObserved(model, false)
      if (retryableUpstream(upstreamRes.status, lastErr)) {
        if (retryAfterMs > 0) await new Promise((r) => setTimeout(r, retryAfterMs))
        break
      }
      // A deterministic client-visible error (bad request, auth, …): report it
      // as-is rather than masking it with the rest of the chain.
      recordReq(req, `${requested}→${used}`, Date.now() - start, lastStatus)
      const e = anthropicError(lastStatus, lastErr)
      res.writeHead(e.status, { "content-type": "application/json" })
      res.end(JSON.stringify(e.body))
      return
    }
    if (chosen && firstErr == null) {
      firstErr = lastErr
      firstStatus = lastStatus
    }
  }

  // Every candidate failed. Surface the error from the model the client asked
  // for — the tail of the chain is an implementation detail and used to leak
  // unrelated failures (e.g. a retired model's 410 "deprecated").
  const finalErr = firstErr ?? lastErr
  const finalStatus = firstErr ? firstStatus : lastStatus
  recordReq(req, requested, Date.now() - start, finalStatus)
  const e = anthropicError(finalStatus, finalErr ?? { error: { type: "api_error", message: "all free models are unavailable" } })
  res.writeHead(e.status, { "content-type": "application/json" })
  res.end(JSON.stringify(e.body))
}


async function handleChat(req, res, responsesRoute = false) {
  const start = Date.now()
  let body
  try {
    const raw = await readBody(req)
    body = JSON.parse(raw)
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return json(res, 400, { error: { type: "invalid_request_error", message: "body must be a JSON object" } })
    }
  } catch (err) {
    if (err && err.statusCode === 413) {
      return json(res, 413, { error: { type: "invalid_request_error", message: "request body too large" } })
    }
    return json(res, 400, { error: { type: "invalid_request_error", message: "invalid JSON body" } })
  }

  // A Responses body carries `input`, not `messages` — and only the /responses
  // leg reads one. Translate it up front; the loop keeps thinking in chat, and
  // exactly those requests get their reply back in Responses format. A
  // chat-shaped body on the same leg keeps today's chat reply, and a
  // chat-shaped body on the chat leg is unchanged.
  const gatedTools = aliasGatedTools(body)
  if (gatedTools.size) {
    restoreToolNames(res, gatedTools)
    log(`   declared tool name "${[...gatedTools.values()].join('", "')}" is gated by the free tier — sent as ${[...gatedTools.keys()].join(", ")}`)
  }
  const responsesRequestShape =
    responsesRoute && body.messages === undefined && body.input !== undefined
  // The gate fingerprints the harness system text; the preamble rides on every
  // wire shape this leg produces (chat messages, chat→responses conversion,
  // and the native /responses passthrough below).
  const chatBodyBase = responsesRequestShape ? responsesInputToChatBody(body) : body
  if (Array.isArray(chatBodyBase?.messages)) chatBodyBase.messages = injectPreamble(chatBodyBase.messages)
  const chatBody = chatBodyBase

  const { requested, candidates } = resolveModel(chatBody.model)
  const isStream = !!chatBody.stream
  let auth = authForUpstream(req)
  if (!auth) {
    recordReq(req, requested, Date.now() - start, 401)
    return json(res, 401, { error: { type: "invalid_request_error", message: "invalid proxy key" } })
  }
  // Mirrors handleMessages: OpenAI-shaped clients usually send a placeholder
  // key (OPENAI_API_KEY=sk-local, or whatever the SDK defaults to), and a
  // configured proxy must not fail just because upstream rejects that string.
  // Only applied when no client key is required, so a proxy credential can never leak.
  const fallbackAuth = config.apiKeys.length || config.adminPassword ? null : config.defaultZenKey ? `Bearer ${config.defaultZenKey}` : "Bearer public"
  let triedFallback = false
  let triedByok = false
  let rotated429 = false
  let lastErr = null
  let lastStatus = 502
  let firstErr = null
  let firstStatus = 0
  let used = requested
  // The model the client chose is tried first; transient failures are retried
  // against that same model before the chain moves on.
  const retries = config.retriesPerModel > 0 ? Math.floor(config.retriesPerModel) : 0
  // The gate refuses any request that does not carry opencode's own tool
  // manifest. Caller tools ride first, then the manifest fills in what is
  // missing: a caller tool named `read`/`shell` keeps its own definition
  // (normalized in place when its arguments allow) rather than being dropped in
  // favour of a duplicate, and the manifest's remaining tools are appended. The
  // reply layer renames and remaps manifest calls back to the caller's
  // equivalent — see remapAgentTool — and `Read`/`read` do not collide by case.
  const bridge = gateBridgeTools()
  const callerTools = Array.isArray(chatBody.tools) ? chatBody.tools : []
  // A copy: the fingerprint pass appends to the array it is given, and mutating
  // chatBody.tools would make a tool-less caller stop looking tool-less (the
  //  flag and its tool_choice:"none" pin are read from it later).
  // A copy for the same reason: applyFingerprintTools appends to the array it
  // is handed, so passing chatBody.tools directly would make every caller look
  // tool-carrying and silently un-pin the bridged tool_choice.
  const { tools: fingerprintTools } = bridge.length
    ? applyFingerprintTools([...callerTools], false)
    : { tools: callerTools }
  const allTools = bridge.length ? [...bridge, ...fingerprintTools] : callerTools
  // One name, one declaration: upstream rejects duplicates, and a manifest tool
  // the caller already carries is already satisfied by that caller tool.
  const mergedTools = []
  const takenNames = new Set()
  for (const t of allTools) {
    const n = t?.function?.name ?? t?.name
    if (!n || takenNames.has(n)) continue
    takenNames.add(n)
    mergedTools.push(t)
  }
  const requestBody = bridge.length ? { ...chatBody, tools: mergedTools } : chatBody
  // Same as before: the pin is the caller's own request; only a callerless
  // bridged request changes `tool_choice` (see the loop below).
  const pin = pinnedToolName(chatBody.tool_choice)
  // `bridged` now means "callerless": the manifest rides on every request, so
  // only a caller without its own tools has the reply stripped of manifest-tool
  // calls (the caller cannot run any of them — the answer must be text). A
  // tool-carrying caller keeps its calls, minus any manifest ones it has no
  // equivalent for — the relay layers drop those.
  const bridged = bridge.length > 0 && !callerTools.length
  const keepable = bridged ? null : keepableFor(callerTools, false)
  for (const model of candidates) {
    const chosen = model === candidates[0]
    used = model
    const format = modelFormat(model)
    // Streams upstream regardless of what the client asked for — see
    // collectChatCompletion — and the collector puts the shape back.
    const payload =
      format === "responses" ? responsesRequest(requestBody, model, true) : withStreamUsage({ ...requestBody, model, stream: true }, model)
    // A Responses body that reaches a responses-family model keeps its input
    // verbatim: the chat round-trip above preserves mostly everything, but
    // content parts do not survive it losslessly — an input_image next to
    // input_text comes back flattened to the text alone, measured. What a
    // /responses caller sent is exactly what upstream wants, so it goes as-is,
    // with `instructions` taking the system slot the translated flow gives it.
    if (responsesRequestShape && format === "responses") {
      const preamble = bridgePreamble()
      const caller = typeof body.instructions === "string" && body.instructions
      const instructions = caller
        ? (caller.includes("<env>") ? caller : `${preamble}\n\n${caller}`)
        : preamble
      payload.input =
        instructions
          ? [{ type: "message", role: "system", content: instructions }, ...sanitizeResponsesItems(responsesInputItemArray(body.input))]
          : sanitizeResponsesItems(responsesInputItemArray(body.input))
    }
    // A callerless bridged request (title generators, plain API pings): the
    // manifest is for the gate, not the answer — the ask is text, so the
    // provider is told not to call anything. A caller that manages its own
    // tool_choice keeps it; the pin filter in the relay layers holds stray
    // manifest calls out of the reply.
    if (!callerTools.length && bridge.length) {
      // The gateway takes only "auto" on /responses, so forwarding anything
      // the caller sent there is a hard error rather than a hint.
      if (format === "responses") delete payload.tool_choice
      else payload.tool_choice = "none"
    }
    let delayMs = 0
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
      delayMs = 0
      let upstreamRes
      const wall = isStream ? headersWall() : null
      try {
        upstreamRes = await upstreamFetch(`${config.upstream}${format === "responses" ? "/responses" : "/chat/completions"}`, {
          method: "POST",
          headers: zenHeaders(req, auth),
          body: JSON.stringify(payload),
          signal: isStream ? wall.signal : AbortSignal.timeout(config.timeoutMs),
        })
        if (wall) wall.release()
      } catch (err) {
        if (wall) wall.release()
        lastErr = { error: { type: "upstream_error", message: err.message } }
        lastStatus = 502
        if (attempt < retries) {
          delayMs = config.retryBackoffMs * (attempt + 1)
          continue
        }
        recordObserved(model, false)
        break
      }

      if (upstreamRes.status === 401 && !triedFallback && fallbackAuth && fallbackAuth !== auth) {
        triedFallback = true
        auth = fallbackAuth
        attempt--
        continue
      }

      if (upstreamRes.ok) {
        if (isStream) {
          if (model !== requested) {
            res.setHeader?.("x-zen-served-by", model)
            res.setHeader?.("x-zen-fallback", "true")
          }
          // A Responses-shaped request gets a Responses-shaped stream, whichever
          // endpoint family upstream actually served it on.
          // Fire-and-forget relays sink their promises: the pumps own every
          // client-visible failure, and undici's late socket rejections have
          // nowhere else to land (measured: 4 x "TypeError: terminated").
          if (responsesRequestShape && format === "responses") {
            relayResponsesPassthrough(req, res, upstreamRes, requested, bridged, pin, keepable).catch(() => {})
          } else if (responsesRequestShape) {
            relayChatAsResponsesStream(req, res, upstreamRes, requested, bridged, pin, keepable).catch(() => {})
          } else if (format === "responses") {
            relayResponsesStream(req, res, upstreamRes, requested, bridged, pin, keepable).catch(() => {})
          } else {
            relayStream(req, res, upstreamRes, requested, bridged, pin, keepable).catch(() => {})
          }
          res.on("finish", () => { recordReq(req, `${requested}→${model}`, Date.now() - start, res.streamFailure ? 502 : 200); recordObserved(model, !res.streamFailure) })
          return
        }
        try {
          const content = format === "responses" ? await collectResponses(upstreamRes) : await collectChatCompletion(upstreamRes)
          if (format === "responses") {
            recordReq(req, `${requested}→${model}`, Date.now() - start, 200)
            recordObserved(model, true)
            if (model !== requested) {
              res.setHeader?.("x-zen-served-by", model)
              res.setHeader?.("x-zen-fallback", "true")
            }
            // The reply answers in the dialect the request arrived in. A
            // Responses request keeps the upstream object whole — a chat
            // round-trip would rebuild it lossily — and only gets the model
            // rewritten and the calls it cannot run dropped.
            if (responsesRequestShape) {
              content.model = requested
              if (pin) filterResponsesOutput(content, (i) => i?.name === pin)
              else if (keepable) filterResponsesOutput(content, (i) => !!keepable(i?.name))
              else if (bridged) filterResponsesOutput(content, null)
              if (model !== requested) content.zen_served_by = model
              return json(res, 200, content)
            }
            return json(res, 200, stripUnpinnedCalls(stripToolCalls(responsesToChat(content, requested, model), bridged), pin, keepable))
          }
          if (model !== requested) {
            // Make the fallback visible to any client, not just JSON readers.
            res.setHeader?.("x-zen-served-by", model)
            res.setHeader?.("x-zen-fallback", "true")
          }
          const shaped = stripUnpinnedCalls(stripToolCalls(content, bridged), pin, keepable)
          if (responsesRequestShape) {
            return json(res, 200, chatToResponses(shaped, requested, model))
          }
          if (shaped && typeof shaped === "object") {
            shaped.model = requested
            if (model !== requested) shaped.zen_served_by = model
          }
          recordReq(req, `${requested}→${model}`, Date.now() - start, 200)
          recordObserved(model, true)
          return json(res, 200, shaped)
        } catch (err) {
          // Same as the /v1/messages collective: an OK status with a reply that
          // died in flight still has the whole chain available, and the plain
          // request gets the real message instead of a flat "bad upstream
          // response".
          lastErr = { error: { type: "upstream_error", message: err?.message ? String(err.message) : "bad upstream response" } }
          lastStatus = 502
          recordObserved(model, false)
          break
        }
      }

      try {
        lastErr = await upstreamRes.json()
      } catch {
        // Same as the /v1/messages path: an unparseable 4xx body is
        // deterministic, so it must not read as retryable (see the longer note
        // in handleMessages).
        lastErr = { error: { type: "invalid_request_error", message: `upstream returned ${upstreamRes.status}` } }
      }
      lastStatus = upstreamRes.status
      // Same rotation as the Anthropic loop: a 429 is a verdict on the egress
      // flow (TLS connection × exit IP), so identity, TLS session and exit IP
      // move together before the retry ladder continues.
      if (upstreamRes.status === 429) {
        const nextProxy = rotateEgress(req)
        if (!rotated429) {
          rotated429 = true
          log(`   429 — rotated identity + TLS session${nextProxy ? " → " + maskProxyUrl(nextProxy) : " (no proxy listed: same exit IP)"}`)
        }
      }
      // Same BYOK escalation as the Anthropic loop: a genuinely spent identity
      // ("Free usage limit reached") retries the same attempt under the
      // configured key — once per request, no extra attempt budget, no shared
      // cooldown ever mistaken for exhausted, key value never logged.
      if (
        upstreamRes.status === 429 &&
        !triedByok &&
        config.defaultZenKey &&
        auth !== `Bearer ${config.defaultZenKey}` &&
        exhaustedFreeVerdict(upstreamRes.status, lastErr)
      ) {
        triedByok = true
        auth = `Bearer ${config.defaultZenKey}`
        log(`   exhausted free allowance on ${model} — same attempt once under BYOK (${maskKey(config.defaultZenKey)})`)
        attempt--
        continue
      }
      const retryAfterMs = Math.min(parseRetryAfter(upstreamRes.headers.get("retry-after")) * 1000, 3000)
      if (transientUpstream(upstreamRes.status, lastErr) && attempt < retries) {
        delayMs = Math.max(config.retryBackoffMs * (attempt + 1), retryAfterMs)
        continue
      }
      // Try the next candidate not only on 429/5xx but also when the upstream
      // reports a model/environment-level failure (e.g. a provider that is
      // temporarily "unavailable", a geo-blocked free model, or a stale model
      // id) so one dead model doesn't brick the whole request.
      recordObserved(model, false)
      if (retryableUpstream(upstreamRes.status, lastErr)) {
        if (retryAfterMs > 0) await new Promise((r) => setTimeout(r, retryAfterMs))
        break
      }
      // A deterministic client-visible error (bad request, auth, …): report it
      // as-is rather than masking it with the rest of the chain.
      recordReq(req, `${requested}→${used}`, Date.now() - start, lastStatus)
      res.writeHead(lastStatus, { "content-type": "application/json" })
      res.end(JSON.stringify(lastErr))
      return
    }
    if (chosen && firstErr == null) {
      firstErr = lastErr
      firstStatus = lastStatus
    }
  }

  // Every candidate failed. Surface the error from the model the client asked
  // for — the tail of the chain is an implementation detail and used to leak
  // unrelated failures (e.g. a retired model's 410 "deprecated").
  const finalStatus = firstErr ? firstStatus : lastStatus
  const finalErr = firstErr ?? lastErr
  // Nothing served this request, so the feed names no server — the last model
  // tried is an implementation detail and used to read as "another model
  // answered" while the error shown actually came from the requested one.
  recordReq(req, requested, Date.now() - start, finalStatus)
  res.writeHead(finalStatus, { "content-type": "application/json" })
  res.end(
    JSON.stringify(finalErr ?? { error: { type: "free_usage_limit_error", message: "all free models are rate-limited" } }),
  )
}

export {
  handleMessages,
  handleChat,
}
