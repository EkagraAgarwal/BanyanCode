import { Effect } from "effect"
import { Commands } from "../../../commands"
import { Runtime } from "../../../../framework/runtime"
import { connect, here, onError } from "../client"
import { IntelRpc } from "../rpc"
import { println, Style } from "../ui"
import { printNodeList, printSliceSummary } from "./shared"

const handler = Effect.fn("cli.repository.trace")(function* (
  input: Runtime.Input<(typeof Commands.commands.repository.commands)["trace"]>,
) {
  const { client } = yield* connect()
  const slice = yield* Effect.tryPromise({
    try: () => client.rpc(IntelRpc).trace({ symbol: input.symbol, depth: input.depth }, here()),
    catch: (cause) => cause,
  })
  printSliceSummary(slice)
  println(Style.TEXT_INFO_BOLD + "Downstream entrypoints:" + Style.TEXT_NORMAL)
  printNodeList(slice.entrypoints)
})

export default Runtime.handler(Commands.commands.repository.commands.trace, (input) =>
  handler(input).pipe(Effect.catch(onError({ id: "banyancode.intel", method: "trace" }))),
)
