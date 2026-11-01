import { Effect } from "effect"
import { Commands } from "../../../commands"
import { Runtime } from "../../../../framework/runtime"
import { connect, here, onError } from "../client"
import { IntelRpc } from "../rpc"
import { println, Style } from "../ui"
import { printNodeList, printSliceSummary } from "./shared"

const handler = Effect.fn("cli.repository.explain")(function* (
  input: Runtime.Input<(typeof Commands.commands.repository.commands)["explain"]>,
) {
  const { client } = yield* connect()
  const slice = yield* Effect.tryPromise({
    try: () => client.rpc(IntelRpc).explain({ symbol: input.symbol, workspace: undefined }, here()),
    catch: (cause) => cause,
  })
  printSliceSummary(slice)
  println(Style.TEXT_INFO_BOLD + "Important symbols:" + Style.TEXT_NORMAL)
  printNodeList(slice.importantSymbols)
})

export default Runtime.handler(Commands.commands.repository.commands.explain, (input) =>
  handler(input).pipe(Effect.catch(onError({ id: "banyancode.intel", method: "explain" }))),
)
