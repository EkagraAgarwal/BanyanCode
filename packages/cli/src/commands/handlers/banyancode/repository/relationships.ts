import { Effect } from "effect"
import { Commands } from "../../../commands"
import { Runtime } from "../../../../framework/runtime"
import { connect, here, onError } from "../client"
import { IntelRpc } from "../rpc"
import { println, Style } from "../ui"
import { printNodeList } from "./shared"

const handler = Effect.fn("cli.repository.relationships")(function* (
  input: Runtime.Input<(typeof Commands.commands.repository.commands)["relationships"]>,
) {
  const { client } = yield* connect()
  const nodes = yield* Effect.tryPromise({
    try: () => client.rpc(IntelRpc).relationships({ nodeID: input.nodeID, depth: input.depth }, here()),
    catch: (cause) => cause,
  })
  println(Style.TEXT_HIGHLIGHT + `Related nodes` + Style.TEXT_NORMAL)
  printNodeList(nodes)
})

export default Runtime.handler(Commands.commands.repository.commands.relationships, (input) =>
  handler(input).pipe(Effect.catch(onError({ id: "banyancode.intel", method: "relationships" }))),
)
