# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
for [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

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
