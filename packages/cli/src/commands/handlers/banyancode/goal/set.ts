import { Effect, Option } from "effect"
import { Commands } from "../../../commands"
import { Runtime } from "../../../../framework/runtime"
import { connect, onError } from "../client"
import { dim, println, Style } from "../ui"
import { NO_PLAN, NO_PRIORITY, readGoal, runGoalCommand, shortCondition } from "./shared"

const handler = Effect.fn("cli.goal.set")(function* (
  input: Runtime.Input<(typeof Commands.commands.goal.commands)["set"]>,
) {
  const { client } = yield* connect()
  yield* runGoalCommand(client, input.session, input.condition)
  const goal = yield* readGoal(client, input.session)
  if (!goal) return yield* Effect.fail(new Error("the /goal command did not create a goal"))

  const plan = Option.getOrUndefined(input.plan)
  const priority = input.priority
  println(Style.TEXT_SUCCESS_BOLD + "✓ goal set" + Style.TEXT_NORMAL)
  println(dim(`  id:        ${goal.id}`))
  println(dim(`  condition: ${shortCondition(goal.objective)}`))
  println(dim(`  plan:      ${NO_PLAN}`))
  println(dim(`  priority:  ${NO_PRIORITY}`))
  if (plan !== undefined || priority !== undefined) {
    println(
      dim(
        "  note: v2 native goal mode stores no plan path or priority; --plan/--priority are accepted for script compatibility.",
      ),
    )
  }
})

export default Runtime.handler(Commands.commands.goal.commands.set, (input) =>
  handler(input).pipe(Effect.catch(onError())),
)
