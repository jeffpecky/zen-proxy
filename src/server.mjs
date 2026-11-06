// The HTTP server, its timers, and graceful shutdown.
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { CONFIG_PATH, config } from "./config.mjs"
import { log } from "./log.mjs"
import { router } from "./router.mjs"
import { scheduleSync, scheduleUA, syncTimer, uaTimer } from "./sync.mjs"
import { resetTlsSession } from "./tls.mjs"
import { envNum } from "./util.mjs"


const server = http.createServer(router)

// Bound inbound request reception. `requestTimeout = 0` meant no limit at all,
// so a client that opened a request and dribbled (or never sent) its body held
// a socket and a handler for the life of the process — slowloris by omission.
// This covers *receiving* the request only; a long streamed reply is bounded by
// the relay walls instead.
server.requestTimeout = 300_000
server.headersTimeout = 60_000

// A proxy is a long-lived daemon: one bad request must not take it down for the
// rest of the session. Node kills the process on an unhandled rejection by
// default, and there are fire-and-forget calls here (the stream relays, the
// periodic sync and UA refresh), so a single thrown error used to end the
// server with nothing in the client's face but a connection error. Log it and
// keep serving.
process.on("unhandledRejection", (err) => {
  log(`unhandled rejection (ignored): ${err?.stack || err?.message || err}`)
})
// An uncaught exception is a different animal: the stack unwound through
// arbitrary state, so the process can no longer be trusted to hold a coherent
// identity pool, config or half-written stream. Swallowing it kept a daemon
// alive in an unknown state; log it, stop accepting, and exit non-zero so the
// supervisor (systemd `Restart=always`, or zen-claude) starts a clean one.
process.on("uncaughtException", (err) => {
  log(`uncaught exception — exiting: ${err?.stack || err?.message || err}`)
  try {
    server.close()
  } catch {}
  setTimeout(() => process.exit(1), 100).unref()
})

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${config.port} already in use. Set PORT or edit zen-proxy.json.`)
  } else {
    console.error(err)
  }
  process.exit(1)
})


// A proxy is a daemon, and every supervisor that runs one (systemd
// `Restart=always`, Docker, launchd, zen-claude) stops it with SIGTERM. Node's
// default handler kills the process on the spot, which cuts every streamed reply
// mid-token and leaves the pooled upstream TLS sessions open — the client sees a
// truncated body with no error, which reads as a proxy bug, not a restart.
//
// So stop accepting, let in-flight replies finish inside a deadline, then drop
// what is left. The deadline matters: a stream can run for minutes, and a
// supervisor escalates to SIGKILL (systemd after 90s by default) which would look
// exactly like the crash this is meant to avoid.
const SHUTDOWN_GRACE_MS = Number(envNum("SHUTDOWN_GRACE_MS", 10_000))

let shuttingDown = false

function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  log(`${signal} — draining, ${SHUTDOWN_GRACE_MS}ms grace`)

  const hardStop = setTimeout(() => {
    log("drain deadline reached — closing remaining connections")
    try {
      server.closeAllConnections()
    } catch {}
    finish(0)
  }, SHUTDOWN_GRACE_MS)
  if (hardStop.unref) hardStop.unref()

  let finished = false
  function finish(code) {
    if (finished) return
    finished = true
    clearTimeout(hardStop)
    if (syncTimer) clearTimeout(syncTimer)
    if (uaTimer) clearTimeout(uaTimer)
    // Close the outbound pools too, or the process lingers on their sockets.
    try {
      resetTlsSession()
    } catch {}
    log("stopped")
    process.exit(code)
  }

  // `close()` alone waits for every open connection, including idle keep-alive
  // sockets that will never send another byte. Under a launcher (zen-claude,
  // a container stop, Ctrl-C) that turned an instant exit into a 10s stall.
  // Drop the idle ones now and let only in-flight requests finish.
  server.close(() => {
    if (!finished) log("drained cleanly")
    finish(0)
  })
  try {
    server.closeIdleConnections()
  } catch {}
}
process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT", () => shutdown("SIGINT"))



let reloading = false

// Config hot-reload. Started by the entry, not at import time, so importing
// this module in a test never opens a filesystem watcher.
function startConfigWatch() {
  try {
    const name = path.basename(CONFIG_PATH)
    fs.watch(path.dirname(CONFIG_PATH), (_event, filename) => {
      if (reloading) return
      if (filename && filename !== name && filename !== name + ".tmp") return
      reloading = true
      setTimeout(() => {
        reloadConfig()
        reloading = false
        scheduleSync()
        scheduleUA()
        log("config reloaded")
      }, 150)
    })
  } catch {}
}

export {
  server,
  SHUTDOWN_GRACE_MS,
  shuttingDown,
  shutdown,
  reloading,
  startConfigWatch,
}
