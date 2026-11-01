import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { Buffer } from "node:buffer"

/**
 * Process helpers for the LSP runtime (v1 `packages/opencode/src/util/process.ts`
 * + `lsp/launch.ts`). Local copy: the plugin must not depend on host internals.
 */

export type Child = ChildProcessWithoutNullStreams & { exited: Promise<number> }

export interface Options {
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv | null
}

export interface Result {
  readonly code: number
  readonly stdout: Buffer
  readonly stderr: Buffer
}

export interface TextResult extends Result {
  readonly text: string
}

const SERVER_SECRETS = ["OPENCODE_SERVER_PASSWORD", "BANYANCODE_SERVER_PASSWORD"]

const childEnv = (env?: NodeJS.ProcessEnv | null): NodeJS.ProcessEnv => {
  const next: NodeJS.ProcessEnv = env === null ? {} : { ...process.env, ...env }
  for (const key of Object.keys(next)) {
    if (SERVER_SECRETS.includes(key.toUpperCase())) delete next[key]
  }
  return next
}

const quote = (value: string) => (/[\s"&|<>^]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value)

const isBatch = (file: string) => /\.(?:cmd|bat)$/i.test(file)

const launch = (cmd: string[]) => {
  const file = cmd[0]
  if (!file) throw new Error("Command is required")
  if (process.platform === "win32" && !isBatch(file) && !/\.[a-z0-9]+$/i.test(file)) {
    // `npm`/`gem`/`mix` resolve to .cmd shims on Windows; launch them through
    // the shell like cross-spawn did in v1.
    return { file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", cmd.map(quote).join(" ")] }
  }
  if (process.platform === "win32" && isBatch(file)) {
    return { file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", cmd.map(quote).join(" ")] }
  }
  return { file, args: cmd.slice(1) }
}

export const spawn = (cmd: string[], opts: Options = {}): Child => {
  const target = launch(cmd)
  const proc = nodeSpawn(target.file, target.args, {
    cwd: opts.cwd,
    env: childEnv(opts.env),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams
  if (!proc.stdin || !proc.stdout || !proc.stderr) throw new Error("Process output not available")
  const child = proc as Child
  child.exited = new Promise<number>((resolve, reject) => {
    proc.once("exit", (code) => resolve(code ?? 1))
    proc.once("error", (error) => reject(error))
  })
  void child.exited.catch(() => undefined)
  return child
}

const collect = (stream: NodeJS.ReadableStream): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
    stream.on("end", () => resolve(Buffer.concat(chunks)))
    stream.on("error", reject)
  })

export const run = async (cmd: string[], opts: Options = {}): Promise<Result> => {
  const proc = spawn(cmd, opts)
  const [code, stdout, stderr] = await Promise.all([proc.exited, collect(proc.stdout), collect(proc.stderr)])
  return { code, stdout, stderr }
}

export const text = async (cmd: string[], opts: Options = {}): Promise<TextResult> => {
  const result = await run(cmd, opts)
  return { ...result, text: result.stdout.toString() }
}

/**
 * Stops a process the runtime spawned. On Windows only the exact PID tree is
 * targeted (`/pid`), never an image name.
 */
export const stop = async (proc: ChildProcessWithoutNullStreams): Promise<void> => {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  if (process.platform !== "win32" || !proc.pid) {
    proc.kill()
    return
  }
  const result = await run(["taskkill", "/pid", String(proc.pid), "/T", "/F"]).catch(() => ({ code: 1 }))
  if (result.code === 0) return
  proc.kill()
}
