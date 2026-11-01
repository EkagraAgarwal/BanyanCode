import { Effect, Option } from "effect"
import { Commands } from "../../../commands"
import { Runtime } from "../../../../framework/runtime"
import { connect, here, onError } from "../client"
import { CodegraphRpc } from "../rpc"
import { println } from "../ui"
import { formatState } from "./shared"

const handler = Effect.fn("cli.codegraph.status")(function* (
  input: Runtime.Input<(typeof Commands.commands.codegraph.commands)["status"]>,
) {
  const { client } = yield* connect()
  const status = yield* Effect.tryPromise({
    try: () => client.rpc(CodegraphRpc).status({ root: Option.getOrUndefined(input.root) }, here()),
    catch: (cause) => cause,
  })
  println(formatState(status.build))
})

export default Runtime.handler(Commands.commands.codegraph.commands.status, (input) =>
  handler(input).pipe(Effect.catch(onError({ id: "banyancode.codegraph", method: "status" }))),
)
