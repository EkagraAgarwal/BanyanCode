import { Effect } from "effect"
import { Commands } from "../../../commands"
import { Runtime } from "../../../../framework/runtime"
import { connect, here, onError } from "../client"
import { IntelRpc } from "../rpc"
import { println, Style } from "../ui"
import { printNodeList } from "./shared"

const handler = Effect.fn("cli.repository.tests")(function* (
  input: Runtime.Input<(typeof Commands.commands.repository.commands)["tests"]>,
) {
  const { client } = yield* connect()
  const tests = yield* Effect.tryPromise({
    try: () => client.rpc(IntelRpc).tests({ symbol: input.symbol }, here()),
    catch: (cause) => cause,
  })
  println(Style.TEXT_HIGHLIGHT + `Tests referencing ${input.symbol}` + Style.TEXT_NORMAL)
  printNodeList(tests)
})

export default Runtime.handler(Commands.commands.repository.commands.tests, (input) =>
  handler(input).pipe(Effect.catch(onError({ id: "banyancode.intel", method: "tests" }))),
)
