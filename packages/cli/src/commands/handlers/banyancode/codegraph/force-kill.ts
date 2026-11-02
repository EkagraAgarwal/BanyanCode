import { Effect } from "effect"
import { Commands } from "../../../commands"
import { Runtime } from "../../../../framework/runtime"
import { connect, here, onError } from "../client"
import { CodegraphRpc } from "../rpc"
import { println, Style } from "../ui"

const handler = Effect.fn("cli.codegraph.forceKill")(function* () {
  const { client } = yield* connect()
  const result = yield* Effect.tryPromise({
    try: () => client.rpc(CodegraphRpc).forceKill({}, here()),
    catch: (cause) => cause,
  })
  // The plugin explains why it did not taskkill on non-Windows platforms; that
  // detail is noise for a user who just wants the outcome.
  const message = result.message.includes("not on Windows")
    ? "force-kill: the build was interrupted"
    : result.message
  if (result.ok) println(Style.TEXT_SUCCESS + "✓ " + message + Style.TEXT_NORMAL)
  else println(Style.TEXT_DANGER + "✗ " + message + Style.TEXT_NORMAL)
})

export default Runtime.handler(Commands.commands.codegraph.commands["force-kill"], () =>
  handler().pipe(Effect.catch(onError({ id: "banyancode.codegraph", method: "forceKill" }))),
)
