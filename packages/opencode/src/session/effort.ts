import { Option, Effect, Layer, ManagedRuntime } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Banyan } from "@opencode-ai/core/banyancode"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { NotFoundError } from "@/storage/storage"
import { MessageID, PartID, SessionID } from "./schema"
import { Session } from "./session"

// WS4 reasoning-effort state (prompt-caching plan WS4a). Per session:
// `baseReasoningEffort` freezes at the first non-small request (see
// LLMRequestPrep) and is NEVER mutated afterwards; `effectiveReasoningEffort`
// tracks the latest thinking change. Mid-conversation changes persist a
// `configuration_update` input item via applyEffortChange instead of
// rewriting the frozen top-level `reasoning.effort` — rewriting invalidates
// the prompt prefix (`reasoning_effort_changed` cache miss). The persisted
// marker replays at its original position through MessageV2.toModelMessages.
//
// Gate: `banyancode_reasoning_configuration_update` (BanyanConfig, default
// true) is checked at the top of applyEffortChange — when false it is a
// no-op and callers keep today's top-level-effort behavior. ACP setVariant
// and CLI saveVariant now call applyEffortChangeDetached below; the TUI
// thinking hooks (dialog-thinking / variant.cycle) are NOT wired yet — they
// have no HTTP route to the marker writer, so a TUI variant change on an
// eligible session is pinned away by LLMRequestPrep with no marker (see the
// TODO in dialog-thinking.tsx).

export interface EffortState {
  /** Frozen at the first eligible request; never written by applyEffortChange. */
  readonly baseReasoningEffort?: string
  /** Mutable — the effort selected by the newest configuration_update (or base). */
  readonly effectiveReasoningEffort?: string
}

// Process-lifetime, one entry per session that ever froze or changed effort
// (same footprint class as SessionTools' sticky snapshots).
const states = new Map<string, EffortState>()

// configuration_update is documented for the GPT-6 family only. Anchored like
// transform.ts GPT6_FAMILY_RE so "gpt-60"/"gpt-65" never match while a
// provider-prefixed id ("openai/gpt-6-astra") still does.
const GPT6_FAMILY_RE = /(?:^|\/)gpt-6(?:[.-]|$)/

/** True only for the GPT-6 family — the only models documented to accept `configuration_update` input items. */
export function isConfigurationUpdateEligible(modelId: string): boolean {
  return GPT6_FAMILY_RE.test(modelId.toLowerCase())
}

export function effortState(sessionID: string): EffortState | undefined {
  return states.get(sessionID)
}

export function baseReasoningEffort(sessionID: string): string | undefined {
  return states.get(sessionID)?.baseReasoningEffort
}

export function effectiveReasoningEffort(sessionID: string): string | undefined {
  return states.get(sessionID)?.effectiveReasoningEffort
}

/**
 * Freeze the request-level effort at the first eligible request. First write
 * wins: later calls (and applyEffortChange) never move the base, so the
 * top-level `reasoning.effort` stays byte-stable for the conversation.
 */
export function freezeBaseReasoningEffort(sessionID: string, effort: string | undefined): void {
  if (effort === undefined) return
  const current = states.get(sessionID)
  if (current?.baseReasoningEffort !== undefined) return
  states.set(sessionID, {
    baseReasoningEffort: effort,
    effectiveReasoningEffort: current?.effectiveReasoningEffort ?? effort,
  })
}

/** Test hook — drop every session's effort state. */
export function resetEffortState(): void {
  states.clear()
}

/** A marker message: user role whose ONLY content is configuration_update part(s). */
export function isConfigurationUpdateMarker(msg: SessionV1.WithParts): boolean {
  return (
    msg.info.role === "user" &&
    msg.parts.length > 0 &&
    msg.parts.every((part) => part.type === "configuration_update")
  )
}

/**
 * Record a mid-conversation thinking change (WS4): moves
 * `effectiveReasoningEffort` (the frozen base is untouched) and persists a
 * configuration_update marker in the message store so stateless replay sends
 * the item before the next user turn at its original position.
 *
 * Coalesce rules (two adjacent configuration_update items are an API 400):
 * - when the newest stored message is already a marker, its effort is
 *   replaced in place instead of appending a second marker;
 * - when the effort is already in effect, nothing is written.
 *
 * Returns the stored part, or undefined when no marker was written.
 */
export const applyEffortChange = Effect.fn("SessionEffort.applyEffortChange")(function* (
  sessionID: SessionID,
  effort: string,
) {
  // banyancode_reasoning_configuration_update (default true): when the user
  // opts out, this is a no-op — callers fall back to the legacy top-level
  // reasoning.effort rewrite. A missing BanyanConfigService = enabled.
  const banyanOption = yield* Effect.serviceOption(Banyan.BanyanConfigService)
  if (
    Option.isSome(banyanOption) &&
    (yield* banyanOption.value.get()).banyancode_reasoning_configuration_update === false
  )
    return undefined
  const sessions = yield* Session.Service
  const state = states.get(sessionID)
  if (state?.effectiveReasoningEffort === effort) return undefined

  const recent = yield* sessions.messages({ sessionID, limit: 1 })
  const last = recent.at(-1)
  if (last && isConfigurationUpdateMarker(last)) {
    let updated: SessionV1.ConfigurationUpdatePart | undefined
    for (const part of last.parts) {
      if (part.type !== "configuration_update") continue
      updated = yield* sessions.updatePart({ ...part, reasoning: { effort } })
    }
    states.set(sessionID, { ...state, effectiveReasoningEffort: effort })
    return updated
  }

  // Append a fresh marker: it lands at the current end of history, i.e.
  // before whatever the next user turn will be. Reuse agent/model from the
  // newest real user message (falling back to the session record) so the
  // synthetic User message satisfies the store schema.
  const session = yield* sessions.get(sessionID)
  const prior = yield* sessions.findMessage(
    sessionID,
    (msg) => msg.info.role === "user" && !isConfigurationUpdateMarker(msg),
  )
  const source = Option.getOrUndefined(prior)?.info
  const agent = (source?.role === "user" ? source.agent : undefined) ?? session.agent ?? "user"
  const model =
    source?.role === "user"
      ? source.model
      : session.model
        ? { providerID: session.model.providerID, modelID: session.model.id }
        : undefined
  if (!model) {
    return yield* new NotFoundError({ message: `Session has no model to record an effort change: ${sessionID}` })
  }

  const messageID = MessageID.ascending()
  yield* sessions.updateMessage({
    id: messageID,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent,
    model,
  } satisfies SessionV1.User)
  const part = yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID,
    type: "configuration_update",
    reasoning: { effort },
  })
  states.set(sessionID, { ...state, effectiveReasoningEffort: effort })
  return part
})

/**
 * applyEffortChange for hooks that live OUTSIDE the session Effect graph
 * (ACP setVariant runs on the ACPSession Ref runtime; CLI saveVariant is a
 * fire-and-forget call). Runs on a lazily-built ManagedRuntime that shares
 * the process-wide memoMap, so when AppRuntime already built
 * `Session.defaultLayer` the marker write reuses THAT Session/DB/projector
 * instance (one SQLite connection per process, not per call); otherwise the
 * layer builds self-contained (Session + its projector + Database.path()).
 * BanyanConfig rides along or the flag-off case would read as "service
 * missing = enabled" and write markers anyway. Failures are swallowed: by the
 * time a hook runs the variant mutation already succeeded and the marker is
 * best-effort (e.g. a remote-attach session id that is not in the local DB).
 */
const makeHookRuntime = () =>
  ManagedRuntime.make(Layer.mergeAll(Session.defaultLayer, Banyan.banyanConfigServiceDefaultLayer), { memoMap })

let hookRuntime: ReturnType<typeof makeHookRuntime> | undefined

export function applyEffortChangeDetached(sessionID: SessionID | string, effort: string): Promise<void> {
  const runtime = (hookRuntime ??= makeHookRuntime())
  return runtime
    .runPromise(applyEffortChange(SessionID.make(String(sessionID)), effort))
    .then(
      () => undefined,
      () => undefined,
    )
}

export * as SessionEffort from "./effort"
