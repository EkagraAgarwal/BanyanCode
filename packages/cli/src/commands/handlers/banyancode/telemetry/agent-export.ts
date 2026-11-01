import { Effect, Option } from "effect"
import { EOL } from "node:os"
import { Commands } from "../../../commands"
import { Runtime } from "../../../../framework/runtime"
import { connect, here, onError } from "../client"
import { UsageRpc } from "../rpc"

const handler = Effect.fn("cli.telemetry.agentExport")(function* (
  input: Runtime.Input<(typeof Commands.commands.telemetry.commands)["agent-export"]>,
) {
  const { client } = yield* connect()
  const result = yield* Effect.tryPromise({
    try: () =>
      client.rpc(UsageRpc)["telemetry.agentExport"](
        {
          runID: Option.getOrUndefined(input.runId),
          sessionID: Option.getOrUndefined(input.sessionId),
          since: Option.getOrUndefined(input.since),
        },
        here(),
      ),
    catch: (cause) => cause,
  })
  // v1 streamed one JSON object per line to stdout, with a single trailing EOL.
  const body = result.jsonl.replace(/(?:\r?\n)+$/, "")
  process.stdout.write(body.length === 0 ? "" : body + EOL)
})

export default Runtime.handler(Commands.commands.telemetry.commands["agent-export"], (input) =>
  handler(input).pipe(
    Effect.catch(onError({ id: "banyancode.usage", method: "telemetry.agentExport" })),
  ),
)
