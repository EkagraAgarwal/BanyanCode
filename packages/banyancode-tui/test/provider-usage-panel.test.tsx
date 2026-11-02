/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { ProviderUsagePanel } from "../src/components/sidebar/provider-usage"
import type { UsageLive } from "../src/data/live"
import type { ProviderUsageSnapshot } from "../src/data/pending-rpc"
import { context, mount, session, usageLive } from "./harness"

const snapshot = (): ProviderUsageSnapshot => ({
  providerID: "claude-agent",
  displayName: "Claude Agent",
  status: "available",
  confidence: "reported",
  windows: [{ id: "five_hour", label: "5h", kind: "quota", usedPercent: 51, remainingPercent: 49 }],
  fetchedAt: 1,
})

test("a step end refreshes the panel plainly for its own session", async () => {
  const listeners = new Map<string, Array<(event: { readonly data: { readonly sessionID: string } }) => void>>()
  const ctx = context({
    sessions: [session({ id: "ses_root", model: { providerID: "claude-agent" as never, id: "claude" } })],
    on: (type, handler) => {
      const list = listeners.get(type) ?? []
      list.push(handler)
      listeners.set(type, list)
      return () => {
        listeners.set(
          type,
          (listeners.get(type) ?? []).filter((item) => item !== handler),
        )
      }
    },
  })
  const calls: boolean[] = []
  const usage: UsageLive = {
    ...usageLive({ providers: [snapshot()] }),
    refreshProviders: async (force = false) => {
      calls.push(force)
    },
  }

  const app = await mount(() => <ProviderUsagePanel context={ctx} sessionID="ses_root" usage={usage} />, {
    width: 60,
    height: 10,
  })
  try {
    // `session.idle` is a deprecated event nothing emits; the panel must not wait for it.
    expect(listeners.has("session.idle")).toBe(false)
    expect(calls).toEqual([false])

    for (const handler of listeners.get("session.step.ended") ?? [])
      handler({ data: { sessionID: "ses_root" } })
    await app.renderOnce()
    expect(calls).toEqual([false, false])

    for (const handler of listeners.get("session.step.ended") ?? [])
      handler({ data: { sessionID: "ses_other" } })
    await app.renderOnce()
    expect(calls).toEqual([false, false])
  } finally {
    app.renderer.destroy()
  }
})
