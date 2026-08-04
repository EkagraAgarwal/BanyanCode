import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { Effect, Layer, Option, Record, Result, Schema, Context } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import {
  ApiKeyCredential,
  OAuthCredential,
  Service as AccountService,
  ServiceID,
} from "@opencode-ai/core/auth"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

const file = path.join(Global.Path.data, "auth.json")

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

export const Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export type Info = Schema.Schema.Type<typeof Info>

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Auth") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* FSUtil.Service
    const decode = Schema.decodeUnknownOption(Info)

    const all = Effect.fn("Auth.all")(function* () {
      if (process.env.OPENCODE_AUTH_CONTENT) {
        try {
          return JSON.parse(process.env.OPENCODE_AUTH_CONTENT)
        } catch (err) {}
      }

      const data = (yield* fsys.readJson(file).pipe(Effect.orElseSucceed(() => ({})))) as Record<string, unknown>
      return Record.filterMap(data, (value) => Result.fromOption(decode(value), () => undefined))
    })

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[providerID]
    })

    // Mirror a V1 credential write into the V2 account store (account.json).
    // The V2 catalog decides provider/model availability from account.json and
    // only re-evaluates on V2 account events, so a V1-only write leaves the
    // model picker stale: after removing a credential the provider's models
    // still appear as available until restart. Best-effort: skip when the V2
    // Account service is not in scope (e.g. CLI-only runtimes).
    const syncAccount = Effect.fnUntraced(function* (key: string, info?: Info) {
      const opt = yield* Effect.serviceOption(AccountService)
      if (Option.isNone(opt)) return
      const accounts = opt.value
      const serviceID = ServiceID.make(key)
      const existing = yield* accounts.forService(serviceID).pipe(Effect.orDie)

      if (!info) {
        for (const account of existing) {
          yield* accounts.remove(account.id).pipe(Effect.orDie)
        }
        return
      }

      if (info.type === "wellknown") return
      const credential =
        info.type === "api"
          ? new ApiKeyCredential({
              type: "api",
              key: info.key,
              ...(info.metadata ? { metadata: info.metadata } : {}),
            })
          : new OAuthCredential({
              type: "oauth",
              refresh: info.refresh,
              access: info.access,
              expires: info.expires,
            })
      const match = existing[0]
      if (match) {
        yield* accounts.update(match.id, { credential }).pipe(Effect.orDie)
        // update() publishes no event; activate() publishes Switched, which
        // triggers the catalog refresh so availability re-evaluates.
        yield* accounts.activate(match.id).pipe(Effect.orDie)
      } else {
        yield* accounts.create({ serviceID, credential }).pipe(Effect.orDie)
      }
    })

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* all()
      if (norm !== key) delete data[key]
      delete data[norm + "/"]
      yield* fsys
        .writeJson(file, { ...data, [norm]: info }, 0o600)
        .pipe(Effect.mapError(fail("Failed to write auth data")))
      yield* syncAccount(norm, info)
    })

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* all()
      delete data[key]
      delete data[norm]
      yield* fsys.writeJson(file, data, 0o600).pipe(Effect.mapError(fail("Failed to write auth data")))
      yield* syncAccount(norm)
    })

    return Service.of({ get, all, set, remove })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(FSUtil.defaultLayer))

export const node = LayerNode.make(layer, [FSUtil.node])

export * as Auth from "."
