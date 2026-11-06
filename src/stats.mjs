// Request counters, health observations, and the log line per request.
import { log } from "./log.mjs"
import { clientIp } from "./net.mjs"
import { identityFor } from "./session.mjs"

const requestStats = { total: 0, errors: 0, recent: [], perMinute: new Map(), window60: [] }

const syncState = { at: 0, ok: false, running: false, working: [], rateLimited: [], flaky: [], gated: [], dead: [], error: "", ms: 0 }

// Health learned from real client traffic, kept alongside the agent-shaped
// probe in probeModel(). Real traffic is the ground truth: it can disagree
// with a probe when a gate lifts or a quota refills mid-cycle.
const observed = new Map()

function recordObserved(model, ok) {
  if (!model) return
  const cur = observed.get(model) ?? { ok: 0, fail: 0, last: 0 }
  if (ok) cur.ok++
  else cur.fail++
  cur.last = Date.now()
  observed.set(model, cur)
}

const modelHealth = new Map()


function recordReq(req, model, ms, status, at = Date.now()) {
  const entry = { at, ip: clientIp(req), model, status, ms }
  // Identity observability: the log feed is where a human confirms identities
  // rotate across windows and stay stable when a caller brings its own. The
  // id's head encodes its mint time (rotation), its random tail the identity
  // itself — so both ends travel, and never the whole id in a log file.
  const id = identityFor(req)
  log(`req ${status} ${model} ${ms}ms ${id.session.slice(0, 11)}…${id.session.slice(-4)}${id.injected ? "(injected)" : "(client)"} prj:${id.project.slice(0, 8)}`)
  const key = `${entry.at}|${entry.model}|${entry.status}`
  if (!requestStats.recent.length || requestStats.recent[requestStats.recent.length - 1][0] !== key) {
    requestStats.recent.push([key, 1, ms])
    if (requestStats.recent.length > 200) requestStats.recent.shift()
  } else {
    requestStats.recent[requestStats.recent.length - 1][1]++
    requestStats.recent[requestStats.recent.length - 1][2] = ms
  }
  requestStats.total++
  if (status >= 400) requestStats.errors++
  const minute = Math.floor(entry.at / 60000)
  requestStats.perMinute.set(minute, (requestStats.perMinute.get(minute) ?? 0) + 1)
  const cutoff = entry.at - 60_000
  while (requestStats.window60.length && requestStats.window60[0] < cutoff) requestStats.window60.shift()
  requestStats.window60.push(entry.at)
  const minCutoff = minute - 60
  for (const m of [...requestStats.perMinute.keys()]) {
    if (m < minCutoff) requestStats.perMinute.delete(m)
  }
}

export {
  requestStats,
  syncState,
  observed,
  recordObserved,
  modelHealth,
  recordReq,
}
