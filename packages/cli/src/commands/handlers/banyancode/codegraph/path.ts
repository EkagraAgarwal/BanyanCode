import { Effect } from "effect"
import { Commands } from "../../../commands"
import { Runtime } from "../../../../framework/runtime"
import { connect, here, onError } from "../client"
import { CodegraphRpc } from "../rpc"
import { println } from "../ui"

const handler = Effect.fn("cli.codegraph.path")(function* () {
  const { client } = yield* connect()
  const status = yield* Effect.tryPromise({
    try: () => client.rpc(CodegraphRpc).status({}, here()),
    catch: (cause) => cause,
  })
  println(status.databasePath)
})

export default Runtime.handler(Commands.commands.codegraph.commands.path, () =>
  handler().pipe(Effect.catch(onError({ id: "banyancode.codegraph", method: "status" }))),
)
