import { Effect, Option } from "effect"
import { Commands } from "../../../commands"
import { Runtime } from "../../../../framework/runtime"
import { connect, here, onError } from "../client"
import { UsageRpc } from "../rpc"
import { println, out, Style } from "../ui"

const handler = Effect.fn("cli.telemetry.agentReport")(function* (
  input: Runtime.Input<(typeof Commands.commands.telemetry.commands)["agent-report"]>,
) {
  const { client } = yield* connect()
  const report = yield* Effect.tryPromise({
    try: () =>
      client.rpc(UsageRpc)["telemetry.agentReport"](
        {
          runID: Option.getOrUndefined(input.runId),
          sessionID: Option.getOrUndefined(input.sessionId),
          since: Option.getOrUndefined(input.since),
        },
        here(),
      ),
    catch: (cause) => cause,
  })
  if (input.json) {
    out(JSON.stringify(report, null, 2))
    return
  }
  println(Style.TEXT_HIGHLIGHT + "Agent telemetry" + Style.TEXT_NORMAL)
  println(`  events: ${report.eventCount}`)
  println(`  runs: ${report.runCount}`)
  println(`  agents: ${report.agentCount}`)
  println(`  model calls: ${report.modelCallCount}`)
  println(`  tool calls: ${report.toolCallCount}`)
  println(`  input tokens: ${report.inputTokens}`)
  println(`  cached input tokens: ${report.cachedInputTokens}`)
  println(`  uncached input tokens: ${report.uncachedInputTokens}`)
  println(`  output tokens: ${report.outputTokens}`)
  println(`  total cost: ${report.totalCost}`)
  println(
    `  realized cache-read ratio: ${report.realizedCacheReadRatio === null ? "unknown" : report.realizedCacheReadRatio}`,
  )
  for (const [role, values] of Object.entries(report.byRole)) {
    println(`  ${role}: ${values.events} events, ${values.inputTokens} input, ${values.outputTokens} output`)
  }
})

export default Runtime.handler(Commands.commands.telemetry.commands["agent-report"], (input) =>
  handler(input).pipe(
    Effect.catch(onError({ id: "banyancode.usage", method: "telemetry.agentReport" })),
  ),
)
