import { Effect } from "effect"
import { Commands } from "../../../commands"
import { Runtime } from "../../../../framework/runtime"
import { connect, onError } from "../client"
import { dim, println, Style } from "../ui"
import { readGoal } from "./shared"

const handler = Effect.fn("cli.goal.list")(function* (
  input: Runtime.Input<(typeof Commands.commands.goal.commands)["list"]>,
) {
  const { client } = yield* connect()
  const goal = yield* readGoal(client, input.session)
  const goals = goal ? [goal] : []
  println(Style.TEXT_HIGHLIGHT + `Goals for session ${input.session}: ${goals.length}` + Style.TEXT_NORMAL)
  for (const entry of goals) {
    println(
      `  ${Style.TEXT_HIGHLIGHT}${entry.id}${Style.TEXT_NORMAL}  ${dim(
        `status=${entry.status} iter=${entry.rounds} verdict=${entry.status === "complete" ? "done" : "(none)"}`,
      )}`,
    )
    println(`    ${dim(entry.objective.length > 80 ? entry.objective.slice(0, 80) + "…" : entry.objective)}`)
  }
})

export default Runtime.handler(Commands.commands.goal.commands.list, (input) =>
  handler(input).pipe(Effect.catch(onError())),
)
