import path from "node:path"
import { Effect, Option } from "effect"
import { Commands } from "../../../commands"
import { Runtime } from "../../../../framework/runtime"
import { connect, here, onError } from "../client"
import { CodegraphRpc } from "../rpc"
import { dim, println, Style } from "../ui"
import { formatState } from "./shared"

const POLL = "500 millis"

const handler = Effect.fn("cli.codegraph.build")(function* (
  input: Runtime.Input<(typeof Commands.commands.codegraph.commands)["build"]>,
) {
  const root = path.resolve(Option.getOrUndefined(input.root) ?? process.cwd())
  const { client } = yield* connect()
  const codegraph = client.rpc(CodegraphRpc)

  const before = yield* Effect.tryPromise({ try: () => codegraph.status({ root }, here()), catch: (cause) => cause })
  println(Style.TEXT_HIGHLIGHT + "Building codegraph" + Style.TEXT_NORMAL)
  println(dim(`  root:   ${root}`))
  println(dim(`  db:     ${before.databasePath}`))
  println(dim(`  force:  ${input.force}`))
  println("")

  if (before.build.status === "running") {
    return yield* Effect.fail(
      new Error("A codegraph build is already running. Use `banyancode codegraph cancel` to stop it first."),
    )
  }

  yield* Effect.tryPromise({
    try: () => codegraph.build({ root, force: input.force }, here()),
    catch: (cause) => cause,
  })

  const deadline = input.timeout > 0 ? Date.now() + input.timeout * 1000 : undefined
  // v1 streamed every state in a TTY and only the terminal one when piped.
  const watch = input.watch || Boolean(process.stdout.isTTY || process.stderr.isTTY)
  let last = ""
  let state = yield* Effect.tryPromise({ try: () => codegraph.status({ root }, here()), catch: (cause) => cause })
  while (state.build.status === "running") {
    const line = formatState(state.build)
    if (watch && line !== last) {
      println(line)
      last = line
    }
    if (deadline !== undefined && Date.now() >= deadline) {
      println(Style.TEXT_WARNING + `Timeout after ${input.timeout}s — build may still be running.` + Style.TEXT_NORMAL)
      break
    }
    yield* Effect.sleep(POLL)
    state = yield* Effect.tryPromise({ try: () => codegraph.status({ root }, here()), catch: (cause) => cause })
  }

  if (!watch || last !== formatState(state.build)) println(formatState(state.build))
  const final = state.build
  if (final.status === "completed") {
    const r = final.result
    println(
      Style.TEXT_SUCCESS +
        `✓ codegraph built (indexed ${r?.indexed ?? 0}, skipped ${r?.skipped ?? 0}, ${((r?.duration_ms ?? 0) / 1000).toFixed(1)}s)` +
        Style.TEXT_NORMAL,
    )
    return
  }
  if (final.status === "cancelled") {
    println(Style.TEXT_WARNING + "✗ build cancelled" + Style.TEXT_NORMAL)
    return
  }
  if (final.status === "failed") {
    println(Style.TEXT_DANGER + `✗ build failed: ${final.error ?? "unknown"}` + Style.TEXT_NORMAL)
    return yield* Effect.fail(new Error(final.error ?? "build failed"))
  }
})

export default Runtime.handler(Commands.commands.codegraph.commands.build, (input) =>
  handler(input).pipe(Effect.catch(onError({ id: "banyancode.codegraph", method: "build" }))),
)
