import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { connect, here, onError } from "./client"
import { UsageRpc } from "./rpc"
import { dim, println, Style } from "./ui"
import { groupCatalog, ORDER, type Category } from "./tools-catalog"

const handler = Effect.fn("cli.tools")(function* (
  input: Runtime.Input<typeof Commands.commands.tools>,
) {
  const { client } = yield* connect()
  // Usage is a bonus marker, never a reason to fail: a plugin without the
  // usage namespace still lists the catalog.
  const usage = yield* Effect.tryPromise({
    try: () => client.rpc(UsageRpc).toolUsage({}, here()),
    catch: () => undefined,
  }).pipe(Effect.catch(() => Effect.succeed(undefined)))
  const used = new Map((usage?.tools ?? []).map((tool) => [tool.toolId, tool.useCount]))

  const filter = Option.getOrUndefined(input.category)
  const grouped = groupCatalog()
  const registered = [...grouped.values()].reduce((total, names) => total + names.length, 0)

  println(Style.TEXT_HIGHLIGHT + "Tool Catalog" + Style.TEXT_NORMAL)
  println(dim(`  registered:  ${registered}`))
  println(dim(`  materialized: ${registered}`))
  println(dim(`  visible:     ${registered}`))
  println(dim("  source:      static (v2 has no tool-catalog RPC)"))
  println("")

  const categories: ReadonlyArray<Category> = filter ? [filter as Category] : ORDER
  for (const category of categories) {
    const entries = grouped.get(category) ?? []
    if (entries.length === 0) continue
    println(Style.TEXT_INFO_BOLD + `${category}` + Style.TEXT_NORMAL)
    for (const name of entries) {
      const count = used.get(name)
      println(`  ${Style.TEXT_SUCCESS}✓${Style.TEXT_NORMAL} ${name}${count === undefined ? "" : dim(` (${count} uses)`)}`)
    }
    println("")
  }
})

export default Runtime.handler(Commands.commands.tools, (input) =>
  handler(input).pipe(Effect.catch(onError({ id: "banyancode.usage", method: "toolUsage" }))),
)
