// In-memory SessionPort for engine tests. Mirrors the v2 shapes the engine
// actually consumes; no network, no mocks of the engine itself.

import type { FormInfo, PermissionRequest } from "@opencode/client"
import type {
  FormSummary,
  MessagePage,
  MessageSummary,
  SessionPort,
  SessionSummary,
} from "../src/session-client"
import type { EngineEvent } from "../src/events"
import type { DurableEvent } from "../src/digest"

export type FakeSession = {
  id: string
  parentID?: string
  title?: string
  metadata: Record<string, string>
  agent?: string
  model?: string
  location?: string
  cost: number
  tokens: { input: number; output: number; reasoning: number }
  outcome?: "succeeded" | "failed" | "interrupted"
  created: number
  updated: number
  active: boolean
  messages: MessageSummary[]
  log: DurableEvent[]
}

export type FakeCalls = {
  prompt: Array<{ sessionID: string; text: string; delivery?: string }>
  interrupt: string[]
  replyPermission: Array<{ sessionID: string; requestID: string; decision: string }>
  replyForm: Array<{ sessionID: string; formID: string; answer: Record<string, unknown> }>
  cancelForm: Array<{ sessionID: string; formID: string; message?: string }>
  updateMetadata: Array<{ sessionID: string; metadata: Record<string, string> }>
  createWorktree: Array<{ projectID: string; name?: string }>
  removeWorktree: Array<{ projectID: string; directory: string; force: boolean }>
}

export type FakePort = SessionPort & {
  sessions: Map<string, FakeSession>
  permissionStore: Map<string, PermissionRequest[]>
  formStore: Map<string, FormInfo[]>
  addPermission: (sessionID: string, request: PermissionRequest) => void
  addForm: (info: FormInfo) => void
  calls: FakeCalls
  emit: (event: EngineEvent) => void
  projectList: Array<{ id: string; canonical: string }>
  worktreeDirectory: string
}

let sequence = 0

export function createFakePort(options: { projects?: Array<{ id: string; canonical: string }> } = {}): FakePort {
  const sessions = new Map<string, FakeSession>()
  const permissions = new Map<string, PermissionRequest[]>()
  const forms = new Map<string, FormInfo[]>()
  const handlers = new Set<(event: EngineEvent) => void>()
  const calls: FakeCalls = {
    prompt: [],
    interrupt: [],
    replyPermission: [],
    replyForm: [],
    cancelForm: [],
    updateMetadata: [],
    createWorktree: [],
    removeWorktree: [],
  }
  const summary = (session: FakeSession): SessionSummary => ({
    id: session.id,
    ...(session.parentID !== undefined ? { parentID: session.parentID } : {}),
    ...(session.title !== undefined ? { title: session.title } : {}),
    metadata: { ...session.metadata },
    ...(session.agent !== undefined ? { agent: session.agent } : {}),
    ...(session.model !== undefined ? { model: session.model } : {}),
    cost: session.cost,
    tokens: { input: session.tokens.input, output: session.tokens.output, reasoning: session.tokens.reasoning },
    ...(session.location !== undefined ? { location: session.location } : {}),
    ...(session.outcome !== undefined ? { outcome: session.outcome } : {}),
    created: session.created,
    updated: session.updated,
  })
  const find = (id: string): FakeSession => {
    const session = sessions.get(id)
    if (session === undefined) throw new Error(`fake port: unknown session ${id}`)
    return session
  }

  const port: FakePort = {
    sessions,
    permissionStore: permissions,
    formStore: forms,
    addPermission: (sessionID, request) => {
      permissions.set(sessionID, [...(permissions.get(sessionID) ?? []), request])
    },
    addForm: (info) => {
      forms.set(info.sessionID, [...(forms.get(info.sessionID) ?? []), info])
    },
    calls,
    projectList: options.projects ?? [],
    worktreeDirectory: "/tmp/worktree",
    emit: (event) => {
      for (const handler of handlers) handler(event)
    },
    async createSession(input) {
      sequence += 1
      const id = `ses_${String(sequence).padStart(5, "0")}`
      sessions.set(id, {
        id,
        ...(input.parentID !== undefined ? { parentID: input.parentID } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        metadata: { ...input.metadata },
        ...(input.agent !== undefined ? { agent: input.agent } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.directory !== undefined ? { location: input.directory } : {}),
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0 },
        created: Date.now(),
        updated: Date.now(),
        active: false,
        messages: [],
        log: [],
      })
      return { id }
    },
    async updateMetadata(input) {
      calls.updateMetadata.push({ sessionID: input.sessionID, metadata: input.metadata })
      find(input.sessionID).metadata = { ...find(input.sessionID).metadata, ...input.metadata }
    },
    async prompt(input) {
      calls.prompt.push({
        sessionID: input.sessionID,
        text: input.text,
        ...(input.delivery !== undefined ? { delivery: input.delivery } : {}),
      })
      const session = find(input.sessionID)
      session.active = true
      session.messages.push({
        id: `msg_${session.messages.length + 1}`,
        type: "user",
        role: "user",
        text: input.text,
        created: Date.now(),
      })
    },
    async interrupt(input) {
      calls.interrupt.push(input.sessionID)
      const session = find(input.sessionID)
      session.active = false
      session.outcome = "interrupted"
    },
    async getSession(input) {
      const session = sessions.get(input.sessionID)
      return session === undefined ? undefined : summary(session)
    },
    async activeSessionIDs() {
      return new Set([...sessions.values()].filter((session) => session.active).map((session) => session.id))
    },
    async listSessions(input) {
      const all = [...sessions.values()].sort((a, b) => b.created - a.created)
      return all.slice(0, input?.limit ?? 200).map(summary)
    },
    async messagePage(input): Promise<MessagePage> {
      const session = find(input.sessionID)
      const ordered = [...session.messages].sort((a, b) => a.created - b.created)
      const offset = input.cursor !== undefined && input.cursor !== "" ? Number(input.cursor) : 0
      const limit = input.limit ?? 40
      const page = ordered.slice(offset, offset + limit)
      const next = offset + limit < ordered.length ? String(offset + limit) : undefined
      const result: MessagePage = { items: input.order === "desc" ? [...page].reverse() : page }
      if (next !== undefined) result.next = next
      return result
    },
    async log(input) {
      const session = find(input.sessionID)
      const after = input.after ?? 0
      return session.log.filter((event) => (event.durable?.seq ?? 0) > after)
    },
    async diff() {
      return []
    },
    async permissions(input) {
      return permissions.get(input.sessionID) ?? []
    },
    async replyPermission(input) {
      calls.replyPermission.push({
        sessionID: input.sessionID,
        requestID: input.requestID,
        decision: input.decision,
      })
      permissions.set(
        input.sessionID,
        (permissions.get(input.sessionID) ?? []).filter((request) => request.id !== input.requestID),
      )
    },
    async forms(input) {
      const list = forms.get(input.sessionID) ?? []
      return list.map(
        (form): FormSummary => ({
          id: form.id,
          sessionID: form.sessionID,
          title: form.title,
          fields: form.fields.map((field) => ({ key: field.key, type: field.type })),
        }),
      )
    },
    async formFields(input) {
      const form = (forms.get(input.sessionID) ?? []).find((item) => item.id === input.formID)
      if (form === undefined) throw new Error(`fake port: unknown form ${input.formID}`)
      return { title: form.title, fields: form.fields.map((field) => ({ key: field.key, type: field.type })) }
    },
    async replyForm(input) {
      calls.replyForm.push({ sessionID: input.sessionID, formID: input.formID, answer: input.answer })
      forms.set(
        input.sessionID,
        (forms.get(input.sessionID) ?? []).filter((form) => form.id !== input.formID),
      )
    },
    async cancelForm(input) {
      calls.cancelForm.push({
        sessionID: input.sessionID,
        formID: input.formID,
        ...(input.message !== undefined ? { message: input.message } : {}),
      })
      forms.set(
        input.sessionID,
        (forms.get(input.sessionID) ?? []).filter((form) => form.id !== input.formID),
      )
    },
    async projects() {
      return port.projectList
    },
    async createWorktree(input) {
      calls.createWorktree.push({ projectID: input.projectID, ...(input.name !== undefined ? { name: input.name } : {}) })
      return { directory: port.worktreeDirectory }
    },
    async removeWorktree(input) {
      calls.removeWorktree.push({
        projectID: input.projectID,
        directory: input.directory,
        force: input.force,
      })
    },
    subscribeEvents(handler) {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
  }
  return port
}

export const event = (seq: number, type: string, data: Record<string, unknown> = {}, created = Date.now()): DurableEvent => ({
  type,
  created,
  durable: { aggregateID: "session", seq, version: 1 },
  data,
})

export const permission = (id: string, action: string, resources: string[]): PermissionRequest => ({
  id,
  sessionID: "ses",
  action,
  resources,
})

export const form = (id: string, sessionID: string, fieldKeys = ["q0"]): FormInfo => ({
  id,
  sessionID,
  title: "Questions",
  fields: fieldKeys.map((key) => ({ key, type: "string" as const })) as unknown as FormInfo["fields"],
})
