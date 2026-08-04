import { Effect, Scope, Stream } from "effect"
import { EventV2 } from "../event"
import { PluginV2 } from "../plugin"
import { Auth } from "../auth"

// Depending on what account is active, enable matching providers for that
// service
export const AccountPlugin = PluginV2.define({
  id: PluginV2.ID.make("account"),
  effect: Effect.gen(function* () {
    const accounts = yield* Auth.Service
    const events = yield* EventV2.Service
    const scope = yield* Scope.Scope

    yield* events.subscribe(Auth.Event.Switched).pipe(
      Stream.runForEach((event) =>
        PluginV2.Service.use((plugin) => plugin.trigger("account.switched", event.data, {})).pipe(Effect.asVoid),
      ),
      Effect.forkIn(scope, { startImmediately: true }),
    )

    return {
      "catalog.transform": Effect.fn(function* (evt) {
        const active = yield* accounts.activeAll().pipe(Effect.orDie)
        for (const item of evt.provider.list()) {
          const account = active.get(Auth.ServiceID.make(item.provider.id))
          if (account) {
            evt.provider.update(item.provider.id, (provider) => {
              provider.enabled = {
                via: "account",
                service: account.serviceID,
              }
              if (account.credential.type === "api") {
                provider.request.body.apiKey = account.credential.key
                Object.assign(provider.request.body, account.credential.metadata ?? {})
              }
              if (account.credential.type === "oauth") provider.request.body.apiKey = account.credential.access
            })
          } else if (typeof item.provider.enabled === "object" && item.provider.enabled.via === "account") {
            // The account backing this provider was removed. Reset availability
            // so the provider (and its models) drop out of the catalog's
            // available() lists — otherwise the model picker keeps showing the
            // provider's models until restart. Preserve env-based enablement:
            // an env var for the provider still makes it usable.
            const envKey = item.provider.env.find((env) => process.env[env])
            evt.provider.update(item.provider.id, (provider) => {
              provider.enabled = envKey ? { via: "env", name: envKey } : false
            })
          }
        }
      }),
      "account.switched": Effect.fn(function* () {}),
    }
  }),
})
