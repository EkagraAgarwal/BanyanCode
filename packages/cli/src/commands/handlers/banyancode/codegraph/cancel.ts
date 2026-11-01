import { Effect } from "effect"
import { Commands } from "../../../commands"
import { Runtime } from "../../../../framework/runtime"
import { connect, here, onError } from "../client"
import { CodegraphRpc } from "../rpc"
import { dim, println } from "../ui"
import { formatState } from "./shared"

const handler = Effect.fn("cli.codegraph.cancel")(function* () {
  const { client } = yield* connect()
  const codegraph = client.rpc(CodegraphRpc)
  const before = yield* Effect.tryPromise({ try: () => codegraph.status({}, here()), catch: (cause) => cause })
  if (before.build.status !== "running") {
    println(dim("no build is currently running"))
    return
  }
  const after = yield* Effect.tryPromise({ try: () => codegraph.cancel({}, here()), catch: (cause) => cause })
  println(formatState(after))
})

export default Runtime.handler(Commands.commands.codegraph.commands.cancel, () =>
  handler().pipe(Effect.catch(onError({ id: "banyancode.codegraph", method: "cancel" }))),
)
