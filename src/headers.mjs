// The v2 wire identity headers the gateway expects on every upstream call.
import { randomBytes } from "node:crypto"
import { config } from "./config.mjs"
import { clientIp, ipOmit } from "./net.mjs"
import { SESSION_HEADERS, identityFor } from "./session.mjs"


// The CLI's trace root is stable per process; spans change per request. Both
// formats below follow W3C propagation exactly as captured from v2.1.4.
const traceRoot = randomBytes(16).toString("hex")

function traceHeaders() {
  // b3: <traceId>-<spanId>-1-<parentId 16 random>
  // traceparent: 00-<traceId>-<spanId>-01
  const span = randomBytes(8).toString("hex")
  const parent = randomBytes(8).toString("hex")
  return {
    b3: `${traceRoot}-${span}-1-${parent}`,
    traceparent: `00-${traceRoot}-${span}-01`,
  }
}


// A caller that IS an OpenCode v2 client keeps its own UA — its version is what
// the gate ties the request to. Everyone else is relabelled as the CLI, because
// a non-CLI UA is the clearest refusal signal there is. Same split 9router's
// buildHeaders makes (hasValidOpencodeVersion), including the v2-only rule:
// `opencode/latest/<x.y.z>/cli` and nothing older.
const OPENCODE_UA_RE = /^opencode\/[a-z0-9-]+\/(\d+)\.\d+\.\d+\/[a-z0-9-]+$/i

function upstreamUserAgent(req) {
  const ua = String(req?.headers?.["user-agent"] ?? "").trim()
  const m = ua.match(OPENCODE_UA_RE)
  return m && parseInt(m[1], 10) >= 2 ? ua : config.ua
}


function zenHeaders(req, auth) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: auth,
    "user-agent": upstreamUserAgent(req),
  }
  const identity = identityFor(req)
  // Send both session headers whenever we are allowed to supply one. A client
  // that brings its own session keeps it; we just mirror it into the second
  // header so the pair upstream expects is always complete.
  if (!identity.injected || config.injectSession) {
    for (const h of SESSION_HEADERS) headers[h] = identity.session
    // v2 parity: the affinity pair echoes the same value under two more names.
    headers["x-session-affinity"] = identity.session
    headers["x-session-id"] = identity.session
  }
  headers["x-opencode-client"] = config.clientName
  // identityFor() already resolved the project half: a caller that sent a full
  // session+project pair has its project forwarded verbatim, otherwise it is
  // the other half of the minted pair. Forwarding the header again here used to
  // let a caller who sent *only* `x-opencode-project` split the minted pair —
  // one session, another project, i.e. an identity upstream never issued.
  headers["x-opencode-project"] = identity.project
  if (config.tracing) for (const [k, v] of Object.entries(traceHeaders())) headers[k] = v
  const ip = clientIp(req)
  if (!ipOmit(ip)) headers["x-real-ip"] = ip
  // `x-opencode-request` is v1-only and the v2 gateway rejects any request that
  // carries it (403 FreeTierError, measured by 9router's executor). It used to
  // be forwarded from the caller verbatim, which let a client that speaks the
  // old protocol get a valid request refused. Dropped, not renamed.
  return headers
}

export {
  traceRoot,
  traceHeaders,
  OPENCODE_UA_RE,
  upstreamUserAgent,
  zenHeaders,
}
