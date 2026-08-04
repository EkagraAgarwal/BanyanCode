import { Auth } from "@/auth"

import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ProviderV2 } from "@opencode-ai/core/provider"
import * as InstanceState from "@/effect/instance-state"
import { markInstanceForDisposal } from "../lifecycle"

export const authHandlers = HttpApiBuilder.group(InstanceHttpApi, "auth", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* Auth.Service

    const authSet = Effect.fn("AuthHttpApi.authSet")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: Auth.Info
    }) {
      yield* auth.set(ctx.params.providerID, ctx.payload).pipe(Effect.orDie)
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return true
    })

    const authRemove = Effect.fn("AuthHttpApi.authRemove")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
    }) {
      yield* auth.remove(ctx.params.providerID).pipe(Effect.orDie)
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return true
    })

    return handlers.handle("authSet", authSet).handle("authRemove", authRemove)
  }),
)
