import { Effect } from "effect"
import { Commands } from "../../../commands"
import { Runtime } from "../../../../framework/runtime"
import { connect, onError } from "../client"
import { dim, println, Style } from "../ui"
import { NO_PLAN, NO_PRIORITY, readGoal } from "./shared"

const handler = Effect.fn("cli.goal.status")(function* (
  input: Runtime.Input<(typeof Commands.commands.goal.commands)["status"]>,
) {
  const { client } = yield* connect()
  const goal = yield* readGoal(client, input.session)
  if (!goal) {
    println(dim(`no active goal for session ${input.session}`))
    return
  }
  println(Style.TEXT_HIGHLIGHT + `Active goal: ${goal.id}` + Style.TEXT_NORMAL)
  println(dim(`  condition:     ${goal.objective}`))
  println(dim(`  plan:          ${NO_PLAN}`))
  println(dim(`  priority:      ${NO_PRIORITY}`))
  println(dim(`  iteration:     ${goal.rounds}`))
  println(dim(`  last verdict:  (none)`))
  println(dim(`  last reason:   ${goal.reason ?? "(none)"}`))
  println(dim(`  created:       ${new Date(goal.updatedAt).toISOString()}`))
  println(dim(`  status:        ${goal.status} (rounds ${goal.rounds}/${goal.maxRounds})`))
})

export default Runtime.handler(Commands.commands.goal.commands.status, (input) =>
  handler(input).pipe(Effect.catch(onError())),
)
