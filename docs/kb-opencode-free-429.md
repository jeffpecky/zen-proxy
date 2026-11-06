# KB: OpenCode free-tier 429 (`FreeUsageLimitError`) — what the gate reads, and how to diagnose it

> Adapted from 9router's live incident log (2026-11-01 → 2026-11-02) and
> re-verified against **zen-proxy** on 2026-11-05. The upstream gate actively
> evolves: re-read "Current gate conditions" and re-probe before assuming any of
> it still holds. Every "<env>" / opener observation below is dated for that
> reason — earlier epochs disagreed with later ones.

---

## TL;DR

The free tier is not primarily a quota check. It fingerprints the request on
four layers, and a request is refused if any of them is wrong:

1. **TLS ClientHello.** Node's OpenSSL fingerprint → `429 FreeUsageLimitError`;
   Bun's BoringSSL → 200, same body, same second, same IP. zen-proxy answers this
   with **wreq-js**, pinned to Bun 1.3.14's captured profile.
2. **System text must carry the harness opener *and* an `<env>` block.**
   The opener alone is not enough (`v_opener_only` → 429, measured 2026-11-05).
   A generic system prompt is fine *if* the preamble is prepended ahead of it
   (`v_generic` → 200).
3. **The `<env>` block's `Working directory` must not look like a tool-install
   path.** 9router measured `...\npm\node_modules\9router\app` → 429
   deterministically, while plausible project dirs → 200. zen-proxy re-stamps
   the block with a plausible workspace (`stampPreamble()`/`sanitizeEnvWorkDir()`).
4. **The quota bucket is keyed on the egress flow (TLS connection × exit IP),
   not on the session header.** Rotating the session id alone changes nothing:
   the retry reuses the same keep-alive socket. This is the single most
   misunderstood part — see "429 retry ladder".

Everything else people blame — the model id, `max_tokens`, tool descriptions,
streaming flags — was measured to be irrelevant in the final epoch.

---

## Background architecture (what is actually in the chain)

```
Client (Claude Code / opencode / curl)
   ↓ Authorization: Bearer public     (tokenless free tier)
zen-proxy  (zen-proxy.mjs, port 8181)
   ├─ session identity mint          genSessionId() / identityFor() / identityPool
   ├─ harness preamble + <env>       agent-preamble.txt + stampPreamble()
   ├─ opencode tool manifest         agent-tools.json + gateBridgeTools()
   ├─ v2 headers                     zenHeaders(): session pair, affinity pair,
   │                                 x-opencode-client, x-opencode-project, b3/traceparent
   ↓ TLS impersonation (wreq-js + OPENCODE_TLS_PROFILE)
https://opencode.ai/inference/openai/v1  →  200 stream | 429 FreeUsageLimitError
```

Key architectural insight, learned the hard way: **the gate reads request body
text and the transport, not the transport alone.** 9router spent hours on TLS
while the actual failure was the `<env>` working directory. Conversely, a
perfect body over Node's TLS is refused before the body is read. Both layers
have to be right.

---

## Definition of done

- Minimal curl through the proxy returns 200:
  ```powershell
  curl.exe -s -o out.json -w "%{http_code}" -X POST http://127.0.0.1:8181/v1/chat/completions `
    -H "Content-Type: application/json" -H "Authorization: Bearer public" `
    --data-binary "@$env:TEMP\repro2.body.json"
  # repro2.body.json = {"model":"deepseek-v4.1-flash-free","stream":false,"max_tokens":40,
  #                     "messages":[{"role":"user","content":"say hi in one word"}]}
  ```
- `node --test test/zen-proxy.test.mjs` green.
- Proxy log shows stable `200`s and **no** `429 — rotated` lines during normal use.
- Three-way control (same body, same minute): wreq+proxy 200, wreq direct 200,
  `ZEN_TLS=0` 429. If all three agree, the bucket is drained — stop bisecting.

---

## The debugging method

### Step 0 — rules of engagement

1. **Never MITM.** mitmproxy re-originates TLS (OpenSSL ClientHello) → the
   transport fingerprint changes → everything 429s, *including traffic that
   would otherwise pass*. Observe from the proxy's own log instead.
2. **Beware your own session.** A Claude Code session running on the same proxy
   fires background requests (title generation, compaction) that pollute the log.
   Identify rows by system-text head + user length before attributing them.
3. **Re-run controls after every finding.** During the original incident the gate
   drifted inside a single hour: "opener must be at index 0" mattered in one
   epoch and not the next. Keep one known-pass and one known-fail body and
   re-send them alongside every new variant. If both jump, the gate moved — stop
   bisecting content.
4. **One variable per request.** Hand-build JSON bodies on disk, send with curl
   `-w "%{http_code}"`, 2–3 s apart, and interleave controls `A B A B`. That
   spacing proves determinism vs. contention.
5. **Probing burns the bucket you are debugging.** Each probe is a real request
   against the same limiter. Spread them out; stop when the control drains.

### Step 1 — reproduce and scope

- Reproduce with the dumbest possible client (plain curl, minimal body). If that
  fails, your agent's config is *not* the story — it is a gate problem.
- Confirm the same model works through the proxy with the shipped preamble. If
  curl fails but the proxy's own path succeeds, the variable is the body you
  hand-built, not the proxy.
- `GET /health` and `GET /v1/models` to confirm the proxy is up and the model id
  exists.

### Step 2 — capture the wire

zen-proxy has no request-details DB; instead point it at a local recording
server and read what it actually sent:

```js
// capture.mjs — appends every upstream request to one JSONL file
import http from "node:http"; import fs from "node:fs"
const out = "C:/Users/sysadmin/AppData/Local/Temp/captured.json"
http.createServer((req,res)=>{let b="";req.on("data",c=>b+=c);req.on("end",()=>{
  fs.appendFileSync(out, JSON.stringify({url:req.url,headers:req.headers,body:JSON.parse(b||"{}")})+"\n")
  res.writeHead(200,{"content-type":"text/event-stream"})
  res.end("data: "+JSON.stringify({model:"m",choices:[{delta:{content:"ok"}}]})+"\n\ndata: [DONE]\n\n")
})}).listen(8194)
```

Then boot the proxy against it:

```powershell
$env:ZEN_URL="http://127.0.0.1:8194/v1"; $env:AUTO_SYNC="0"; $env:AUTO_UA="0"
node zen-proxy.mjs
```

and read back the exact headers, system length, opener position, `<env>` content
and tool names. **That is the wire truth** — nothing hidden.

The **pair capture** is the core move: fire one request that succeeds and one
that fails seconds apart, dump both, and diff them. Equal key sets rule out
parameters; byte-identical tool descriptions rule out tools; wildly different
message lengths point at the system/content gate.

### Step 3 — bisect with hand-built bodies

Vary ONE thing at a time, top-down, stop at the first green:

1. Full preamble (opener + `<env>` + tools) → **baseline PASS**
2. Opener line alone → **FAIL** (429). Measured 2026-11-05. Re-confirmed cause of
   the `combinePreamble` fix: the dedupe key must be `<env>`, not the opener.
3. Generic system prompt with the full preamble prepended → **PASS**
4. Vary the `<env>` `Working directory` → install tree is the decisive variable
   in the epoch 9router measured; a plausible project dir passes.
5. ± placeholder note, ± persona text, ± params → all irrelevant in the final
   epoch.

When hand-building a body that already contains `<env>`, note that zen-proxy's
dedupe (`systemText.includes("<env>")`) means **your** text is sent verbatim
while a body without it gets the injected one. Always verify the wire row for
what actually left the building.

### Step 4 — verify precisely

Re-run Step 1 repro + controls after every change. Live acceptance is the only
arbiter: a green unit test proves wiring, not that the upstream agrees.

---

## Field notes / gotchas

- **Empty 200s are normal-ish** on streaming relays when the body is large; not a
  failure signal.
- **Title/summary lanes** fire per session with a fixed short system prompt. If
  the injected preamble had a poisoned directory these 429 invisibly to the user
  while showing up in the log.
- **Interleaved 200/429 is normal** near bucket exhaustion: one established
  session can keep working while every fresh identity is refused. That reads as
  "quota exhausted" but is bucket-local. Waiting (hours) restores it.
- **Free-tier auth is tokenless** (`Bearer public`), so quota cannot be
  account-bound — the realistic bucket dimensions are egress IP × session.
- **`/zen/v1` is retired**: every request answers 403 FreeTierError. The v2 base
  is `/inference/openai/v1` (with `/responses` and `/messages` siblings).

## Epoch 2 findings (transport & quota layer)

- The free lane sends `Authorization: Bearer public`. Realistic bucket dimensions
  are **exit-IP × session-id**.
- Upstream headers that matter: `x-opencode-session`, `x-opencode-session-id`,
  `x-session-affinity`, `x-session-id` (all the same stable id), plus
  `x-opencode-client` and a v2 UA.
  **Missing `x-opencode-session-id`, or carrying the v1-only
  `x-opencode-request`, → 403.** zen-proxy drops `x-opencode-request` rather
  than forwarding it.
- `x-opencode-request` is v1-only. 9router's executor never sends it on v2.

## TLS-egress findings (why "restart fixes it")

- The wreq TLS session cache is keyed **by proxy URL** and holds a pooled
  keep-alive connection per egress.
- The upstream bucket tracks the **egress flow (TLS connection / exit IP)**, not
  the `x-opencode-session` value inside it. Minting a new session id while
  reusing the socket keeps answering 429.
- Restarting the proxy clears the cache → next request opens a NEW TLS connection
  → behind a rotator, a NEW exit IP → fresh bucket. **That is the entire
  "restart fixes it" effect.**
- With a **single** rotating proxy there is no pool to choose from. Measured
  2026-11-05 against `socks2http -warp`: four fresh connections all exited from
  the same IP. A single proxy URL is a single bucket — what must rotate is the
  TLS session *and* you need more than one exit to actually escape.

## 429 retry ladder (as implemented in zen-proxy)

`rotateEgress(req)` on every 429, before the retry ladder continues:

1. Minted identity: `identityPool.delete(identityBucketKey(req))` — the next
   attempt mints a new session + project pair. A caller-supplied id that was
   already valid is left alone; one we had to translate gets its per-bucket
   epoch bumped, so the memo hands out a fresh id instead of replaying the
   refused one (a translated id memoized without an epoch is the subtle version
   of "rotating the session changes nothing").
2. `resetTlsSession(lastProxyUrl)` — closes that egress's pooled connection.
3. `advanceProxy()` — steps `proxyCursor` so the next `upstreamFetch` uses the
   next entry in `proxyUrls`.

Then the existing ladder runs: same-model retries (`retriesPerModel`, default 2),
then BYOK escalation for a genuinely spent allowance, then the next candidate
model. A 429 that survives all of that surfaces as 429 to the caller.

Why all three: rotating only the id rides the same socket; rotating only the
socket keeps the same identity; doing both without a second proxy still lands on
the same exit IP. The boot log states which of these the current config can
actually do.

## Push-signal design (9router: removed same day, superseded)

9router briefly reported 429s to an external relay, then removed it: detection is
fully delegated to a host prober that speaks the same TLS identity as real
traffic. zen-proxy has no relay and no prober — the sync loop's own health probes
already go through the same transport, so a probe 429 is the same verdict a real
request would get.

## A/B body files kept for re-verification

`$env:TEMP\` — `repro2` (minimal pass), `v_bare` / `v_generic` (pass family),
`v_opener_only`, `v_trunc` (fail family), `wd_e1_poison` / `wd_e2_clean`
(working-directory probes). Bodies are trivially rebuilt from this document.
