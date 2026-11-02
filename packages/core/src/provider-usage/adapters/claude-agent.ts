export * as ClaudeAgentUsage from "./claude-agent.js"

import { Effect } from "effect"
import { ClaudeRateLimits } from "../../plugin/provider/claude-agent/claude/rate-limits.js"
import { ProviderUsageError } from "../error.js"
import { normalizeWindow, unsupportedSnapshot, type Snapshot } from "../schema.js"
import type { Adapter, AdapterContext } from "./types.js"

/**
 * Claude Agent usage adapter (provider-usage sidebar parity).
 *
 * The Claude Code login is owned by the `claude` CLI; opencode never sees its
 * token, so the Anthropic OAuth usage endpoint is not reachable from here.
 * The Agent SDK does forward Claude Code's `rate_limit_event` messages, which
 * carry the real five-hour and weekly utilization. Those events are recorded
 * by the Claude Agent language model and read here.
 *
 * Before the first response there is no event yet. A connected account then
 * reports that plainly instead of inventing a quota; a missing connection
 * still reports `unauthenticated`.
 */

export const PROVIDER_ID = "claude-agent"
export const WAITING_MESSAGE = "Limits appear after the first response"
export const REFRESH_MESSAGE = "Limits update after the next response"

export const ClaudeAgentAdapter: Adapter = {
  id: "banyan-usage-claude-agent",
  providerID: PROVIDER_ID,
  refreshIntervalSeconds: 60,
  supports: (input) => input.providerID === PROVIDER_ID,
  fetch: (ctx: AdapterContext) =>
    Effect.gen(function* () {
      const credential = yield* ctx.credential()
      if (!credential)
        return yield* new ProviderUsageError({
          providerID: ctx.providerID,
          reason: "unauthenticated",
          message: "Claude Agent is not connected",
        })
      const observed = ClaudeRateLimits.read()
      const now = Date.now()
      // A window whose reset has passed is no longer evidence of current
      // utilization; wait for the next event rather than showing a stale bar.
      const windows = (observed?.windows ?? []).filter(
        (window) => window.resetsAt === undefined || window.resetsAt > now,
      )
      if (windows.length === 0)
        return unsupportedSnapshot(
          ctx.providerID,
          ctx.displayName,
          now,
          observed === undefined ? WAITING_MESSAGE : REFRESH_MESSAGE,
        )
      return {
        providerID: ctx.providerID,
        displayName: ctx.displayName,
        status: "available",
        confidence: "reported",
        windows: windows.map((window) =>
          normalizeWindow({
            id: window.id,
            label: window.label,
            kind: "quota",
            ...(window.usedPercent === undefined ? {} : { usedPercent: window.usedPercent }),
            ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
            ...(window.durationSeconds === undefined ? {} : { durationSeconds: window.durationSeconds }),
          }),
        ),
        fetchedAt: observed?.observedAt ?? now,
      } satisfies Snapshot
    }),
}
