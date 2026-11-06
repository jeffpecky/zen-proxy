# zen-proxy — working notes

Single-file proxy (`zen-proxy.mjs`, ~4700 lines) that makes a coding agent's
traffic indistinguishable from the OpenCode CLI so the free tier serves it.
Tests: `node --test test/zen-proxy.test.mjs` (set `ZEN_TLS=0` in tests — they stub
`globalThis.fetch`, and the wreq transport would bypass the stub).

**The case study for everything below is
[`docs/kb-opencode-free-429.md`](docs/kb-opencode-free-429.md)** — the gate's
behaviour per epoch, the bisect method, field notes and A/B bodies. Read it
first; this file is the summary, that one is the evidence.

## The 429 gate — what actually decides the verdict

Measured on this machine, one process, one egress IP, same body:

| Layer | What the gate reads | Where it is handled |
|---|---|---|
| TLS ClientHello | JA3/JA4. Node's OpenSSL → 429, Bun's BoringSSL → 200 | `OPENCODE_TLS_PROFILE` + `upstreamFetch()` (wreq-js) |
| Session identity | `x-opencode-session` + `-session-id` + affinity pair, real `ses_` format | `genSessionId()`, `identityFor()`, `zenHeaders()` |
| System text | must be opencode's harness preamble | `agent-preamble.txt`, `stampPreamble()` |
| Tool manifest | opencode's own v2 manifest must ride | `agent-tools.json`, `gateBridgeTools()` |
| Quota bucket | **egress flow** (TLS connection × exit IP) | `rotateEgress()` on 429 |

**Order matters when debugging**: the gate reads the body text and the transport
before it reads anything you would call "API design". A perfect request body over
Node's TLS is refused; a mediocre one over Bun's is not.

### Verified 2026-11-05 (three-way control, same minute, same body)

| Transport | Result |
|---|---|
| wreq-js + proxy | **200** |
| wreq-js direct | **200** |
| `ZEN_TLS=0` (Node native TLS) | **429 FreeUsageLimitError** |

Handshake parity with real Bun 1.3.14, measured via tls.peet.ws:
JA4 `t13d1714h1_5b57614c22b0_43ade6aba3df`, JA3 `d871d02cecbde59abbf8f4806134addf`.

### 429 rotation — the part that is easy to get wrong

Rotating the session id alone does nothing: the id rides *inside* a keep-alive
TLS connection, and the bucket is keyed on that connection's exit. `rotateEgress()`
therefore drops all three:

1. minted identity pair (`identityPool.delete`)
2. that egress's wreq session (`resetTlsSession(lastProxyUrl)`)
3. proxy cursor stepped to the next entry (`advanceProxy`)

With **one** proxy (or none) only 1 and 2 happen, and the retry lands on the same
bucket. The boot log says so explicitly. Measured against `sock2http -warp`:
four fresh connections all exited from the same IP — a single proxy is a single
bucket, whatever the socket count.

## Parity with 9router's opencode implementation

Reference implementation: `9router/open-sse/executors/opencode.js`,
`open-sse/services/opencodeTlsClient.js`, `open-sse/utils/opencodeFingerprint.js`,
and the case study `9router/docs/kb-opencode-free-429.md` (read that first — it
records which gate conditions were live at which time, and warns the gate drifts).

Ported here:

- Bun-true TLS profile, verbatim cipher list (`opencodeTlsClient.js:23-59`)
- Per-proxy session cache, LRU 32 (`opencodeTlsClient.js:70-135`)
- v2 headers incl. `x-opencode-request` **rejected** — dropped, never forwarded
  (`opencode.js:535`; the v2 gateway 403s on it)
- v2-only UA passthrough: `opencode/latest/<x.y.z>/cli`, version ≥ 2
  (`opencode.js:30-33`). Older/non-CLI UAs are relabelled.
- `reasoning` / `reasoning_effort` normalisation: `auto` dropped, `ultra`/`max`
  clamped to a level the model serves, Anthropic `thinking.budget_tokens` mapped
  onto tiers (`opencode.js:361-392`)
- Responses items sanitised: prior `reasoning` items dropped, `encrypted_content`
  stripped, `call_id` clamped to 64, arguments coerced, nameless calls dropped
  (`opencode.js:328-360`)
- `store:false` on the Responses lane (pooled `Bearer public` cannot read another
  account's stored response)
- Install-tree working directory sanitisation in the `<env>` block
  (`opencodeFingerprint.js:354-361`) — the gate 429s tooling paths
- Session id validation + translation: an id that matches
  `^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$` is forwarded untouched, anything else is
  translated deterministically per conversation (`opencode.js:27,91-107`).
  Translated ids carry a **per-bucket epoch** that a 429 bumps, so a retry never
  replays the session that was just refused; a caller's valid id is never
  rewritten (`opencode.js:171-185`). The time field comes from `Date.now()`, not
  a digest — 9router measured digest-derived prefixes at 1/10 and clock-derived
  at 10/10 (`opencode.js:73-78`)
- Fingerprint tools (`read`, `shell`): a caller tool already carrying OpenCode's
  exact definition passes through; same name with compatible arguments adopts
  OpenCode's definition **in place**; otherwise it moves to `<key>_client` and
  OpenCode's copy is appended; any still-missing one is appended
  (`opencodeFingerprint.js:164-236`)
- Foreign gate-word tool names aliased: `terminal` substring and
  `ReportFindings` → `review_findings`, with pin + history retargeting
  (`opencodeFingerprint.js:39-44,236-260`)

Full case study — the gate's behaviour per epoch, the diagnostic method, the
field notes, and the A/B bodies to re-verify with:
**[`docs/kb-opencode-free-429.md`](docs/kb-opencode-free-429.md)**. Read it before
changing anything on the request path.

Deliberately different (do not "fix" these without a reason):

- One file instead of an executor registry — zen-proxy has exactly one provider
- Session ids minted per caller bucket (IP + UA family), not per connection —
  9router keys on `connectionId`, which a local proxy does not have
- No multi-account rotation (no `apiKeys` table here)

## Config added for this work

| Env | Config key | Meaning |
|---|---|---|
| `PROXY_URLS` | `proxyUrls` | JSON array of egress proxies, round-robin |
| `PROXY_STRICT=1` | `proxyStrict` | refuse instead of falling back to the direct IP |
| `ZEN_TLS=0` | — | disable the wreq transport (BYOK / tests) |
| `ZEN_PROXY_WREQ` | — | explicit path to the wreq-js module |
