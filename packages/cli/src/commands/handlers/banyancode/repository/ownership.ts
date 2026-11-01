import { Effect } from "effect"
import { Commands } from "../../../commands"
import { Runtime } from "../../../../framework/runtime"
import { connect, here, onError } from "../client"
import { IntelRpc } from "../rpc"
import { dim, println, Style } from "../ui"

const handler = Effect.fn("cli.repository.ownership")(function* (
  input: Runtime.Input<(typeof Commands.commands.repository.commands)["ownership"]>,
) {
  const { client } = yield* connect()
  const owner = yield* Effect.tryPromise({
    try: () => client.rpc(IntelRpc).ownership({ path: input.path, workspace: undefined }, here()),
    catch: (cause) => cause,
  })
  if (owner.owner)
    println(`${Style.TEXT_HIGHLIGHT}${owner.owner}${Style.TEXT_NORMAL} ${dim(`(${owner.count} commits)`)}`)
  else println(dim(`no owner (${owner.count} commits)`))
})

export default Runtime.handler(Commands.commands.repository.commands.ownership, (input) =>
  handler(input).pipe(Effect.catch(onError({ id: "banyancode.intel", method: "ownership" }))),
)
