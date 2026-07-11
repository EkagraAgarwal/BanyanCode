import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import {
  MemoryEnvelopeV1Schema,
  MemoryKindSchema,
  MemoryStatusSchema,
} from "@opencode-ai/core/banyancode/memory-payload"
import { described } from "./metadata"

/**
 * Phase 1a: HTTP group for BanyanCode memory. Paths live under `/global/memory/*`
 * so they are callable from the TUI without an active session.
 *
 * Reads (`list`, `get`, `recall`, `search`) are typed; writes (`store`,
 * `forget`) are scoped + permission-checked at the tool layer (Phase 1b adds
 * the per-agent gate).
 */

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{4,63}$/
const KEY_PATTERN = /^[a-z0-9][a-z0-9:._-]{1,127}$/
const SCOPE_PATTERN = /^(global|session)$/

export const MemoryEntrySchema = Schema.Struct({
  id: Schema.String,
  key: Schema.String,
  value: Schema.Unknown,
  envelope: Schema.optional(MemoryEnvelopeV1Schema),
  context: Schema.optional(Schema.String),
  tags: Schema.Array(Schema.String),
  scope: Schema.Literals(["global", "session"]),
  sessionID: Schema.optional(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  expiresAt: Schema.optional(Schema.Number),
  agentID: Schema.optional(Schema.String),
  version: Schema.Number,
  namespace: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  body: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
}).annotate({ identifier: "Banyan/MemoryEntry" })

export const MemoryListInput = Schema.Struct({
  scope: Schema.optional(Schema.String.check(Schema.isPattern(SCOPE_PATTERN, { identifier: "Banyan/MemoryScope" }))),
  sessionID: Schema.optional(Schema.String),
  prefix: Schema.optional(Schema.String),
  kind: Schema.optional(MemoryKindSchema),
  status: Schema.optional(MemoryStatusSchema),
  limit: Schema.optional(Schema.Number),
}).annotate({ identifier: "Banyan/MemoryListInput" })

export const MemoryGetInput = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(ID_PATTERN, { identifier: "Banyan/MemoryID" })),
}).annotate({ identifier: "Banyan/MemoryGetInput" })

export const MemoryRecallInput = Schema.Struct({
  key: Schema.String.check(Schema.isPattern(KEY_PATTERN, { identifier: "Banyan/MemoryKey" })),
  scope: Schema.optional(Schema.String.check(Schema.isPattern(SCOPE_PATTERN, { identifier: "Banyan/MemoryScope" }))),
  sessionID: Schema.optional(Schema.String),
}).annotate({ identifier: "Banyan/MemoryRecallInput" })

export const MemorySearchInput = Schema.Struct({
  query: Schema.String.check(Schema.isMaxLength(512)),
  limit: Schema.optional(Schema.Number),
  scope: Schema.optional(Schema.String.check(Schema.isPattern(SCOPE_PATTERN, { identifier: "Banyan/MemoryScope" }))),
  sessionID: Schema.optional(Schema.String),
  kind: Schema.optional(MemoryKindSchema),
  status: Schema.optional(MemoryStatusSchema),
}).annotate({ identifier: "Banyan/MemorySearchInput" })

export const MemorySearchResult = Schema.Struct({
  entries: Schema.Array(MemoryEntrySchema),
  totalHits: Schema.Number,
  degraded: Schema.Boolean,
}).annotate({ identifier: "Banyan/MemorySearchResult" })

export const MemoryStoreInput = Schema.Struct({
  id: Schema.optional(Schema.String.check(Schema.isPattern(ID_PATTERN, { identifier: "Banyan/MemoryID" }))),
  key: Schema.String.check(Schema.isPattern(KEY_PATTERN, { identifier: "Banyan/MemoryKey" })),
  value: Schema.Unknown,
  envelope: Schema.optional(MemoryEnvelopeV1Schema),
  context: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.Array(Schema.String)),
  scope: Schema.String.check(Schema.isPattern(SCOPE_PATTERN, { identifier: "Banyan/MemoryScope" })),
  sessionID: Schema.optional(Schema.String),
  expiresAt: Schema.optional(Schema.Number),
  agentID: Schema.optional(Schema.String),
}).annotate({ identifier: "Banyan/MemoryStoreInput" })

export const MemoryStoreResult = Schema.Struct({
  id: Schema.String,
  version: Schema.Number,
}).annotate({ identifier: "Banyan/MemoryStoreResult" })

export const MemoryForgetInput = Schema.Struct({
  id: Schema.optional(Schema.String.check(Schema.isPattern(ID_PATTERN, { identifier: "Banyan/MemoryID" }))),
  key: Schema.optional(Schema.String.check(Schema.isPattern(KEY_PATTERN, { identifier: "Banyan/MemoryKey" }))),
  scope: Schema.optional(Schema.String.check(Schema.isPattern(SCOPE_PATTERN, { identifier: "Banyan/MemoryScope" }))),
  sessionID: Schema.optional(Schema.String),
}).annotate({ identifier: "Banyan/MemoryForgetInput" })

export const MemoryForgetResult = Schema.Struct({
  removed: Schema.Number,
}).annotate({ identifier: "Banyan/MemoryForgetResult" })

/**
 * Phase 1b: candidate lifecycle endpoints. Candidates live in the same
 * `memory_entries` table; `status="pending"` distinguishes them from canonical
 * active entries. `promote` flips a candidate to active and supersedes any
 * matching actives; `reject` flips it to rejected.
 */

export const MemoryCandidatesInput = Schema.Struct({
  status: Schema.optional(MemoryStatusSchema),
  scope: Schema.optional(Schema.String.check(Schema.isPattern(SCOPE_PATTERN, { identifier: "Banyan/MemoryScope" }))),
  limit: Schema.optional(Schema.Number),
}).annotate({ identifier: "Banyan/MemoryCandidatesInput" })

export const MemoryCandidatesResult = Schema.Struct({
  entries: Schema.Array(MemoryEntrySchema),
  count: Schema.Number,
}).annotate({ identifier: "Banyan/MemoryCandidatesResult" })

export const MemoryPromoteInput = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(ID_PATTERN, { identifier: "Banyan/MemoryID" })),
  expectedVersion: Schema.Number,
  key: Schema.optional(Schema.String.check(Schema.isPattern(KEY_PATTERN, { identifier: "Banyan/MemoryKey" }))),
  scope: Schema.optional(Schema.String.check(Schema.isPattern(SCOPE_PATTERN, { identifier: "Banyan/MemoryScope" }))),
  skipSupersede: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "Banyan/MemoryPromoteInput" })

export const MemoryPromoteResult = Schema.Struct({
  id: Schema.String,
  key: Schema.String,
  status: Schema.Literals(["active"]),
  version: Schema.Number,
  supersededIds: Schema.Array(Schema.String),
}).annotate({ identifier: "Banyan/MemoryPromoteResult" })

export const MemoryRejectInput = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(ID_PATTERN, { identifier: "Banyan/MemoryID" })),
  expectedVersion: Schema.Number,
}).annotate({ identifier: "Banyan/MemoryRejectInput" })

export const MemoryRejectResult = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["rejected"]),
  version: Schema.Number,
}).annotate({ identifier: "Banyan/MemoryRejectResult" })

/**
 * Phase 4: projection / digest endpoints. Read-only derived views over
 * `memory_entries`.
 */

export const MemorySummaryInput = Schema.Struct({
  scope: Schema.optional(Schema.String.check(Schema.isPattern(SCOPE_PATTERN, { identifier: "Banyan/MemoryScope" }))),
  sessionID: Schema.optional(Schema.String),
  maxItems: Schema.optional(Schema.Number),
}).annotate({ identifier: "Banyan/MemorySummaryInput" })

export const MemoryDigestItem = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  title: Schema.String,
  body: Schema.String,
  importance: Schema.Literals(["low", "medium", "high"]),
  confidence: Schema.Literals(["low", "medium", "high"]),
  updatedAt: Schema.Number,
}).annotate({ identifier: "Banyan/MemoryDigestItem" })

export const MemorySummarySection = Schema.Struct({
  kind: Schema.String,
  count: Schema.Number,
}).annotate({ identifier: "Banyan/MemorySummarySection" })

export const MemorySummaryResult = Schema.Struct({
  totalActive: Schema.Number,
  byKind: Schema.Array(MemorySummarySection),
  decisionDigest: Schema.Array(MemoryDigestItem),
  warningDigest: Schema.Array(MemoryDigestItem),
  generatedAt: Schema.Number,
}).annotate({ identifier: "Banyan/MemorySummaryResult" })

export const MEMORY_PREFIX = "/global/memory"

export const MemoryPaths = {
  list: `${MEMORY_PREFIX}/list`,
  get: `${MEMORY_PREFIX}/get`,
  recall: `${MEMORY_PREFIX}/recall`,
  search: `${MEMORY_PREFIX}/search`,
  store: `${MEMORY_PREFIX}/store`,
  forget: `${MEMORY_PREFIX}/forget`,
  candidates: `${MEMORY_PREFIX}/candidates`,
  promote: `${MEMORY_PREFIX}/promote`,
  reject: `${MEMORY_PREFIX}/reject`,
  summary: `${MEMORY_PREFIX}/summary`,
} as const

export const MemoryApi = HttpApi.make("memory").add(
  HttpApiGroup.make("memory")
    .add(
      HttpApiEndpoint.post("list", MemoryPaths.list, {
        payload: MemoryListInput,
        success: described(Schema.Array(MemoryEntrySchema), "Matching memory entries"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "memory.list",
          summary: "List memory entries",
          description: "Returns memory entries filtered by scope/session, optional kind/status, and key prefix.",
        }),
      ),
      HttpApiEndpoint.post("get", MemoryPaths.get, {
        payload: MemoryGetInput,
        success: described(MemoryEntrySchema, "Memory entry by id"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "memory.get",
          summary: "Get memory entry by id",
          description: "Returns the entry with the given id, or 404 if not found.",
        }),
      ),
      HttpApiEndpoint.post("recall", MemoryPaths.recall, {
        payload: MemoryRecallInput,
        success: described(Schema.Array(MemoryEntrySchema), "Memory entries for key"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "memory.recall",
          summary: "Recall by key",
          description: "Returns memory entries whose key matches exactly within the given scope.",
        }),
      ),
      HttpApiEndpoint.post("search", MemoryPaths.search, {
        payload: MemorySearchInput,
        success: described(MemorySearchResult, "BM25-ranked memory search results"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "memory.search",
          summary: "Search memory (FTS5 / BM25)",
          description:
            "Full-text search across key, title, body, and kind. Falls back to a degraded keyword scan when the FTS table is unavailable.",
        }),
      ),
      HttpApiEndpoint.post("store", MemoryPaths.store, {
        payload: MemoryStoreInput,
        success: described(MemoryStoreResult, "Stored memory entry"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "memory.store",
          summary: "Store memory entry",
          description:
            "Writes a new entry or bumps the version of an existing id. The `value` is wrapped in the MemoryPayloadV1 envelope unless `envelope` is provided. Permission-checked.",
        }),
      ),
      HttpApiEndpoint.post("forget", MemoryPaths.forget, {
        payload: MemoryForgetInput,
        success: described(MemoryForgetResult, "Forget result"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "memory.forget",
          summary: "Forget memory entries",
          description: "Removes the entry by id OR by (scope, key) pair. Returns the number of rows removed.",
        }),
      ),
      HttpApiEndpoint.post("candidates", MemoryPaths.candidates, {
        payload: MemoryCandidatesInput,
        success: described(MemoryCandidatesResult, "Candidate memory entries"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "memory.candidates",
          summary: "List candidate memory entries",
          description:
            "Lists memory entries filtered by status (typically `pending`). The candidate lifecycle is: emit (status=pending) → promote (status=active, supersedes matching actives) → reject (status=rejected).",
        }),
      ),
      HttpApiEndpoint.post("promote", MemoryPaths.promote, {
        payload: MemoryPromoteInput,
        success: described(MemoryPromoteResult, "Promote result"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "memory.promote",
          summary: "Promote a candidate memory entry",
          description:
            "Transitions a candidate entry to status=active. Optimistic concurrency on `expectedVersion`. Unless `skipSupersede=true`, also marks existing actives that share the same fingerprint (kind + title) as `superseded`.",
        }),
      ),
      HttpApiEndpoint.post("reject", MemoryPaths.reject, {
        payload: MemoryRejectInput,
        success: described(MemoryRejectResult, "Reject result"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "memory.reject",
          summary: "Reject a candidate memory entry",
          description:
            "Transitions a candidate entry to status=rejected. Optimistic concurrency on `expectedVersion`.",
        }),
      ),
      HttpApiEndpoint.post("summary", MemoryPaths.summary, {
        payload: MemorySummaryInput,
        success: described(MemorySummaryResult, "Memory summary projection"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "memory.summary",
          summary: "Memory summary projection",
          description:
            "Returns a regenerable derived view: total active count, by-kind sections, decision digest, and warning digest. Backed by `MemoryProjection`.",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "memory",
        description: "BanyanCode memory HTTP surface (Phase 1a).",
      }),
    ),
)