import { Auth } from "@/auth"

import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"

const AuthParams = Schema.Struct({
  providerID: ProviderV2.ID,
})

export const AuthPaths = {
  auth: "/auth/:providerID",
} as const

// Auth credentials live in the global auth.json but the endpoints that write
// them must also run inside an instance context: the handlers mark the current
// instance for disposal so the Provider service reloads auth.json and the TUI
// refreshes its provider list (sync re-bootstraps on `server.instance.disposed`).
// The previous home for these routes was ControlApi on RootHttpApi, which never
// binds InstanceContextMiddleware — `InstanceState.context` died with
// "InstanceRef not provided", every set/remove returned an opaque 500, and the
// removal never became visible until a restart. InstanceHttpApi provides both
// WorkspaceRoutingMiddleware and InstanceContextMiddleware (see server.ts).
export const AuthApi = HttpApi.make("auth").add(
  HttpApiGroup.make("auth")
    .add(
      HttpApiEndpoint.put("authSet", AuthPaths.auth, {
        params: AuthParams,
        query: WorkspaceRoutingQuery,
        payload: Auth.Info,
        success: described(Schema.Boolean, "Successfully set authentication credentials"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "auth.set",
          summary: "Set auth credentials",
          description: "Set authentication credentials",
        }),
      ),
      HttpApiEndpoint.delete("authRemove", AuthPaths.auth, {
        params: AuthParams,
        query: WorkspaceRoutingQuery,
        success: described(Schema.Boolean, "Successfully removed authentication credentials"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "auth.remove",
          summary: "Remove auth credentials",
          description: "Remove authentication credentials",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "auth", description: "Auth credential routes." }))
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
