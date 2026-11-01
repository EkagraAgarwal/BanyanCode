import { Effect } from "effect"
import { Commands } from "../../../commands"
import { Runtime } from "../../../../framework/runtime"
import { connect, here, onError } from "../client"
import { IntelRpc } from "../rpc"
import { dim, println, Style } from "../ui"
import { printNodeList } from "./shared"

const handler = Effect.fn("cli.repository.query")(function* (
  input: Runtime.Input<(typeof Commands.commands.repository.commands)["query"]>,
) {
  const { client } = yield* connect()
  const result = yield* Effect.tryPromise({
    try: () =>
      client.rpc(IntelRpc).query({
        query: input.query,
        limit: input.limit,
        workspace: { worktree: process.cwd(), focusDirs: [] },
      }, here()),
    catch: (cause) => cause,
  })
  const context = result.context
  println(Style.TEXT_HIGHLIGHT + `Repository query: ${input.query}` + Style.TEXT_NORMAL)
  println(
    dim(
      `symbols=${context.symbols.length} tests=${context.tests.length} docs=${context.docs.length} configs=${context.configs.length}`,
    ),
  )
  println(dim(`graph: ${context.graph.nodes.length} nodes, ${context.graph.edges.length} edges`))
  println(dim(`commits: ${context.git.recentCommits.length}`))
  printNodeList(context.symbols, 10)
})

export default Runtime.handler(Commands.commands.repository.commands.query, (input) =>
  handler(input).pipe(Effect.catch(onError({ id: "banyancode.intel", method: "query" }))),
)
