/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../feature-plugins/builtins"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useEvent } from "../context/event"
import { useSync } from "../context/sync"
import { toHex } from "../util/color"
import { RoundedBorder } from "../ui/border"
import { severityFill } from "../util/palette"
import type { Severity } from "../util/palette"

export * as AttentionStrip from "./attention-strip"

type AttentionKind = "permission" | "question" | "blocked" | "lsp" | "mcp"

interface BlockedPeer {
  agent: string
  blockedReason: string
}

interface StripItem {
  kind: AttentionKind
  id: string
  label: string
}

function AttentionStripView(props: { api: TuiPluginApi; sessionID: string; onJump: (kind: AttentionKind, id: string) => void }) {
  const theme = () => props.api.theme.current
  const ev = useEvent()
  const sync = useSync()

  const [blockedPeers, setBlockedPeers] = createSignal<BlockedPeer[]>([])
  const [permissionCount, setPermissionCount] = createSignal(0)
  const [diffCount, setDiffCount] = createSignal(0)
  const [questionCount, setQuestionCount] = createSignal(0)

  const mcpDown = createMemo(() => {
    const list = props.api.state.mcp()
    return list.filter((m: { status: string }) => m.status === "connected").length === 0
  })

  const unsubMesh = ev.on("banyancode.mesh.status" as any, (event: any) => {
    const peers = event.properties.peers ?? []
    setBlockedPeers(
      peers.filter((p: any) => p.status === "disconnected" && p.blockedReason)
        .map((p: any) => ({ agent: p.agent, blockedReason: p.blockedReason })),
    )
  })
  onCleanup(unsubMesh)

  const unsubPerm = ev.on("permission.asked" as any, () => {
    const perms = sync.data.permission[props.sessionID] ?? []
    setPermissionCount(perms.length)
    setDiffCount(perms.filter((p: any) => p.tool).length)
  })
  onCleanup(unsubPerm)

  const unsubPermReplied = ev.on("permission.replied" as any, () => {
    const perms = sync.data.permission[props.sessionID] ?? []
    setPermissionCount(perms.length)
    setDiffCount(perms.filter((p: any) => p.tool).length)
  })
  onCleanup(unsubPermReplied)

  const unsubQuest = ev.on("question.asked" as any, () => {
    const quests = sync.data.question[props.sessionID] ?? []
    setQuestionCount(quests.length)
  })
  onCleanup(unsubQuest)

  const unsubQuestReplied = ev.on("question.replied" as any, () => {
    const quests = sync.data.question[props.sessionID] ?? []
    setQuestionCount(quests.length)
  })
  onCleanup(unsubQuestReplied)

  const items = createMemo<StripItem[]>(() => {
    const result: StripItem[] = []
    for (const peer of blockedPeers()) {
      result.push({ kind: "blocked", id: peer.agent, label: `${peer.agent} blocked — ${peer.blockedReason}` })
    }
    if (diffCount() > 0) {
      result.push({ kind: "permission", id: "diff", label: `${diffCount()} diff${diffCount() !== 1 ? "s" : ""} awaiting review` })
    }
    if (permissionCount() > diffCount()) {
      const remaining = permissionCount() - diffCount()
      result.push({ kind: "permission", id: "permission", label: `${remaining} permission${remaining !== 1 ? "s" : ""} awaiting` })
    }
    if (questionCount() > 0) {
      result.push({ kind: "question", id: "question", label: `${questionCount()} question${questionCount() !== 1 ? "s" : ""} awaiting` })
    }
    if (mcpDown()) {
      result.push({ kind: "mcp", id: "mcp", label: "MCP down" })
    }
    return result
  })

  const accentForSeverity = (item: StripItem) => {
    if (item.kind === "blocked") return theme().error
    if (item.kind === "permission" && item.id === "diff") return theme().warning
    if (item.kind === "lsp" || item.kind === "mcp") return theme().warning
    return theme().info
  }

  const severityForKind = (item: StripItem): Severity => {
    if (item.kind === "blocked") return "error"
    if (item.kind === "permission" && item.id === "diff") return "warning"
    if (item.kind === "lsp" || item.kind === "mcp") return "warning"
    return "info"
  }

  return (
    <Show when={items().length > 0}>
      <box
        flexDirection="row"
        alignItems="center"
        gap={2}
        paddingTop={0}
        paddingBottom={0}
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={toHex(theme().error)}>▲</text>
        <For each={items()}>
          {(item, i) => (
            <>
              <Show when={i() > 0}>
                <text fg={toHex(theme().textMuted)}>·</text>
              </Show>
              <box
                customBorderChars={RoundedBorder.customBorderChars}
                border={["left", "right", "top", "bottom"]}
                borderColor={accentForSeverity(item)}
                backgroundColor={severityFill(theme().backgroundElement, accentForSeverity(item), severityForKind(item))}
                paddingLeft={1}
                paddingRight={1}
                flexShrink={0}
              >
                <text
                  fg={toHex(theme().text)}
                  onMouseDown={() => props.onJump(item.kind, item.id)}
                >
                  {item.label}
                </text>
              </box>
            </>
          )}
        </For>
      </box>
    </Show>
  )
}

const id = "internal:attention-strip"

const plugin: TuiPlugin = async (api) => {
  api.slots.register({
    slots: {
      session_attention_strip(_ctx, props: { sessionID: string }) {
        return (
          <AttentionStripView
            api={api}
            sessionID={props.sessionID}
            onJump={() => {}}
          />
        )
      },
    },
  })
}

export default { id, tui: plugin } satisfies BuiltinTuiPlugin
