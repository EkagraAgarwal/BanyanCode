import { Effect } from "effect"
import { Commands } from "../../../commands"
import { Runtime } from "../../../../framework/runtime"
import { connect, onError } from "../client"
import { dim, println, Style } from "../ui"
import { readGoal, runGoalCommand } from "./shared"

const handler = Effect.fn("cli.goal.cancel")(function* (
  input: Runtime.Input<(typeof Commands.commands.goal.commands)["cancel"]>,
) {
  const { client } = yield* connect()
  const active = yield* readGoal(client, input.session)
  if (!active) {
    println(dim(`no active goal for session ${input.session}`))
    return
  }
  // v2 has no cancelled status: `/goal clear` removes the goal, which is what
  // a terminal v1 cancel left behind (an inactive goal record).
  yield* runGoalCommand(client, input.session, "clear")
  println(Style.TEXT_SUCCESS_BOLD + "✓ goal cancelled" + Style.TEXT_NORMAL + ` id=${active.id}`)
})

export default Runtime.handler(Commands.commands.goal.commands.cancel, (input) =>
  handler(input).pipe(Effect.catch(onError())),
)
