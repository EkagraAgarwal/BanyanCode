import type { SessionInfo, SessionMessageAssistantTool, SessionMessageInfo } from "@opencode/client"
import { truncate } from "./format"
import { latestOutput, returnedSummary, toolArgs, toolHistory, totalTokens, type ToolCallStatus } from "./messages"
import type { MeshNode } from "./pending-rpc"

/**
 * Pure data for the Agents tab's Understory layout: the roster tree, the merged
 * stream log and the inspector sheets. Nothing here imports Solid or the
 * renderer, and no function reads the clock: callers pass `now` where elapsed
 * time for an open call is needed.
 *
 * The roster is built from `Session.Info` (parentID + createdAt), not from the
 * mesh tree, because `withoutKilled` drops killed agents and their subtrees
 * from `mesh.status` while `MeshStatus.killed` keeps the IDs. Mesh state is
 * still the authority for `running` / `retry` / `failed` / `interrupted`
 * whenever the node survives.
 */

export type UnderstoryState =
  | "idle"
  | "running"
  | "retry"
  | "waiting"
  | "blocked"
  | "done"
  | "failed"
  | "killed"

/** Glyphs for every state except `running`, whose frame the UI animates. */
export const STATE_GLYPH = {
  idle: "○",
  retry: "↻",
  waiting: "▲",
  blocked: "◉",
  done: "✓",
  failed: "✕",
  killed: "⊘",
} as const satisfies Record<Exclude<UnderstoryState, "running">, string>

export function stateGlyph(state: UnderstoryState, spinner: string): string {
  return state === "running" ? spinner : STATE_GLYPH[state]
}

/** A state whose agent has not come to rest: used for `blocked` detection. */
export function isLiveState(state: UnderstoryState): boolean {
  return state === "running" || state === "retry" || state === "waiting" || state === "blocked"
}

// ---------------------------------------------------------------------------
// Tool kinds
// ---------------------------------------------------------------------------

export type ToolLetter = "R" | "S" | "E" | "$" | "V" | "W" | "T" | "?"

/**
 * `bash` / `task` / `apply_patch` are the only aliases still seen live; the
 * same three mappings live in `packages/tui/src/util/tool-display.ts`, which
 * this package cannot import (it has no dependency on `@opencode/tui`). Keep
 * the two lists in sync.
 */
export function canonicalTool(name: string): string {
  if (name === "bash") return "shell"
  if (name === "task") return "subagent"
  if (name === "apply_patch") return "patch"
  return name
}

const TOOL_LETTERS: Readonly<Record<string, ToolLetter>> = {
  read: "R",
  read_file: "R",
  "read-filesystem": "R",
  "mcp-resource": "R",
  artifact: "R",
  grep: "S",
  glob: "S",
  list: "S",
  ls: "S",
  code_find: "S",
  structural_queries: "S",
  "structural-queries": "S",
  banyan_tool_search: "S",
  repository_query: "S",
  repository_explain: "S",
  repository_impact: "S",
  repository_trace: "S",
  repository_tests: "S",
  repository_symbols: "S",
  repository_relationships: "S",
  repository_ownership: "S",
  blast_radius: "S",
  preflight: "S",
  edit_plan: "S",
  safe_rename: "E",
  edit: "E",
  write: "E",
  patch: "E",
  multi_edit: "E",
  shell: "$",
  banyan_test: "V",
  banyan_typecheck: "V",
  banyan_lint: "V",
  banyan_compile: "V",
  webfetch: "W",
  websearch: "W",
  subagent: "T",
}

/**
 * The single letter a tool block carries. Unclassified tools (todowrite,
 * skill, question, codegraph_build, ...) get `?`; they are never `T`, so a
 * task block is only ever a real subagent spawn.
 */
export function toolKind(name: string): ToolLetter {
  const canonical = canonicalTool(name)
  const letter = TOOL_LETTERS[canonical]
  if (letter !== undefined) return letter
  if (canonical.startsWith("repository_")) return "S"
  if (canonical.startsWith("codegraph_")) return "S"
  if (canonical.startsWith("banyan_")) return "V"
  return "?"
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

export interface RosterRow {
  readonly sessionID: string
  readonly depth: number
  readonly parentID?: string
  /** The agent name without a display suffix. */
  readonly agent: string
  /** Display label: `coder-1`, `coder-2`, or the plain name when it is unique. */
  readonly label: string
  readonly title?: string
  readonly state: UnderstoryState
  readonly pending: number
  readonly tokens: number
  readonly cost: number
  readonly model?: string
  /** The thinking variant the model was started with, when one was chosen. */
  readonly variant?: string
  readonly startedAt: number
  readonly endedAt?: number
  /** The host keeps only the newest messages of a synced child (see `HOST_MESSAGE_CAP`). */
  readonly historyMayBeTruncated: boolean
  readonly hasChildren: boolean
}

export interface RosterInput {
  readonly root: string
  readonly sessions: readonly SessionInfo[]
  /** Mesh root for the same session, when one has been fetched. */
  readonly mesh?: MeshNode | undefined
  readonly killed?: ReadonlySet<string> | undefined
  /** Pending permissions plus questions for exactly that session. */
  readonly pending?: ((sessionID: string) => number) | undefined
  /** `context.data.session.status`, for sessions the mesh has not reported yet. */
  readonly status?: ((sessionID: string) => "running" | "idle") | undefined
  /** Loaded messages, needed only to derive `blocked`. */
  readonly messages?: ((sessionID: string) => readonly SessionMessageInfo[]) | undefined
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>()

const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

const byCreated = (left: SessionInfo, right: SessionInfo): number =>
  left.time.created - right.time.created || compare(left.id, right.id)

function agentName(session: SessionInfo): string {
  return session.agent ?? "agent"
}

/** The model id the frames show, without the provider prefix. */
function modelLabel(session: SessionInfo): string | undefined {
  const id = session.model?.id
  if (id === undefined || id === "") return undefined
  return id.split("/").at(-1) ?? id
}

function indexMesh(root: MeshNode | undefined): ReadonlyMap<string, MeshNode> {
  const nodes = new Map<string, MeshNode>()
  const visit = (node: MeshNode) => {
    nodes.set(node.sessionID, node)
    for (const child of node.children) visit(child)
  }
  if (root !== undefined) visit(root)
  return nodes
}

const isCompletedAssistant = (message: SessionMessageInfo): boolean =>
  message.type === "assistant" && message.time.completed !== undefined

/** An open (streaming or running) `subagent` tool part. */
function openSubagent(messages: readonly SessionMessageInfo[]): boolean {
  return messages.some(
    (message) =>
      message.type === "assistant" &&
      message.content.some(
        (part) =>
          part.type === "tool" &&
          canonicalTool(part.name) === "subagent" &&
          (part.state.status === "streaming" || part.state.status === "running"),
      ),
  )
}

/**
 * The host keeps only the newest `HOST_MESSAGE_CAP` messages per synced child.
 * A child at the cap, or one whose first loaded message is not a user prompt,
 * may therefore have earlier activity that is not loaded. The root session is
 * not capped.
 */
export const HOST_MESSAGE_CAP = 20

export function mayBeTruncated(
  messages: readonly SessionMessageInfo[],
  options: { readonly root?: boolean } = {},
): boolean {
  if (options.root === true) return false
  if (messages.length >= HOST_MESSAGE_CAP) return true
  const first = messages[0]
  return first !== undefined && first.type !== "user"
}

function understoryState(input: {
  readonly session: SessionInfo
  readonly root: boolean
  readonly node: MeshNode | undefined
  readonly killed: boolean
  readonly pending: number
  readonly running: boolean
  readonly messages: readonly SessionMessageInfo[]
}): UnderstoryState {
  // `interrupted` is not `killed`: Esc in a child also produces it, so only
  // the durable kill list earns the killed state. A non-killed interruption
  // stays `failed`, which is what the existing `childState` shows.
  const failed =
    input.node?.state === "failed" ||
    input.node?.state === "interrupted" ||
    (!input.running && (input.session.outcome === "failed" || input.session.outcome === "interrupted"))
  if (input.killed) return "killed"
  if (failed) return "failed"
  if (input.pending > 0) return "waiting"
  if (input.node?.state === "retry") return "retry"
  if (input.running) return "running"
  // The root is always available to the user; an idle root is not finished.
  if (input.root) return "idle"
  if (input.session.time.idle !== undefined) return "done"
  return input.messages.some(isCompletedAssistant) ? "done" : "idle"
}

/**
 * The root plus every descendant, depth-first in stable tree order (children
 * by `createdAt`). Killed agents stay in their position, with their subtrees:
 * `sessions` still contains them even though `mesh.status` does not.
 */
export function rosterRows(input: RosterInput): RosterRow[] {
  const byID = new Map(input.sessions.map((session) => [session.id, session]))
  const childrenOfSession = new Map<string, SessionInfo[]>()
  for (const session of input.sessions) {
    if (session.parentID === undefined) continue
    const list = childrenOfSession.get(session.parentID)
    if (list === undefined) childrenOfSession.set(session.parentID, [session])
    else list.push(session)
  }
  for (const list of childrenOfSession.values()) list.sort(byCreated)

  const ordered: Array<{ session: SessionInfo; depth: number; parentID?: string }> = []
  const seen = new Set<string>()
  const walk = (id: string, depth: number, parentID: string | undefined) => {
    if (seen.has(id)) return
    const session = byID.get(id)
    if (session === undefined) return
    seen.add(id)
    ordered.push({ session, depth, ...(parentID === undefined ? {} : { parentID }) })
    for (const child of childrenOfSession.get(id) ?? []) walk(child.id, depth + 1, id)
  }
  walk(input.root, 0, undefined)
  if (ordered.length === 0) return []

  const nodes = indexMesh(input.mesh)
  const killed = input.killed ?? EMPTY_SET
  const messagesOf = input.messages ?? (() => [])
  const pendingOf = input.pending ?? (() => 0)
  const stateOf = new Map<string, UnderstoryState>()

  for (const entry of ordered) {
    const node = nodes.get(entry.session.id)
    const session = entry.session
    const running = node?.state === "running" || input.status?.(session.id) === "running"
    stateOf.set(
      session.id,
      understoryState({
        session,
        root: entry.depth === 0,
        node,
        killed: killed.has(session.id),
        pending: pendingOf(session.id),
        running,
        messages: messagesOf(session.id),
      }),
    )
  }

  const rowChildren = new Map<string, string[]>()
  for (const entry of ordered) {
    if (entry.parentID === undefined) continue
    const list = rowChildren.get(entry.parentID)
    if (list === undefined) rowChildren.set(entry.parentID, [entry.session.id])
    else list.push(entry.session.id)
  }

  const live = new Map<string, boolean>()
  const hasLiveDescendant = (sessionID: string): boolean => {
    const cached = live.get(sessionID)
    if (cached !== undefined) return cached
    const result = (rowChildren.get(sessionID) ?? []).some(
      (child) => isLiveState(stateOf.get(child)!) || hasLiveDescendant(child),
    )
    live.set(sessionID, result)
    return result
  }

  // `blocked` needs real evidence: the parent is running inside a `subagent`
  // call and something below it is still live. Without both, a running agent
  // stays `running`; an idle one stays `idle`/`done` rather than guessed.
  for (const entry of ordered) {
    const sessionID = entry.session.id
    if (stateOf.get(sessionID) !== "running") continue
    if (!hasLiveDescendant(sessionID)) continue
    if (!openSubagent(messagesOf(sessionID))) continue
    stateOf.set(sessionID, "blocked")
  }

  // Display labels: same-named agents are numbered by spawn order; a lone one
  // keeps its plain name. The suffix is display-only; selection uses the ID.
  const labelOf = new Map<string, string>()
  const groups = new Map<string, Array<{ id: string; index: number; created: number }>>()
  ordered.forEach((entry, index) => {
    if (entry.depth === 0) {
      labelOf.set(entry.session.id, agentName(entry.session))
      return
    }
    const name = agentName(entry.session)
    const list = groups.get(name)
    const item = { id: entry.session.id, index, created: entry.session.time.created }
    if (list === undefined) groups.set(name, [item])
    else list.push(item)
  })
  for (const [name, list] of groups) {
    if (list.length === 1) {
      labelOf.set(list[0]!.id, name)
      continue
    }
    list.sort((left, right) => left.created - right.created || left.index - right.index)
    list.forEach((item, index) => labelOf.set(item.id, `${name}-${index + 1}`))
  }

  return ordered.map((entry) => {
    const session = entry.session
    const state = stateOf.get(session.id)!
    const root = entry.depth === 0
    const model = modelLabel(session)
    const variant = session.model?.variant
    // The root has no `done` state; its last turn is over when `time.idle`
    // arrives after the turn's `busy` mark. That final duration is what RUN
    // shows once the run stops.
    const rootEnded =
      root && session.time.idle !== undefined && session.time.idle >= (session.time.busy ?? session.time.created)
    const stopped = state === "failed" || state === "killed" || state === "done" || rootEnded
    const endedAt = stopped ? (session.time.idle ?? session.time.updated) : undefined
    return {
      sessionID: session.id,
      depth: entry.depth,
      ...(entry.parentID === undefined ? {} : { parentID: entry.parentID }),
      agent: agentName(session),
      label: labelOf.get(session.id) ?? agentName(session),
      ...(session.title === undefined ? {} : { title: session.title }),
      state,
      pending: pendingOf(session.id),
      tokens: totalTokens(session.tokens),
      cost: session.cost ?? 0,
      ...(model === undefined ? {} : { model }),
      ...(variant === undefined ? {} : { variant }),
      startedAt: session.time.busy ?? session.time.created,
      ...(endedAt === undefined ? {} : { endedAt }),
      historyMayBeTruncated: mayBeTruncated(messagesOf(session.id), { root }),
      hasChildren: (rowChildren.get(session.id) ?? []).length > 0,
    }
  })
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/**
 * Shorten a label for a narrow roster while keeping its number, so
 * `explore-1` and `explore-2` stay distinct at every width (`exp…-1`).
 */
export function shortLabel(label: string, width: number): string {
  if (width <= 0) return ""
  if (label.length <= width) return label
  const numbered = label.match(/^(.*)-(\d+)$/)
  if (numbered === null) return truncate(label, width)
  const base = numbered[1]!
  const suffix = `-${numbered[2]}`
  if (suffix.length >= width) return truncate(label, width)
  return `${truncate(base, width - suffix.length)}${suffix}`
}

// ---------------------------------------------------------------------------
// Attention and folding
// ---------------------------------------------------------------------------

/**
 * The next agent that needs the user: waiting first, then failed, in tree
 * position. Selection is an ID, so a row that stops waiting does not shift the
 * cycle onto someone else; the next press continues after its position.
 */
export function nextAttention(rows: readonly RosterRow[], currentID: string | undefined): string | undefined {
  const attention = rows.filter((row) => row.state === "waiting" || row.state === "failed")
  if (attention.length === 0) return undefined
  const position = new Map(rows.map((row, index) => [row.sessionID, index]))
  const current = currentID === undefined ? undefined : position.get(currentID)
  if (current === undefined) return attention[0]!.sessionID
  const next = attention.find((row) => position.get(row.sessionID)! > current)
  return (next ?? attention[0]!).sessionID
}

export interface FoldResult {
  readonly rows: readonly RosterRow[]
  readonly hidden: number
  readonly selected: string | undefined
  readonly replaced: boolean
}

/**
 * Fold finished (`done`) rows, keeping failed and killed ones visible. A done
 * row with a visible descendant stays visible so the tree never loses its
 * parent. When the selection is hidden, `selected` is the next visible row by
 * tree position (or the previous one when nothing follows).
 */
export function visibleRows(
  rows: readonly RosterRow[],
  options: { readonly folded: boolean; readonly selected?: string | undefined },
): FoldResult {
  const selected = options.selected
  if (!options.folded) return { rows, hidden: 0, selected, replaced: false }

  const byID = new Map(rows.map((row) => [row.sessionID, row]))
  const children = new Map<string, string[]>()
  for (const row of rows) {
    if (row.parentID === undefined) continue
    const list = children.get(row.parentID)
    if (list === undefined) children.set(row.parentID, [row.sessionID])
    else list.push(row.sessionID)
  }

  const visible = new Map<string, boolean>()
  const hasVisibleDescendant = (sessionID: string): boolean => {
    const cached = visible.get(sessionID)
    if (cached !== undefined) return cached
    const result = (children.get(sessionID) ?? []).some((child) => {
      const row = byID.get(child)
      if (row === undefined) return true
      return row.state !== "done" || hasVisibleDescendant(child)
    })
    visible.set(sessionID, result)
    return result
  }

  const kept = rows.filter((row) => row.state !== "done" || hasVisibleDescendant(row.sessionID))
  const hidden = rows.length - kept.length
  if (selected === undefined) return { rows: kept, hidden, selected: undefined, replaced: false }
  if (kept.some((row) => row.sessionID === selected)) return { rows: kept, hidden, selected, replaced: false }

  const position = new Map(rows.map((row, index) => [row.sessionID, index]))
  const index = position.get(selected)
  if (index === undefined) return { rows: kept, hidden, selected: undefined, replaced: false }
  const next =
    kept.find((row) => position.get(row.sessionID)! > index) ??
    [...kept].reverse().find((row) => position.get(row.sessionID)! < index)
  return { rows: kept, hidden, selected: next?.sessionID, replaced: true }
}

// ---------------------------------------------------------------------------
// Stream
// ---------------------------------------------------------------------------

export type StreamKind = "tool" | "text" | "think" | "spawn" | "return" | "fail" | "kill" | "user"

export interface StreamDetail {
  readonly tool: string
  readonly letter: ToolLetter
  readonly target: string
  /** Present once a call has ended, or for an open one when `now` was given. */
  readonly durationMs?: number
  readonly open: boolean
  readonly error: boolean
  /** `state.metadata.files` additions, when the tool records a diff. */
  readonly added?: number
  readonly removed?: number
  readonly message?: string
}

export interface StreamEntry {
  readonly id: string
  readonly at: number
  readonly sessionID: string
  readonly label: string
  readonly kind: StreamKind
  readonly summary: string
  /** `fail` / `kill` times are inferred, not reported by the server. */
  readonly approximate: boolean
  readonly detail?: StreamDetail
}

/** Newest entries kept per session; older ones are dropped, not paged. */
export const STREAM_CAP_PER_SESSION = 500

export interface StreamSession {
  readonly sessionID: string
  readonly label: string
  readonly state: UnderstoryState
  readonly messages: readonly SessionMessageInfo[]
  /** When the run stopped, for synthesised `fail` / `kill` rows. */
  readonly endedAt?: number
  /** The child's last words, for a `return` row. */
  readonly returned?: string
}

export interface StreamOptions {
  /** Session ID or display label; keeps one agent's entries. */
  readonly agent?: string | undefined
  /** Clock for an open call's duration. Omit to leave it open. */
  readonly now?: number | undefined
  readonly limit?: number | undefined
}

const clip = (value: string, max: number): string => truncate(value.replace(/\s+/g, " ").trim(), max)

const baseDetail = (tool: string, target: string): StreamDetail => ({
  tool,
  letter: toolKind(tool),
  target,
  open: false,
  error: false,
})

function inputString(input: unknown, key: string): string | undefined {
  if (typeof input !== "object" || input === null) return undefined
  const value = (input as Record<string, unknown>)[key]
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

function metadataString(state: SessionMessageAssistantTool["state"], key: string): string | undefined {
  if (state.status === "streaming") return undefined
  const metadata = state.metadata
  if (typeof metadata !== "object" || metadata === null) return undefined
  const value = (metadata as Record<string, unknown>)[key]
  return typeof value === "string" ? value : undefined
}

/** `+add -del` from `state.metadata.files`, which edit and patch both write. */
export function diffCounts(state: SessionMessageAssistantTool["state"]): { added: number; removed: number } | undefined {
  if (state.status === "streaming") return undefined
  const metadata = state.metadata
  if (typeof metadata !== "object" || metadata === null) return undefined
  const files = (metadata as Record<string, unknown>).files
  if (!Array.isArray(files)) return undefined
  let added = 0
  let removed = 0
  let seen = false
  for (const file of files) {
    if (typeof file !== "object" || file === null) continue
    const record = file as Record<string, unknown>
    if (typeof record.additions === "number") {
      added += record.additions
      seen = true
    }
    if (typeof record.deletions === "number") {
      removed += record.deletions
      seen = true
    }
  }
  return seen ? { added, removed } : undefined
}

interface OrderedEntry {
  readonly at: number
  /** Deterministic tie-break: session, message, part, sub-event. */
  readonly tie: readonly [number, number, number, number]
  readonly entry: StreamEntry
}

const compareOrdered = (left: OrderedEntry, right: OrderedEntry): number =>
  left.at - right.at ||
  left.tie[0] - right.tie[0] ||
  left.tie[1] - right.tie[1] ||
  left.tie[2] - right.tie[2] ||
  left.tie[3] - right.tie[3]

/**
 * Merge every session's messages into one time-ordered log. Ties break by
 * session position, message index, part index and sub-event, so the order is
 * stable and independent of input sorting.
 */
export function streamEntries(sessions: readonly StreamSession[], options: StreamOptions = {}): StreamEntry[] {
  const limit = options.limit === undefined ? STREAM_CAP_PER_SESSION : Math.max(1, Math.floor(options.limit))
  const byID = new Map(sessions.map((session) => [session.sessionID, session]))
  const wanted = (session: StreamSession) =>
    options.agent === undefined || session.sessionID === options.agent || session.label === options.agent
  const out: OrderedEntry[] = []

  sessions.filter(wanted).forEach((session, sessionIndex) => {
    const local: OrderedEntry[] = []
    let sequence = 0
    const push = (
      at: number,
      messageIndex: number,
      partIndex: number,
      sub: number,
      entry: Omit<StreamEntry, "id">,
    ) => {
      local.push({
        at,
        tie: [sessionIndex, messageIndex, partIndex, sub],
        entry: { id: `${session.sessionID}:${sequence++}`, ...entry },
      })
    }
    const base = { sessionID: session.sessionID, label: session.label, approximate: false }

    session.messages.forEach((message, messageIndex) => {
      if (message.type === "user") {
        const summary = clip(message.text, 120)
        if (summary !== "") {
          push(message.time.created, messageIndex, 0, 0, { ...base, at: message.time.created, kind: "user", summary })
        }
        return
      }
      if (message.type !== "assistant") return

      message.content.forEach((part, partIndex) => {
        if (part.type === "text" || part.type === "reasoning") {
          const summary = clip(part.text, 120)
          if (summary === "") return
          push(message.time.created, messageIndex, partIndex, 0, {
            ...base,
            at: message.time.created,
            kind: part.type === "text" ? "text" : "think",
            summary,
          })
          return
        }
        if (part.type !== "tool") return

        const canonical = canonicalTool(part.name)
        const start = part.time.ran ?? part.time.created
        const completed = part.time.completed
        const open = part.state.status === "streaming" || part.state.status === "running"
        const error = part.state.status === "error"
        const errorMessage = part.state.status === "error" ? part.state.error.message : undefined
        const durationMs = open
          ? options.now === undefined
            ? undefined
            : Math.max(0, options.now - start)
          : completed === undefined
            ? undefined
            : Math.max(0, completed - start)
        const counts = diffCounts(part.state)
        const target = toolArgs(part.state.input, 60)
        const detail: StreamDetail = {
          ...baseDetail(part.name, target),
          open,
          error,
          ...(durationMs === undefined ? {} : { durationMs }),
          ...(counts === undefined ? {} : { added: counts.added, removed: counts.removed }),
          ...(errorMessage === undefined ? {} : { message: errorMessage }),
        }

        if (canonical !== "subagent") {
          push(start, messageIndex, partIndex, 0, {
            ...base,
            at: start,
            kind: "tool",
            summary: clip(`${part.name}${target === "" ? "" : ` ${target}`}`, 120),
            detail,
          })
          return
        }

        // A spawn is the subagent call starting; its return is the same call
        // completing. A failed subagent call is a `fail`, not a `return`.
        const childID = metadataString(part.state, "sessionID")
        const child = childID === undefined ? undefined : byID.get(childID)
        const spawnName = child?.label ?? inputString(part.state.input, "agent") ?? "subagent"
        const description = toolArgs(part.state.input, 60)
        push(start, messageIndex, partIndex, 0, {
          ...base,
          at: start,
          kind: "spawn",
          summary: clip(`${spawnName}${description === "" ? "" : ` · ${description}`}`, 120),
          detail,
        })
        if (part.state.status === "completed" && completed !== undefined) {
          push(completed, messageIndex, partIndex, 1, {
            ...base,
            at: completed,
            kind: "return",
            summary: clip(child?.returned ?? `${spawnName} returned`, 120),
            detail,
          })
        }
        if (error) {
          push(completed ?? options.now ?? start, messageIndex, partIndex, 1, {
            ...base,
            at: completed ?? options.now ?? start,
            kind: "fail",
            summary: clip(`${spawnName} failed: ${errorMessage ?? "unknown error"}`, 120),
            detail,
          })
        }
      })
    })

    const lastAt = session.messages.reduce((max, message) => Math.max(max, message.time.created), 0)
    const stoppedAt = session.endedAt ?? (lastAt > 0 ? lastAt : undefined)
    if (stoppedAt !== undefined) {
      if (session.state === "killed") {
        push(stoppedAt, session.messages.length, 0, 0, {
          ...base,
          at: stoppedAt,
          kind: "kill",
          summary: `${session.label} killed`,
          approximate: true,
        })
      }
      if (session.state === "failed") {
        push(stoppedAt, session.messages.length, 0, 1, {
          ...base,
          at: stoppedAt,
          kind: "fail",
          summary: `${session.label} failed`,
          approximate: session.endedAt === undefined,
        })
      }
    }

    local.sort(compareOrdered)
    out.push(...local.slice(-limit))
  })

  return out.sort(compareOrdered).map((item) => item.entry)
}

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------

export interface InspectorInput {
  readonly rows: readonly RosterRow[]
  readonly root: string
  readonly selected?: string | undefined
  readonly messages: (sessionID: string) => readonly SessionMessageInfo[]
}

const costField = (cost: number): { readonly cost?: number } => (cost === 0 ? {} : { cost })

export interface RunBranch {
  readonly sessionID: string
  readonly label: string
  readonly agent: string
  readonly depth: number
  readonly state: UnderstoryState
  readonly tokens: number
  readonly cost?: number
  readonly returned?: string
  readonly historyMayBeTruncated: boolean
}

export interface RunSheet {
  readonly rootSessionID: string
  readonly label: string
  readonly agent: string
  readonly state: UnderstoryState
  readonly tokens: number
  readonly cost?: number
  readonly branches: readonly RunBranch[]
  /** Session IDs whose earlier activity may not be loaded. */
  readonly truncated: readonly string[]
}

/** The root's run sheet: every branch under it with tokens and its last words. */
export function runSheet(input: InspectorInput): RunSheet | undefined {
  const root = input.rows.find((row) => row.sessionID === input.root)
  if (root === undefined) return undefined
  if ((input.selected ?? input.root) !== input.root) return undefined
  const branches = input.rows
    .filter((row) => row.depth > 0)
    .map((row): RunBranch => {
      // Only a finished branch has a return. A running branch has not returned
      // yet, and a failed one's last words are not a successful return, so its
      // summary is omitted rather than mislabelled.
      const returned = row.state === "done" ? returnedSummary(input.messages(row.sessionID), 120) : undefined
      return {
        sessionID: row.sessionID,
        label: row.label,
        agent: row.agent,
        depth: row.depth,
        state: row.state,
        tokens: row.tokens,
        ...costField(row.cost),
        ...(returned === undefined ? {} : { returned }),
        historyMayBeTruncated: row.historyMayBeTruncated,
      }
    })
  return {
    rootSessionID: root.sessionID,
    label: root.label,
    agent: root.agent,
    state: root.state,
    tokens: root.tokens,
    ...costField(root.cost),
    branches,
    truncated: branches.filter((branch) => branch.historyMayBeTruncated).map((branch) => branch.sessionID),
  }
}

export interface AgentSheetTool {
  readonly name: string
  readonly letter: ToolLetter
  readonly target: string
  readonly status: ToolCallStatus
  readonly at: number
  readonly durationMs?: number
  readonly error: boolean
}

export interface EditedFile {
  readonly path: string
  readonly added?: number
  readonly removed?: number
}

export interface AgentSheet {
  readonly sessionID: string
  readonly label: string
  readonly agent: string
  readonly title?: string
  readonly state: UnderstoryState
  readonly model?: string
  readonly pending: number
  readonly output: readonly string[]
  /** Newest first, capped at 8. */
  readonly tools: readonly AgentSheetTool[]
  /** Most recently edited first. */
  readonly files: readonly EditedFile[]
  readonly tokens: number
  readonly cost?: number
  readonly historyMayBeTruncated: boolean
}

const EDIT_TOOLS = new Set(["edit", "write", "patch", "safe_rename"])

/** The file a tool call names, from the keys read, search and edit calls use. */
export function toolPath(input: unknown): string | undefined {
  if (typeof input === "string") return input.trim() === "" ? undefined : input.trim()
  if (typeof input !== "object" || input === null) return undefined
  const record = input as Record<string, unknown>
  for (const key of ["filePath", "file_path", "path", "file"]) {
    const value = record[key]
    if (typeof value === "string" && value.trim() !== "") return value
  }
  return undefined
}

function metadataFiles(state: SessionMessageAssistantTool["state"]): EditedFile[] {
  if (state.status === "streaming") return []
  const metadata = state.metadata
  if (typeof metadata !== "object" || metadata === null) return []
  const files = (metadata as Record<string, unknown>).files
  if (!Array.isArray(files)) return []
  return files.flatMap((file) => {
    if (typeof file !== "object" || file === null) return []
    const record = file as Record<string, unknown>
    const path = typeof record.file === "string" ? record.file : record.relativePath
    if (typeof path !== "string" || path === "") return []
    return [
      {
        path,
        ...(typeof record.additions === "number" ? { added: record.additions } : {}),
        ...(typeof record.deletions === "number" ? { removed: record.deletions } : {}),
      },
    ]
  })
}

function editedFiles(messages: readonly SessionMessageInfo[]): EditedFile[] {
  const files = new Map<string, EditedFile>()
  for (const message of messages) {
    if (message.type !== "assistant") continue
    for (const part of message.content) {
      if (part.type !== "tool" || !EDIT_TOOLS.has(canonicalTool(part.name))) continue
      const touched = metadataFiles(part.state)
      if (touched.length === 0) {
        const path = toolPath(part.state.input)
        if (path === undefined) continue
        files.delete(path)
        files.set(path, { path })
        continue
      }
      for (const file of touched) {
        files.delete(file.path)
        files.set(file.path, file)
      }
    }
  }
  return [...files.values()].reverse()
}

/** One agent's sheet, from its own messages and its roster row. */
export function agentSheet(input: InspectorInput): AgentSheet | undefined {
  if (input.selected === undefined) return undefined
  const row = input.rows.find((item) => item.sessionID === input.selected)
  if (row === undefined) return undefined
  const messages = input.messages(row.sessionID)
  const tools = toolHistory(messages)
    .slice(-8)
    .reverse()
    .map(
      (call): AgentSheetTool => ({
        name: call.name,
        letter: toolKind(call.name),
        target: call.args,
        status: call.status,
        at: call.createdAt,
        ...(call.completedAt === undefined ? {} : { durationMs: Math.max(0, call.completedAt - call.createdAt) }),
        error: call.status === "error",
      }),
    )
  return {
    sessionID: row.sessionID,
    label: row.label,
    agent: row.agent,
    ...(row.title === undefined ? {} : { title: row.title }),
    state: row.state,
    ...(row.model === undefined ? {} : { model: row.model }),
    pending: row.pending,
    output: latestOutput(messages, 6),
    tools,
    files: editedFiles(messages),
    tokens: row.tokens,
    ...costField(row.cost),
    historyMayBeTruncated: row.historyMayBeTruncated,
  }
}
