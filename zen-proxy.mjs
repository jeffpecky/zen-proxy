#!/usr/bin/env node
// zen-proxy — entry point.
//
// Everything of substance lives in src/. This file only wires the process up:
// the boot log, the config/UA/sync timers, the listener, and the two paths that
// exist for `zen-proxy --help` and `--version`.
//
//   src/util.mjs       helpers shared by everything
//   src/config.mjs     defaults, the config file, the live `config` binding
//   src/log.mjs        the log buffer the dashboard tails
//   src/catalogs.mjs   models.json, agent-tools.json, agent-preamble.txt
//   src/preamble.mjs   harness preamble assembly
//   src/tls.mjs        wreq-js transport + egress pool
//   src/net.mjs        body reader, JSON replies, credentials
//   src/session.mjs    session minting / translation / identity pool
//   src/headers.mjs    the v2 wire headers
//   src/bridge.mjs     opencode tool manifest <-> caller tools
//   src/model.mjs      model resolution + endpoint family
//   src/retry.mjs      upstream error classification
//   src/stats.mjs      counters and per-request logging
//   src/wire/          Anthropic and Responses translation
//   src/stream.mjs     the streaming relays
//   src/sync.mjs       catalog sync, probes, auto-UA
//   src/routes/        request handlers
//   src/router.mjs     URL -> handler
//   src/server.mjs     the HTTP server and shutdown
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ensureDefaultKey } from "./src/apikeys.mjs"
import { CONFIG_PATH, config, writeConfigFile } from "./src/config.mjs"
import { log } from "./src/log.mjs"
import { server, startConfigWatch } from "./src/server.mjs"
import { scheduleSync, scheduleUA, syncModels, refreshUA } from "./src/sync.mjs"
import { loadWreq, maskProxyUrl, proxyList, TLS_ENABLED } from "./src/tls.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// `--version` / `-v` and `--help` / `-h`. A daemon that has to be asked for its
// version by grepping package.json is annoying in bug reports; this is two
// lines and it lets the installers and issue template both name a build.
const arg = process.argv[2]
if (arg === "--version" || arg === "-v") {
  let version = "unknown"
  try {
    version = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version
  } catch {}
  console.log(version)
  process.exit(0)
}
if (arg === "--help" || arg === "-h") {
  console.log(`zen-proxy — use OpenCode Zen's free models from any coding agent

Usage:
  zen-proxy                 start the proxy (dashboard at http://<host>:<port>/)
  zen-proxy --version       print the version
  zen-proxy --help          this text

Configuration comes from the environment and zen-proxy.json; a full list is in
README.md. The dashboard at / edits it live.`)
  process.exit(0)
}

server.listen(config.port, config.host, () => {
  log(`zen-proxy listening on http://${config.host}:${config.port}`)
  log(`upstream ${config.upstream}  UA ${config.ua}  default ${config.defaultModel || "(auto)"}`)
  log(`config file: ${CONFIG_PATH}  UI: /`)

  // The gate fingerprints the TLS stack, and the proxy no longer depends on
  // the runtime for it: wreq-js dials with Bun's ClientHello either way. Say
  // which transport this process actually got, once, at boot.
  if (!TLS_ENABLED) {
    log("TLS transport disabled (ZEN_TLS=0) — free-tier requests will be")
    log("refused with 429 unless a Zen key is configured.")
  } else {
    loadWreq()
      .then(() => log("TLS transport: wreq-js (Bun ClientHello profile)"))
      .catch((err) => log(`⚠  ${err.message}`))
    const list = proxyList()
    if (list.length) {
      log(`egress: ${list.length} proxy${list.length === 1 ? "" : " list"}${config.proxyStrict ? " (strict)" : ""} — ${list.map(maskProxyUrl).join(", ")}`)
      // A 429 rotates the session and re-dials, but a single exit IP is a
      // single bucket: re-dialling it lands on the same one. Say it once
      // rather than letting "rotation" imply more than it delivers.
      if (list.length === 1) log("   one proxy = one exit IP, so a 429 retry hits the same bucket; add more entries to rotate")
    }
  }

  if (!fs.existsSync(CONFIG_PATH)) {
    try {
      // fallbackModels is deliberately left out: it comes from models.json, so
      // writing it here would pin this install to today's catalog and it would
      // never see a refresh.
      const { fallbackModels, ...seed } = config
      // Through writeConfigFile, not a bare write: the seed carries the same
      // secrets (ADMIN_PASSWORD / ZEN_KEY from the environment), and a plain
      // writeFileSync here created it world-readable with umask 022.
      writeConfigFile(seed)
      log(`created default config: ${CONFIG_PATH}`)
    } catch {}
  }

  // A public bind with no credential would be an open relay (and the anonymous
  // `public` tier is the only thing a stranger would need to drain it). Mint one
  // at boot and print it once — the config file still holds it, but the log is
  // where the operator looks first.
  // A public bind with no credential would be an open relay (and the anonymous
  // `public` tier is the only thing a stranger would need to drain it). Mint
  // both secrets at boot and print them once — each is stored once, the
  // password in the 0600 config file, the key only as a hash.
  const minted = ensureDefaultKey()
  if (minted) {
    log("no credentials configured and this proxy is reachable off this machine")
    if (minted.adminPassword) log(`   dashboard password: ${minted.adminPassword}   (Settings → change it; this is the login only)`)
    if (minted.key) log(`   client api key:     ${minted.key}   (ANTHROPIC_AUTH_TOKEN / OPENAI_API_KEY for model calls)`)
    log("   they are separate: the password never calls models, the key never logs in")
  }

  startConfigWatch()

  if (config.autoUA) {
    log("auto-UA enabled — checking for new opencode releases…")
    refreshUA()
  }
  if (config.autoSync) {
    log(`auto-sync enabled (every ${Math.round(config.autoSyncIntervalMs / 60000)} min) — probing free models…`)
    syncModels()
  }
  scheduleSync()
  scheduleUA()
})
