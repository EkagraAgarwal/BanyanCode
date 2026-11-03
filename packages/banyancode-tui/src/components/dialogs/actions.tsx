import type { AgentInfo, ModelInfo } from "@opencode/client"
import type { Context } from "@opencode/plugin/tui/context"
import type { Live, MeshLive } from "../../data/live"
import { canSteer } from "../../data/mesh"
import type { BanyanConfig, MeshNode } from "../../data/pending-rpc"

const MAX_SUBAGENTS = 20
const DEFAULT_MAX_SUBAGENTS = 5

type Notify = (message: string, variant?: "info" | "success" | "warning" | "error") => void

function notifier(context: Context): Notify {
  return (message, variant = "info") => context.ui.toast.show({ message, variant })
}

function report(
  notify: Notify,
  result: { readonly ok: boolean; readonly message?: string },
  success: string,
) {
  if (result.ok) notify(success, "success")
  else notify(result.message ?? "BanyanCode RPC is not available on this server", "warning")
}

function parseModel(value: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!value) return undefined
  const index = value.indexOf("/")
  if (index <= 0) return undefined
  return { providerID: value.slice(0, index), modelID: value.slice(index + 1) }
}

function overrideModel(config: BanyanConfig | undefined, name: string) {
  const raw = config?.agent?.[name]?.model
  return parseModel(raw)
}

function agentModel(agent: AgentInfo) {
  if (!agent.model) return undefined
  return { providerID: agent.model.providerID, modelID: agent.model.id }
}

function rootSessionID(context: Context): string | undefined {
  const route = context.ui.router.current()
  if (route.type === "session") return context.data.session.root(route.sessionID)
  return context.data.session.list().find((session) => !session.parentID)?.id
}

function flatten(nodes: readonly MeshNode[], out: MeshNode[] = []): MeshNode[] {
  for (const node of nodes) {
    out.push(node)
    flatten(node.children, out)
  }
  return out
}

/** A dialog row built from the session list, so killed children stay visible as finished. */
export interface AgentTarget {
  readonly sessionID: string
  readonly agent?: string
  readonly title?: string
  readonly state: MeshNode["state"]
  readonly killed: boolean
}

function subagentLabel(node: AgentTarget): string {
  const name = node.agent ?? node.title ?? node.sessionID
  return `${name} · ${node.killed ? "killed" : node.state}`
}

/**
 * v1 `agent.model` / `/agent-model`: pick the orchestrator or a subagent, then
 * its model. Hydration is lazy: the command syncs the current location's agent
 * and model catalogs only when the user opens it.
 */
export async function openAgentModel(context: Context, live: Live): Promise<void> {
  const notify = notifier(context)
  const location = context.location
  if (location) {
    await Promise.all([
      context.data.location.agent.sync(location),
      context.data.location.model.sync(location),
    ])
  }
  const agents = (context.data.location.agent.list(location) ?? []).filter((agent) => !agent.hidden)
  if (agents.length === 0) {
    notify("No agents are available yet", "warning")
    return
  }
  const agentName = await context.ui.dialog.select<string>({
    title: "Pick model for orchestrator or subagent",
    placeholder: "Select an agent",
    options: agents.map((agent) => ({
      title: agent.name,
      description: agent.mode,
      value: agent.name,
    })),
  })
  if (agentName === undefined) return
  const agent = agents.find((item) => item.name === agentName)
  if (!agent) return

  const models = context.data.location.model.list(location) ?? []
  if (models.length === 0) {
    notify("No models are available yet", "warning")
    return
  }
  const current = overrideModel(live.core.config(), agent.name) ?? agentModel(agent)
  const key = current ? `${current.providerID}/${current.modelID}` : undefined
  const selected = await context.ui.dialog.select<string>({
    title: `Model for ${agent.name}`,
    current: key,
    placeholder: "Select a model",
    options: models.map((model: ModelInfo) => ({
      title: `${model.providerID}/${model.modelID}`,
      description: model.name,
      value: `${model.providerID}/${model.modelID}`,
    })),
  })
  if (selected === undefined) return
  const model = parseModel(selected)
  if (!model) return
  report(notify, await live.system.agentOverride({ name: agent.name, model }), `Saved ${agent.name} model`)
}

/**
 * v1 `subagents.max_subagents`: a 1-20 dialog backed by
 * `banyancode.mesh limits.set` (the server validates the same range).
 */
export async function openMaxSubagents(context: Context, live: Live): Promise<void> {
  const notify = notifier(context)
  let limits = live.mesh.limits()
  if (limits === undefined) {
    await live.mesh.refreshLimits()
    limits = live.mesh.limits()
  }
  const current = limits?.maxSubagents ?? limits?.maxSubagentsDefault ?? DEFAULT_MAX_SUBAGENTS
  const limit = Math.min(limits?.maxSubagentsLimit ?? MAX_SUBAGENTS, MAX_SUBAGENTS)
  const raw = await context.ui.dialog.prompt({
    title: `Set max concurrent subagents (1-${limit})`,
    description: `Enter a whole number from 1 to ${limit}. Now ${current}.`,
  })
  if (raw === undefined) return
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > limit) {
    notify(`Max subagents must be an integer between 1 and ${limit}; got "${raw}".`, "error")
    return
  }
  const result = await live.mesh.setLimits({ maxSubagents: value })
  report(notify, result, `Max subagents set to ${value}`)
}

/**
 * v1 `agent.tree` / `/agent-tree`: the agent-control dialog with steer and kill.
 */
export async function openAgentControl(context: Context, live: Live): Promise<void> {
  const notify = notifier(context)
  const root = rootSessionID(context)
  if (!root) {
    notify("No session is active; open a session to control its subagents", "warning")
    return
  }
  await Promise.all([live.mesh.ensure(root), live.mesh.refreshLimits()])
  const killed = live.mesh.killed()
  const tree = live.mesh.root(root)
  const meshByID = new Map((tree ? flatten(tree.children) : []).map((node) => [node.sessionID, node]))
  const nodes: AgentTarget[] = context.data.session
    .family(root)
    .filter((sessionID) => sessionID !== root)
    .flatMap((sessionID) => {
      const session = context.data.session.get(sessionID)
      if (session === undefined) return []
      const mesh = meshByID.get(sessionID)
      const state: MeshNode["state"] = killed.has(sessionID)
        ? "interrupted"
        : (mesh?.state ?? (context.data.session.status(sessionID) === "running" ? "running" : "idle"))
      return [
        {
          sessionID,
          ...(session.agent === undefined ? {} : { agent: session.agent }),
          ...(session.title === undefined ? {} : { title: session.title }),
          state,
          killed: killed.has(sessionID),
        },
      ]
    })
  if (nodes.length === 0) {
    notify("No subagents are running for this session", "info")
    return
  }

  const current = live.mesh.limits()
  const selected = await context.ui.dialog.select<AgentTarget>({
    title: `Agent tree (${nodes.length} subagent${nodes.length === 1 ? "" : "s"} · max ${current?.maxSubagents ?? DEFAULT_MAX_SUBAGENTS})`,
    placeholder: "Select a subagent",
    options: nodes.map((node) => ({
      title: subagentLabel(node),
      description: node.sessionID,
      value: node,
    })),
    actions: [
      {
        bind: "ctrl+s",
        title: "Steer",
        side: "right",
        selection: "required",
        onTrigger: (node) => void steerSubagent(context, live.mesh, root, node),
      },
      {
        bind: "ctrl+k",
        title: "Kill",
        side: "right",
        selection: "required",
        onTrigger: (node) => void killSubagent(context, live.mesh, root, node),
      },
    ],
  })
  if (selected === undefined) return
  if (selected.killed) {
    notify(`${subagentLabel(selected)} is already finished`, "info")
    return
  }
  const action = await context.ui.dialog.select<"steer" | "kill">({
    title: subagentLabel(selected),
    options: [
      { title: "Steer", description: "Send an instruction to this subagent", value: "steer" },
      { title: "Kill", description: "Terminate this subagent", value: "kill" },
    ],
  })
  if (action === "steer") await steerSubagent(context, live.mesh, root, selected)
  if (action === "kill") await killSubagent(context, live.mesh, root, selected)
}

export async function steerSubagent(
  context: Context,
  mesh: MeshLive,
  parentSessionID: string,
  node: AgentTarget,
): Promise<void> {
  const notify = notifier(context)
  if (!canSteer(node.state, { killed: node.killed })) {
    notify(`${subagentLabel(node)} is already finished`, "info")
    return
  }
  const instruction = await context.ui.dialog.prompt({
    title: `Steer: ${node.agent ?? node.title ?? node.sessionID}`,
    description: node.sessionID,
    placeholder: "Instruction for this subagent",
  })
  if (instruction === undefined || instruction.trim() === "") return
  // Address the child by session ID: the agent name alone reaches every
  // same-named sibling, and this dialog picked one row.
  const result = await mesh.steer({
    parentSessionID,
    targetAgent: node.agent ?? node.sessionID,
    targetSessionID: node.sessionID,
    instruction,
  })
  report(notify, result, `Steer sent to ${node.sessionID}`)
}

export async function killSubagent(
  context: Context,
  mesh: MeshLive,
  parentSessionID: string,
  node: AgentTarget,
): Promise<void> {
  const notify = notifier(context)
  if (node.killed) {
    notify(`${subagentLabel(node)} is already finished`, "info")
    return
  }
  const confirmed = await context.ui.dialog.confirm({
    title: "Kill subagent",
    message: `Kill ${node.agent ?? node.title ?? node.sessionID}? This cannot be undone.`,
    label: { confirm: "Kill", cancel: "Cancel" },
  })
  if (confirmed !== true) return
  const result = await mesh.kill({
    parentSessionID,
    targetSessionID: node.sessionID,
    reason: "User requested kill",
  })
  report(notify, result, `Kill sent to ${node.sessionID}`)
}

/**
 * `/thinking`, `/variant` and `/reasoning` prompt intercept (v1 behavior).
 * `input` is everything after the slash command; no argument reports state.
 */
export function applyVariantCommand(
  context: Context,
  raw: string,
  notify: Notify = notifier(context),
): boolean {
  const args = raw.trim()
  const list = context.ui.model.variant.list()
  const current = context.ui.model.current()?.variant
  if (args === "") {
    notify(
      `Current variant: ${current ?? "default"}. Available variants: ${list.join(", ") || "none"}`,
      "info",
    )
    return false
  }
  const value = args.toLowerCase()
  if (["off", "none", "disabled", "false"].includes(value)) {
    const ok = context.ui.model.variant.set(undefined)
    notify(ok ? "Reasoning variant disabled (set to default)." : "No model is selected.", ok ? "success" : "warning")
    return false
  }
  if (["on", "enabled", "true"].includes(value)) {
    const target = list.includes("high") ? "high" : list[0]
    if (target === undefined) {
      notify("No variants available for the current model.", "warning")
      return false
    }
    const ok = context.ui.model.variant.set(target)
    notify(
      ok ? `Reasoning variant enabled (set to ${target}).` : `Variant "${target}" is not available.`,
      ok ? "success" : "warning",
    )
    return false
  }
  if (!list.includes(value)) {
    notify(`Variant "${args}" is not supported by current model. Available: ${list.join(", ") || "none"}`, "warning")
    return false
  }
  const ok = context.ui.model.variant.set(value)
  notify(
    ok ? `Reasoning variant set to ${value}.` : `Variant "${value}" could not be set.`,
    ok ? "success" : "warning",
  )
  return false
}
