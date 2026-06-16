// Smoke test: runs `bun dev` for 10s, captures stdout/stderr to log file.
import { spawn } from "child_process"
import fs from "fs"
import path from "path"
import os from "os"

const logFile = path.join(os.tmpdir(), "bun-dev-smoke.log")
fs.writeFileSync(logFile, "START " + new Date().toISOString() + "\n")

const child = spawn("bun", ["dev"], {
  cwd: "D:\\OpenCode\\packages\\opencode",
  env: { ...process.env, BANYANCODE_ENABLE: "1" },
  stdio: ["ignore", "pipe", "pipe"],
})

let stdout = ""
let stderr = ""
child.stdout.on("data", (d) => {
  const s = d.toString()
  stdout += s
  fs.appendFileSync(logFile, "OUT: " + s.slice(0, 200) + "\n")
})
child.stderr.on("data", (d) => {
  const s = d.toString()
  stderr += s
  fs.appendFileSync(logFile, "ERR: " + s.slice(0, 200) + "\n")
})

child.on("exit", (code, signal) => {
  fs.appendFileSync(logFile, "EXIT code=" + code + " signal=" + signal + "\n")
  process.exit(0)
})

// Send SIGTERM after 10s
setTimeout(() => {
  fs.appendFileSync(logFile, "TIMEOUT - sending SIGTERM\n")
  child.kill("SIGTERM")
}, 10000)

// Force exit if child doesn't respond in 3s
setTimeout(() => {
  fs.appendFileSync(logFile, "HARD EXIT\n")
  process.exit(0)
}, 14000)
