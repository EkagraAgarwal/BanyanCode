let shuttingDown = false
let signalHandlersRegistered = false

export function isShuttingDown() {
  return shuttingDown
}

export function registerShutdownSignalHandlers() {
  if (signalHandlersRegistered) return
  signalHandlersRegistered = true
  process.once("SIGTERM", markShuttingDown)
  process.once("SIGINT", markShuttingDown)
}

function markShuttingDown() {
  if (shuttingDown) return
  shuttingDown = true
  console.log("SIGTERM/SIGINT received. Stop accepting new requests (/ready returning 503)...")

  setTimeout(() => {
    console.log("Draining active queues and exiting...")
    process.exit(0)
  }, 5000)
}
