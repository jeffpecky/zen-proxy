// The in-memory request log the dashboard tails.


const MAX_LOG = 500

const logLines = []

function log(message) {
  const line = { at: new Date().toISOString(), msg: message }
  logLines.push(line)
  if (logLines.length > MAX_LOG) logLines.shift()
  console.log(line.msg)
}

export {
  MAX_LOG,
  logLines,
  log,
}
