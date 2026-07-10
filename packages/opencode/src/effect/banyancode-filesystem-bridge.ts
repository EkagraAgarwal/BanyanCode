import { Effect, Option } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Banyan } from "@opencode-ai/core/banyancode"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"

export const applyFilesystemBridge = Effect.gen(function* () {
  const fsOpt = yield* Effect.serviceOption(Banyan.BanyanFilesystemService)
  if (Option.isNone(fsOpt)) return
  const eventsOpt = yield* Effect.serviceOption(EventV2Bridge.Service)
  if (Option.isNone(eventsOpt)) return

  const fsSvc = fsOpt.value
  const events = eventsOpt.value

  yield* events.listen((event) =>
    event.type === "file.watcher.updated"
      ? fsSvc.invalidate((event.data as { file: string }).file)
      : Effect.void,
  )
})
