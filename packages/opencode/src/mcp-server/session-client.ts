// Production SessionClient over the real opencode SDK v2 (Milestone B, §4.1).
//
// Implements the SessionClient port from ./types with live HTTP calls:
// session.create/promptAsync/prompt/abort/status/messages/diff/todo/children/get, permission.list/reply and
// question.list/reply/reject. No fakes here; every method hits the server.
//
// Child sessions link through session.parentID (tool/task.ts sets it), so
// pending/cost/subagents aggregate over the root plus its recursive
// children via session.children. v1 permission/question lists are
// location-wide and carry sessionID, which covers child asks with one
// round trip each. subagents resolves agent/model/status per child through
// session.get plus the session.status map: the mesh peers endpoint has no
// model field, so it cannot fill the port's model slot.

import type { createOpencodeClient, PermissionRuleset, TextPartInput } from "@opencode-ai/sdk/v2"
import type { DiffFileInput, VerifierToolPartInput } from "./result"
import type { PendingQuestion, SessionClient, SessionMessage } from "./types"

export type SdkClient = ReturnType<typeof createOpencodeClient>

export interface SdkSessionClientOptions {
  sdk?: SdkClient
  baseUrl?: string
  directory: string
  headers?: Record<string, string>
  defaultAgent?: string
  defaultModel?: { providerID: string; id: string; variant?: string }
  permission?: PermissionRuleset
  metadata?: Record<string, string>
}

export interface SdkCreateSessionInput {
  title?: string
  metadata: Record<string, string>
  agent?: string
  model?: string
  permission?: PermissionRuleset
  // Per-call SDK root (C2): a worktree task passes its checkout path so the
  // session is rooted there. Falls back to the construction directory.
  directory?: string
}

// "provider/model" (run.ts, provider.ts and tool/task.ts all split on the
// first slash). Returns undefined when there is no slash to split on, so
// the caller falls back to the server default instead of sending garbage.
export function splitModelRef(model: string): { providerID: string; modelID: string } | undefined {
  const [providerID, ...rest] = model.split("/")
  if (!providerID || rest.length === 0) return undefined
  return { providerID, modelID: rest.join("/") }
}

function describeError(error: unknown): string {
  if (typeof error === "string") return error
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message
  }
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

function unwrap<T>(result: { data: T } | { error: unknown }, what: string): NonNullable<T> {
  if ("error" in result && result.error !== undefined && result.error !== null) {
    throw new Error(`${what} failed: ${describeError(result.error)}`)
  }
  if (!("data" in result) || result.data === undefined) throw new Error(`${what} returned no data`)
  return result.data as NonNullable<T>
}

function unwrapVoid(result: { error?: unknown }, what: string): void {
  if (result.error !== undefined && result.error !== null) {
    throw new Error(`${what} failed: ${describeError(result.error)}`)
  }
}

function textOfParts(parts: Array<{ type: string; text?: string }>): string {
  const out: Array<string> = []
  for (const part of parts) {
    if (part.type === "text" && part.text !== undefined) out.push(part.text)
  }
  return out.join("\n")
}

export class SdkSessionClient implements SessionClient {
  private constructor(
    private readonly sdk: SdkClient,
    private readonly directory: string,
    private readonly defaults: Pick<SdkSessionClientOptions, "defaultAgent" | "defaultModel" | "permission" | "metadata">,
  ) {}

  static async create(options: SdkSessionClientOptions): Promise<SdkSessionClient> {
    if (options.sdk) {
      return new SdkSessionClient(options.sdk, options.directory, options)
    }
    if (!options.baseUrl) throw new Error("createSdkSessionClient needs either sdk or baseUrl")
    const { createOpencodeClient } = await import("@opencode-ai/sdk/v2")
    const sdk = createOpencodeClient({
      baseUrl: options.baseUrl,
      directory: options.directory,
      ...(options.headers !== undefined ? { headers: options.headers } : {}),
    })
    return new SdkSessionClient(sdk, options.directory, options)
  }

  private resolveAgent(input?: string): string | undefined {
    return input ?? this.defaults.defaultAgent
  }

  private resolveCreateModel(input?: string): { id: string; providerID: string; variant?: string } | undefined {
    if (input !== undefined) {
      const split = splitModelRef(input)
      if (split) return { id: split.modelID, providerID: split.providerID }
      return undefined
    }
    return this.defaults.defaultModel
  }

  private resolvePromptModel(input?: string): { providerID: string; modelID: string } | undefined {
    if (input !== undefined) return splitModelRef(input)
    const fallback = this.defaults.defaultModel
    if (!fallback) return undefined
    return { providerID: fallback.providerID, modelID: fallback.id }
  }

  // Per-call directory override (C2): worktree tasks scope every SDK call
  // to their checkout; everything else keeps the construction root.
  private dir(input: { directory?: string }): string {
    return input.directory ?? this.directory
  }

  async createSession(input: SdkCreateSessionInput): Promise<{ id: string }> {
    const agent = this.resolveAgent(input.agent)
    const model = this.resolveCreateModel(input.model)
    const permission = input.permission ?? this.defaults.permission
    const created = unwrap(
      await this.sdk.session.create({
        directory: this.dir(input),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(agent !== undefined ? { agent } : {}),
        ...(model !== undefined ? { model } : {}),
        metadata: { ...this.defaults.metadata, ...input.metadata },
        ...(permission !== undefined ? { permission } : {}),
      }),
      "session.create",
    )
    return { id: created.id }
  }

  async promptAsync(input: { sessionID: string; prompt: string; agent?: string; model?: string; directory?: string }): Promise<void> {
    const agent = this.resolveAgent(input.agent)
    const model = this.resolvePromptModel(input.model)
    const parts: Array<TextPartInput> = [{ type: "text", text: input.prompt }]
    unwrapVoid(
      await this.sdk.session.promptAsync({
        sessionID: input.sessionID,
        directory: this.dir(input),
        ...(agent !== undefined ? { agent } : {}),
        ...(model !== undefined ? { model } : {}),
        parts,
      }),
      "session.promptAsync",
    )
  }

  async prompt(input: { sessionID: string; prompt: string; agent?: string; model?: string; directory?: string }): Promise<void> {
    const agent = this.resolveAgent(input.agent)
    const model = this.resolvePromptModel(input.model)
    const parts: Array<TextPartInput> = [{ type: "text", text: input.prompt }]
    unwrapVoid(
      await this.sdk.session.prompt({
        sessionID: input.sessionID,
        directory: this.dir(input),
        ...(agent !== undefined ? { agent } : {}),
        ...(model !== undefined ? { model } : {}),
        parts,
      }),
      "session.prompt",
    )
  }

  async abort(input: { sessionID: string; directory?: string }): Promise<void> {
    unwrapVoid(
      await this.sdk.session.abort({ sessionID: input.sessionID, directory: this.dir(input) }),
      "session.abort",
    )
  }

  async sessionStatus(input: { sessionID: string; directory?: string }): Promise<"busy" | "idle" | "retry" | "failed"> {
    const directory = this.dir(input)
    const all = unwrap(await this.sdk.session.status({ directory }), "session.status")
    const entry = all[input.sessionID]
    if (entry) return entry.type
    // The status map only tracks non-idle sessions (the service deletes
    // idle entries), so a missing entry is idle — provided the session
    // exists at all. session.get 404s for unknown IDs.
    const existing = await this.sdk.session.get({ sessionID: input.sessionID, directory })
    if (existing.error !== undefined && existing.error !== null) {
      throw new Error(`unknown session: ${input.sessionID}`)
    }
    return "idle"
  }

  async messages(input: { sessionID: string; limit?: number; directory?: string }): Promise<SessionMessage[]> {
    const rows = unwrap(
      await this.sdk.session.messages({
        sessionID: input.sessionID,
        directory: this.dir(input),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      }),
      "session.messages",
    )
    return rows.map((row) => ({
      role: row.info.role,
      text: textOfParts(row.parts),
      time: row.info.time.created,
    }))
  }

  async diff(input: { sessionID: string; directory?: string }): Promise<DiffFileInput[]> {
    const files = unwrap(
      await this.sdk.session.diff({ sessionID: input.sessionID, directory: this.dir(input) }),
      "session.diff",
    )
    const out: DiffFileInput[] = []
    for (const file of files) {
      if (file.file === undefined) continue
      out.push({
        path: file.file,
        additions: file.additions,
        deletions: file.deletions,
        ...(file.patch !== undefined ? { patch: file.patch } : {}),
      })
    }
    return out
  }

  async todo(input: { sessionID: string; directory?: string }): Promise<Array<{ title: string; status: string }>> {
    const todos = unwrap(
      await this.sdk.session.todo({ sessionID: input.sessionID, directory: this.dir(input) }),
      "session.todo",
    )
    return todos.map((item) => ({ title: item.content, status: item.status }))
  }

  private async tree(sessionID: string, directory: string): Promise<string[]> {
    const children = unwrap(
      await this.sdk.session.children({ sessionID, directory }),
      "session.children",
    )
    const nested = await Promise.all(children.map((child) => this.tree(child.id, directory)))
    return [sessionID, ...nested.flat()]
  }

  async pending(input: { sessionID: string; directory?: string }): Promise<PendingQuestion[]> {
    const directory = this.dir(input)
    const owned = new Set(await this.tree(input.sessionID, directory))
    const [permissions, questions] = await Promise.all([
      unwrap(await this.sdk.permission.list({ directory }), "permission.list"),
      unwrap(await this.sdk.question.list({ directory }), "question.list"),
    ])
    const out: PendingQuestion[] = []
    for (const item of permissions) {
      if (!owned.has(item.sessionID)) continue
      const title = `${item.permission} ${item.patterns.join(" ")}`.trim()
      out.push({ requestID: item.id, kind: "permission", title, askedAt: Date.now() })
    }
    for (const item of questions) {
      if (!owned.has(item.sessionID)) continue
      const first = item.questions[0]
      out.push({
        requestID: item.id,
        kind: "question",
        title: first?.header ?? first?.question ?? "question",
        detail: item.questions.map((entry) => entry.question).join("\n"),
        askedAt: Date.now(),
      })
    }
    return out
  }

  async subagents(input: { sessionID: string; directory?: string }): Promise<Array<{ agent: string; model: string; status: string }>> {
    const directory = this.dir(input)
    const ids = (await this.tree(input.sessionID, directory)).filter((id) => id !== input.sessionID)
    const [statusResult, getResults] = await Promise.all([
      this.sdk.session.status({ directory }),
      Promise.all(ids.map((id) => this.sdk.session.get({ sessionID: id, directory }))),
    ])
    const status = unwrap(statusResult, "session.status")
    const infos = getResults.map((result) => unwrap(result, "session.get"))
    return infos.map((info) => ({
      agent: info.agent ?? "unknown",
      model: info.model ? `${info.model.providerID}/${info.model.id}` : "unknown",
      status: status[info.id]?.type ?? "idle",
    }))
  }

  async cost(input: { sessionID: string; directory?: string }): Promise<{
    cost: number
    tokensByModel: Record<string, { input: number; output: number }>
  }> {
    const directory = this.dir(input)
    const ids = await this.tree(input.sessionID, directory)
    const rawPages = await Promise.all(
      ids.map((id) => this.sdk.session.messages({ sessionID: id, directory })),
    )
    const pages = rawPages.map((result) => unwrap(result, "session.messages"))
    let total = 0
    const tokensByModel: Record<string, { input: number; output: number }> = {}
    for (const rows of pages) {
      for (const row of rows) {
        if (row.info.role !== "assistant") continue
        total += row.info.cost ?? 0
        const key = `${row.info.providerID}/${row.info.modelID}`
        const current = tokensByModel[key] ?? { input: 0, output: 0 }
        tokensByModel[key] = {
          input: current.input + (row.info.tokens?.input ?? 0),
          output: current.output + (row.info.tokens?.output ?? 0),
        }
      }
    }
    return { cost: total, tokensByModel }
  }

  // Raw tool parts across the root session's tree (children included),
  // mirroring the tree() walk behind pending/cost/subagents. Over the SDK,
  // part.state arrives as a JSON-encoded string and is decoded here; an
  // undecodable state still yields a part with status "unknown" so one bad
  // row can never take down result assembly.
  async toolParts(input: { sessionID: string; directory?: string }): Promise<VerifierToolPartInput[]> {
    const directory = this.dir(input)
    const ids = await this.tree(input.sessionID, directory)
    const rawPages = await Promise.all(ids.map((id) => this.sdk.session.messages({ sessionID: id, directory })))
    const pages = rawPages.map((result) => unwrap(result, "session.messages"))
    const out: VerifierToolPartInput[] = []
    for (const rows of pages) {
      for (const row of rows) {
        const messageParts = (row as { parts?: unknown }).parts
        if (!Array.isArray(messageParts)) continue
        for (const part of messageParts) {
          const candidate = part as { type?: unknown; tool?: unknown; state?: unknown }
          if (candidate.type !== "tool" || typeof candidate.tool !== "string") continue
          let decoded: { status?: unknown; output?: unknown; error?: unknown } | undefined
          if (typeof candidate.state === "string") {
            try {
              decoded = JSON.parse(candidate.state) as { status?: unknown; output?: unknown; error?: unknown }
            } catch {
              decoded = undefined
            }
          } else if (candidate.state !== null && typeof candidate.state === "object") {
            decoded = candidate.state as { status?: unknown; output?: unknown; error?: unknown }
          }
          const entry: VerifierToolPartInput = {
            tool: candidate.tool,
            status: typeof decoded?.status === "string" ? decoded.status : "unknown",
          }
          if (typeof decoded?.output === "string") entry.output = decoded.output
          if (typeof decoded?.error === "string") entry.error = decoded.error
          out.push(entry)
        }
      }
    }
    return out
  }

  async replyPermission(input: {
    sessionID: string
    requestID: string
    reply: "once" | "always" | "reject"
    message?: string
    directory?: string
  }): Promise<void> {    void input.sessionID
    unwrapVoid(
      await this.sdk.permission.reply({
        requestID: input.requestID,
        directory: this.dir(input),
        reply: input.reply,
        ...(input.message !== undefined ? { message: input.message } : {}),
      }),
      "permission.reply",
    )
  }

  async rejectQuestion(input: { sessionID: string; requestID: string; message?: string; directory?: string }): Promise<void> {
    void input.sessionID
    void input.message
    unwrapVoid(
      await this.sdk.question.reject({ requestID: input.requestID, directory: this.dir(input) }),
      "question.reject",
    )
  }

  async replyQuestion(input: { sessionID: string; requestID: string; message: string; directory?: string }): Promise<void> {
    void input.sessionID
    // The port carries a single free-text answer; the v1 route takes one
    // answer array per question. Send it as the first question's answer —
    // multi-question requests need the task layer to reply per question.
    unwrapVoid(
      await this.sdk.question.reply({
        requestID: input.requestID,
        directory: this.dir(input),
        answers: [[input.message]],
      }),
      "question.reply",
    )
  }
}

// Mirrors how server.ts builds its client (createOpencodeClient with
// baseUrl + directory + headers), then wraps it in the port implementation.
// Pass a prebuilt sdk (e.g. from createMcpServer) when one already exists.
export async function createSdkSessionClient(options: SdkSessionClientOptions): Promise<SessionClient> {
  return SdkSessionClient.create(options)
}

export * as SdkSessionClientNs from "./session-client"
