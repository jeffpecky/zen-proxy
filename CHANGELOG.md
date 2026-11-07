# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
for [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **wreq-js is the only upstream transport.** The native-fetch fallback is gone:
  if the addon cannot load, upstream calls fail with its error instead of
  silently dropping to Node's TLS — which the free-tier gate answers with
  `429 FreeUsageLimitError`. Previously *any* error (a timeout included)
  triggered that downgrade and logged it as "TLS transport unavailable", so one
  slow request could leave the whole proxy on the wrong TLS stack with the real
  error hidden.
- **`proxyStrict` / `PROXY_STRICT` removed** — it only ever governed that
  fallback, so it has nothing left to control.
- **The dashboard ships the password `123456`**, matching 9router's
  `INITIAL_PASSWORD`. On any non-loopback bind it is replaced at boot with a
  random one and the log says so, because a published dashboard must not be
  openable with the value printed in the README. `ADMIN_PASSWORD` still wins.
- **A client API key is now always required on model calls.** Every install
  mints an `sk-…` key at first boot (loopback included) and prints it once;
  Settings shows it masked under User-agent with an eye toggle and **Copy key**.
  Without the key every `/v1/*` call is `401`. There is no anonymous path.
- **`REQUIRE_API_KEY` / `requireApiKey` removed** — the key is unconditional, so
  the switch had nothing left to control.
- **The dashboard password (when set) and the Zen key are masked** behind an eye
  toggle too; the key used to be plain text on screen.
- `zen-claude` now puts the minted client key in `ANTHROPIC_AUTH_TOKEN` (read
  from the config file) instead of the literal `public`.
- The caller's own bearer token is never forwarded upstream any more; it only
  ever carries the proxy's credential, so the 401-placeholder retry path is
  gone.
- **The source is split into modules.** `zen-proxy.mjs` was ~5,000 lines; it is
  now a 114-line entry point plus focused modules under `src/`. No behaviour
  change — the public surface the tests drive is re-exported from
  `src/index.mjs`. If you scripted against the old single file's internals, that
  was never a supported interface; the HTTP API is unchanged.
- Node 18 is no longer supported. The minimum is **Node 20** (18 reached
  end-of-life in April 2025, and the code uses `closeAllConnections`,
  `AbortSignal.timeout`, and `structuredClone`).
- `package-lock.json` is now committed, and the installers use `npm ci`, so
  every install resolves the same `wreq-js` native build. Previously
  `^3.2.0` floated.

### Added

- **Graceful shutdown.** `SIGTERM`/`SIGINT` now drain in-flight streams inside a
  deadline (`SHUTDOWN_GRACE_MS`, default 10s) before closing connections and the
  outbound TLS pools. Previously Node's default handler killed the process
  immediately, truncating streamed replies and leaving pooled connections open —
  which looks like a crash to the client and to a supervisor.
- `--version` and `--help`.
- `SECURITY.md`, this changelog, and a `files` allowlist so `npm pack` ships the
  proxy (~200 KB) instead of the demo video.
- `npm run check` for a fast syntax + import check without running the suite.

### Fixed

- **`install.sh` installed the TLS transport before creating the install
  directory.** `cd` into a nonexistent path failed, so `npm install` never ran
  and fresh installs started with no `wreq-js` — the exact component the
  anonymous free tier depends on. The install step now runs after the copy.
- Node version checks in both installers accepted 18; they now require 20.

## [1.0.0] — previous

The initial public shape: a single-file proxy with OpenAI and Anthropic
compatible routes, the OpenCode harness preamble and tool manifest, session
identity minting, and the Responses API translation.
