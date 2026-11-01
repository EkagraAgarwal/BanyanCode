import { Effect } from "effect"
import { Commands } from "../../../commands"
import { Runtime } from "../../../../framework/runtime"
import { connect, here, onError } from "../client"
import { CodegraphRpc } from "../rpc"
import { println, Style } from "../ui"

const handler = Effect.fn("cli.codegraph.remove")(function* (
  input: Runtime.Input<(typeof Commands.commands.codegraph.commands)["remove"]>,
) {
  const { client } = yield* connect()
  const result = yield* Effect.tryPromise({
    try: () => client.rpc(CodegraphRpc).remove({ dropFile: input.dropFile }, here()),
    catch: (cause) => cause,
  })
  if (result.status === "empty") {
    println("Codegraph index was already empty.")
    return
  }
  println(
    Style.TEXT_SUCCESS +
      `✓ Codegraph index removed. Freed ${result.freedBytes} bytes (${result.sizeBefore} -> ${result.sizeAfter}).` +
      Style.TEXT_NORMAL,
  )
})

export default Runtime.handler(Commands.commands.codegraph.commands.remove, (input) =>
  handler(input).pipe(Effect.catch(onError({ id: "banyancode.codegraph", method: "remove" }))),
)
