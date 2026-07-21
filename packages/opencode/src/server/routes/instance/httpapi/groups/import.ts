import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
import { Authorization } from "../middleware/authorization"
import { described } from "./metadata"

export const SessionImportInput = Schema.Struct({
  content: Schema.String,
  title: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  parentID: Schema.optional(SessionSchema.ID),
})

export const SessionImportResult = Schema.Struct({
  sessionID: SessionSchema.ID,
  title: Schema.String,
  messageCount: Schema.Finite,
  startedFromParsedSessionID: Schema.optional(Schema.String),
})

export const SessionImportPaths = {
  sessionImport: "/global/session/import",
} as const

export const SessionImportApi = HttpApi.make("sessionImport").add(
  HttpApiGroup.make("sessionImport")
    .add(
      HttpApiEndpoint.post("sessionImport", SessionImportPaths.sessionImport, {
        payload: SessionImportInput,
        success: described(SessionImportResult, "Imported session"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.session.import",
          summary: "Import session from transcript",
          description:
            "Parse a Markdown transcript (the format produced by /export) and create a new session containing the parsed messages. Useful for sharing or transferring sessions between machines. The original session ID from the transcript is preserved in the response but the new session gets a fresh ID.",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "sessionImport",
        description:
          "Session import endpoint mounted on InstanceHttpApi so it inherits the workspace routing and instance context layers.",
      }),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
