/**
 * Real-shaped session data for the perf benches: N agents, M messages each.
 *
 * Manual tool, not part of `bun test`. Run from `packages/banyancode-tui`:
 *   bun perf-bench/bench-pure.ts [agents] [messages] [columns]
 *   bun perf-bench/bench-render.tsx [agents] [messages] [cols] [rows]
 */
import type { SessionInfo, SessionMessageInfo } from "@opencode/client"

export interface AgentSpec {
  readonly id: string
  readonly agent: string
  readonly messages: number
  readonly live: boolean
  readonly created: number
  readonly toolsPerMessage: number
}

export function agents(count: number, messagesEach: number, options: { readonly live?: number } = {}): AgentSpec[] {
  const live = options.live ?? 0
  return Array.from({ length: count }, (_, index) => ({
    id: `ses_${index}`,
    agent: index % 2 === 0 ? "coder" : "explore",
    messages: messagesEach,
    live: index < live,
    created: 1_700_000_000_000 + index * 1_000,
    toolsPerMessage: 1,
  }))
}

const TOOLS = ["read", "edit", "bash", "grep", "code_find", "webfetch"]
const FILES = ["packages/tui/src/app.tsx", "packages/core/src/session.ts", "packages/banyancode-tui/src/components/understory/index.tsx"]

/** One message per call, real part shapes: user prompts, assistant text/tool/reasoning. */
export function message(sessionID: string, index: number, at: number, tools: number, open: boolean): SessionMessageInfo {
  if (index % 4 === 0) {
    return { id: `${sessionID}_u${index}`, type: "user", time: { created: at }, text: `do step ${index}` } as unknown as SessionMessageInfo
  }
  const content: unknown[] = [{ type: "text", text: `working on step ${index} of the task`, time: { created: at } }]
  content.push({ type: "reasoning", text: "checking the file before editing", time: { created: at, completed: at + 300 } })
  for (let tool = 0; tool < tools; tool += 1) {
    const name = TOOLS[(index + tool) % TOOLS.length]!
    const path = FILES[(index + tool) % FILES.length]!
    const running = open && tool === tools - 1
    content.push({
      type: "tool",
      id: `${sessionID}_t${index}_${tool}`,
      name,
      state: running
        ? { status: "running", input: { filePath: path, command: "bun typecheck" }, metadata: {} }
        : {
            status: "completed",
            input: { filePath: path, command: "bun typecheck" },
            output: "",
            content: [{ type: "text", text: "ok" }],
            metadata: { files: [{ file: path, additions: 8, deletions: 2 }] },
          },
      time: { created: at + 100, ...(running ? {} : { completed: at + 900 }) },
    })
  }
  return {
    id: `${sessionID}_a${index}`,
    type: "assistant",
    time: { created: at, ...(open && index >= 0 ? {} : { completed: at + 1_000 }), streamed: at },
    agent: "coder",
    model: { providerID: "opencode", id: "deepseek-v4.1-flash-free" },
    content,
    tokens: { input: 900, output: 220, reasoning: 60, cache: { read: 0, write: 0 } },
  } as unknown as SessionMessageInfo
}

export function sessionInfo(spec: AgentSpec): SessionInfo {
  return {
    id: spec.id,
    projectID: "prj_perf",
    parentID: "ses_root",
    agent: spec.agent,
    title: `task ${spec.id}`,
    cost: 0.02,
    tokens: { input: 120_000, output: 30_000, reasoning: 4_000, cache: { read: 0, write: 0 } },
    time: { created: spec.created, updated: spec.created + spec.messages * 1_000, ...(spec.live ? {} : { idle: spec.created + spec.messages * 1_000 }) },
  } as unknown as SessionInfo
}

export function rootSession(): SessionInfo {
  return {
    id: "ses_root",
    projectID: "prj_perf",
    agent: "build",
    title: "orchestrate",
    cost: 0.1,
    tokens: { input: 200_000, output: 10_000, reasoning: 1_000, cache: { read: 0, write: 0 } },
    time: { created: 1_700_000_000_000, updated: 1_700_000_400_000, busy: 1_700_000_000_000 },
  } as unknown as SessionInfo
}
