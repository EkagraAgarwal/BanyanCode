import { Effect, Option } from "effect"
import path from "path"
import { lookup as dnsLookup } from "node:dns/promises"
import { ToolCatalog } from "@opencode-ai/core/tool/tool-catalog"
import { AgentV2 } from "@opencode-ai/core/agent"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Permission } from "@/permission"
import type { MessageID, SessionID } from "../schema"
import type { Deps, ToolName, ToolOutcome } from "./engine"

// Production seams for the jev-explorer engine. `promptDeps` assembles the
// real dispatcher from ambient services without widening R beyond what the
// caller already holds: permission goes through the V1 Permission.ask gate
// BEFORE every dispatch, deterministic repository tools settle through the
// canonical ToolCatalog (never via the task tool, never via the LLM), and
// WEB_FETCH runs a bounded guarded fetch (http/https only, every IPv4 textual
// form normalized + ALL DNS addresses checked with fail-closed private-
// address blocking, manual redirect re-validation, hard byte cap). Outputs
// are treated as untrusted data: the engine only ever extracts IDs/excerpts
// from them.

export interface PromptDepsInput {
  readonly sessionID: SessionID
  readonly messageID: MessageID
  readonly agentName: string
  readonly permission: Permission.Interface
  readonly ruleset: PermissionV1.Ruleset
  readonly root: string
  /** DNS resolver seam (tests inject a mocked resolver; production resolves ALL addresses). */
  readonly lookup?: HostLookup
}

const MAX_REDIRECTS = 5
const FETCH_TIMEOUT_MS = 30_000
const MAX_VERIFY_FILE_BYTES = 4 * 1024 * 1024

/** Resolves a hostname to every A/AAAA address; rejects on any DNS failure. */
export type HostLookup = (hostname: string) => Promise<readonly string[]>

export const defaultHostLookup: HostLookup = async (hostname) => {
  const entries = await dnsLookup(hostname, { all: true, verbatim: true })
  return entries.map((entry) => entry.address)
}

const parseIPv4Part = (part: string): number | undefined => {
  if (part === "") return undefined
  if (/^0x[0-9a-f]+$/i.test(part)) {
    const value = Number.parseInt(part.slice(2), 16)
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined
  }
  if (/^0[0-7]+$/.test(part)) {
    const value = Number.parseInt(part.slice(1), 8)
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined
  }
  if (!/^[0-9]+$/.test(part)) return undefined
  const value = Number(part)
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * Normalize ANY IPv4 textual form — dotted-quad, per-octet hex (`0x7f.0.0.1`),
 * per-octet octal (`0177.0.0.1`), a.b / a.b.c inet_aton forms, bare 32-bit
 * integer (`2130706433`), and `0x`-prefixed hex (`0x7f000001`) — to the
 * canonical dotted quad. Returns undefined when the host is not an IPv4
 * literal so callers fall through to the DNS path. The WHATWG URL parser
 * canonicalizes most of these inside `new URL`, but raw host strings
 * (redirect Locations, direct unit inputs) can arrive unnormalized.
 */
export const normalizeIPv4 = (host: string): string | undefined => {
  if (!/^[0-9a-fxX.]+$/i.test(host)) return undefined
  const parts = host.split(".")
  if (parts.length === 0 || parts.length > 4) return undefined
  const values: number[] = []
  for (const part of parts) {
    const value = parseIPv4Part(part)
    if (value === undefined) return undefined
    values.push(value)
  }
  for (const head of values.slice(0, -1)) if (head > 255) return undefined
  const tail = values[values.length - 1]
  if (tail === undefined || tail >= 256 ** (5 - values.length)) return undefined
  let packed = 0
  for (const head of values.slice(0, -1)) packed = packed * 256 + head
  packed = packed * 256 ** (5 - values.length) + tail
  if (packed > 0xffffffff) return undefined
  return [(packed >>> 24) & 255, (packed >>> 16) & 255, (packed >>> 8) & 255, packed & 255].join(".")
}

/** Private/special-range check over a canonical dotted quad; fail-closed on anything unparseable. */
const isPrivateIPv4 = (value: string): boolean => {
  const parts = value.split(".").map(Number)
  if (parts.length !== 4 || parts.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true
  const first = parts[0] ?? -1
  const second = parts[1] ?? -1
  const third = parts[2] ?? -1
  return (
    first === 0 || // 0.0.0.0/8 (includes 0.0.0.0 itself)
    first === 10 || // 10/8
    first === 127 || // 127/8
    (first === 100 && second >= 64 && second <= 127) || // CGNAT 100.64/10
    (first === 169 && second === 254) || // link-local 169.254/16 incl. 169.254.169.254 metadata
    (first === 172 && second >= 16 && second <= 31) || // 172.16/12
    (first === 192 && second === 0 && third === 0) || // 192.0.0/24
    (first === 192 && second === 0 && third === 2) || // TEST-NET-1
    (first === 192 && second === 168) || // 192.168/16
    (first === 198 && (second === 18 || second === 19)) || // benchmarking 198.18/15
    (first === 198 && second === 51 && third === 100) || // TEST-NET-2
    (first === 203 && second === 0 && third === 113) || // TEST-NET-3
    first >= 224 // multicast + reserved + broadcast
  )
}

/**
 * Parse ANY IPv6 textual form — compressed (`::1`), expanded
 * (`0:0:0:0:0:0:0:1`), bracketed, or with an embedded dotted quad
 * (`::ffff:127.0.0.1`, `0:0:0:0:0:ffff:127.0.0.1`) — into eight 16-bit
 * groups. Returns undefined when unparseable so callers fail closed.
 * Prefix regexes are NOT enough: expanded loopback/unspecified/v4-mapped
 * forms must compare numerically over the full 128 bits.
 */
const parseIPv6 = (raw: string): readonly number[] | undefined => {
  const unbracketed = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw
  const host = unbracketed.toLowerCase()
  let text = host
  if (host.includes(".")) {
    const colon = host.lastIndexOf(":")
    if (colon === -1) return undefined
    const normalized = normalizeIPv4(host.slice(colon + 1))
    if (normalized === undefined) return undefined
    const octets = normalized.split(".").map(Number)
    if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return undefined
    const high = (octets[0] ?? -1) * 256 + (octets[1] ?? -1)
    const low = (octets[2] ?? -1) * 256 + (octets[3] ?? -1)
    text = `${host.slice(0, colon)}:${high.toString(16)}:${low.toString(16)}`
  }
  if (!/^[0-9a-f:]*$/i.test(text)) return undefined
  const halves = text.split("::")
  if (halves.length > 2) return undefined
  const parseHalf = (half: string): number[] | undefined => {
    if (half === "") return []
    const groups: number[] = []
    for (const part of half.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(part)) return undefined
      groups.push(Number.parseInt(part, 16))
    }
    return groups
  }
  if (halves.length === 1) {
    const groups = parseHalf(text)
    return groups !== undefined && groups.length === 8 ? groups : undefined
  }
  const left = parseHalf(halves[0] ?? "")
  const right = parseHalf(halves[1] ?? "")
  if (left === undefined || right === undefined) return undefined
  const fill = 8 - left.length - right.length
  if (fill < 1) return undefined
  return [...left, ...new Array<number>(fill).fill(0), ...right]
}

/** Full 128-bit private/special-range check; fail-closed on anything unparseable. */
const isPrivateIPv6 = (raw: string): boolean => {
  const groups = parseIPv6(raw)
  if (groups === undefined) return true
  const at = (index: number): number => groups[index] ?? -1
  if (groups.every((group) => group === 0)) return true // :: (unspecified)
  if (groups.slice(0, 7).every((group) => group === 0) && at(7) === 1) return true // ::1 (loopback)
  if (at(0) === 0 && at(1) === 0 && at(2) === 0 && at(3) === 0 && at(4) === 0) {
    if (at(5) === 0xffff) {
      // ::ffff:0:0/96 v4-mapped (any textual form) — judge the embedded v4.
      const normalized = normalizeIPv4(`${at(6) >> 8}.${at(6) & 255}.${at(7) >> 8}.${at(7) & 255}`)
      return normalized === undefined ? true : isPrivateIPv4(normalized)
    }
    if (at(5) === 0) return true // deprecated ::/96, unroutable
  }
  if (at(0) === 0x2002) {
    // 6to4 2002::/16 embeds the v4 address in groups 1-2.
    const normalized = normalizeIPv4(`${at(1) >> 8}.${at(1) & 255}.${at(2) >> 8}.${at(2) & 255}`)
    return normalized === undefined ? true : isPrivateIPv4(normalized)
  }
  const first = at(0)
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (first & 0xffc0) === 0xfec0 || // fec0::/10 deprecated site-local
    (first & 0xff00) === 0xff00 // ff00::/8 multicast
  )
  // Residual: 2001::/32 Teredo embeds an obfuscated v4 address and is not
  // decoded here; Teredo is deprecated and relay-dependent, revisit if the
  // fetch surface ever runs on Teredo-capable hosts.
}

/**
 * SSRF guard: block private/special addresses in EVERY textual form (integer,
 * hex, octal, dotted IPv4; bracketed/unbracketed IPv6 incl. v4-mapped) AND
 * hostnames whose DNS resolution (ALL addresses) contains ANY non-public
 * address — a public hostname resolving to link-local/cloud-metadata is
 * blocked. IP literals never hit DNS; DNS failure, an empty answer, or an
 * unparseable resolved address blocks (fail closed).
 */
export const isBlockedHost = async (hostname: string, lookup: HostLookup = defaultHostLookup): Promise<boolean> => {
  const host = hostname
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "")
  if (
    host === "localhost" ||
    host === "" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".home")
  )
    return true
  const ipv4 = normalizeIPv4(host)
  if (ipv4 !== undefined) return isPrivateIPv4(ipv4)
  if (host.includes(":")) return isPrivateIPv6(host)
  let addresses: readonly string[]
  try {
    addresses = await lookup(host)
  } catch {
    return true
  }
  if (addresses.length === 0) return true
  for (const address of addresses) {
    const normalized = normalizeIPv4(address)
    if (normalized !== undefined) {
      if (isPrivateIPv4(normalized)) return true
      continue
    }
    if (address.includes(":")) {
      if (isPrivateIPv6(address)) return true
      continue
    }
    return true
  }
  return false
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** UTF-8 byte length — NOT UTF-16 code units — so byte budgets hold for multibyte text. */
const utf8Length = (value: string): number => encoder.encode(value).byteLength

/**
 * Hard byte cap for one dispatched payload, measured in UTF-8 bytes.
 * Truncates (never inflates) without splitting a UTF-8 sequence, so a small
 * `maxBytes` budget is honored exactly — enforced BEFORE the engine runs
 * evidence/candidate extraction, so over-budget text never enters them.
 */
export const truncateToBytes = (value: string, maxBytes: number): string => {
  if (maxBytes <= 0) return ""
  const encoded = encoder.encode(value)
  if (encoded.byteLength <= maxBytes) return value
  let end = maxBytes
  while (end > 0) {
    const byte = encoded[end] ?? 0
    if ((byte & 0xc0) !== 0x80) break
    end -= 1
  }
  return decoder.decode(encoded.subarray(0, end))
}

const readBodyBounded = async (response: Response, maxBytes: number): Promise<Uint8Array> => {
  const reader = response.body?.getReader()
  if (!reader) {
    const buffer = await response.arrayBuffer()
    return new Uint8Array(buffer.slice(0, maxBytes))
  }
  const chunks: Uint8Array[] = []
  let total = 0
  while (total < maxBytes) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    const remaining = maxBytes - total
    const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value
    chunks.push(slice)
    total += slice.byteLength
  }
  // Hard stop: abort the stream as soon as the cap is reached, then truncate.
  if (total >= maxBytes) await reader.cancel().catch(() => undefined)
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

const guardedFetch = (rawUrl: string, maxBytes: number, lookup: HostLookup): Effect.Effect<ToolOutcome> =>
  Effect.promise(async () => {
    const fail = (value: string): ToolOutcome => ({ ok: false, value, bytes: 0 })
    let current = rawUrl
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let parsed: URL
      try {
        parsed = new URL(current)
      } catch {
        return fail("invalid url")
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return fail(`blocked scheme ${parsed.protocol}`)
      if (await isBlockedHost(parsed.hostname, lookup)) return fail("blocked private-network host")
      const response = await fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { Accept: "text/html,text/plain;q=0.9,*/*;q=0.1" },
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location")
        if (!location) return fail("redirect without location")
        current = new URL(location, current).toString()
        continue
      }
      if (!response.ok) return fail(`HTTP ${response.status}`)
      const body = await readBodyBounded(response, maxBytes)
      const text = new TextDecoder().decode(body)
      return { ok: true, value: text, bytes: body.byteLength }
    }
    return fail("too many redirects")
  })

/** Workspace-bound stop-verification seam: resolve inside `root`, reject escapes, check line ranges. */
export const verifyFileAt =
  (root: string) =>
  (file: string, lines?: string): Effect.Effect<boolean> =>
    Effect.promise(async () => {
      const rootResolved = path.resolve(root)
      const resolved = path.resolve(rootResolved, file)
      if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) return false
      const target = Bun.file(resolved)
      if (!(await target.exists())) return false
      if (!lines) return true
      const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(lines.trim())
      if (!match) return false
      const start = Number(match[1])
      const end = Number(match[2] ?? match[1])
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) return false
      if (target.size > MAX_VERIFY_FILE_BYTES) return false
      const text = await target.text()
      const lineCount = text.split(/\r\n|\r|\n/).length
      return lineCount >= end
    })

export const promptDeps: (input: PromptDepsInput) => Effect.Effect<Deps, never, never> = Effect.fn(
  "JevExplorer.promptDeps",
)(function* (input: PromptDepsInput) {
  const catalogOption = yield* Effect.serviceOption(ToolCatalog.Service)
  const catalog = Option.getOrUndefined(catalogOption)

  const ask = (action: string, pattern: string): Effect.Effect<boolean> =>
    input.permission
      .ask({
        permission: action,
        patterns: [pattern],
        metadata: {},
        always: ["*"],
        sessionID: input.sessionID,
        tool: { messageID: input.messageID, callID: `jev-${action}` },
        ruleset: input.ruleset,
      })
      .pipe(Effect.as(true), Effect.orElseSucceed(() => false))

  const call = (req: {
    readonly id: string
    readonly tool: ToolName
    readonly input: Record<string, unknown>
    readonly maxBytes: number
  }): Effect.Effect<ToolOutcome> =>
    Effect.gen(function* () {
      if (req.tool === "webfetch") {
        const url = typeof req.input.url === "string" ? req.input.url : ""
        return yield* guardedFetch(url, req.maxBytes, input.lookup ?? defaultHostLookup)
      }
      if (!catalog) return { ok: false, value: "tool catalog unavailable", bytes: 0 }
      const materialized = yield* catalog.materialize()
      const settled = yield* materialized.settle({
        sessionID: input.sessionID,
        agent: AgentV2.ID.make(input.agentName),
        assistantMessageID: SessionMessage.ID.make(input.messageID),
        call: { type: "tool-call", id: req.id, name: req.tool, input: req.input },
      })
      const result = settled.result
      // Hard cap at EXACTLY req.maxBytes — small budgets are honored, never
      // inflated to a fixed floor — so the engine's byte accounting and
      // evidence/candidate extraction only ever see ≤ maxBytes materialized.
      if (result.type === "error") {
        const value = truncateToBytes(String(result.value), req.maxBytes)
        return { ok: false, value, bytes: utf8Length(value) }
      }
      if (result.type === "json") {
        const text = truncateToBytes(JSON.stringify(result.value), req.maxBytes)
        return { ok: true, value: text, json: result.value, bytes: utf8Length(text) }
      }
      const value = truncateToBytes(result.value, req.maxBytes)
      return { ok: true, value, bytes: utf8Length(value) }
    }).pipe(
      Effect.catchCause(() => Effect.succeed({ ok: false, value: "tool dispatch failed", bytes: 0 } satisfies ToolOutcome)),
    )

  return {
    ask,
    call,
    verifyFile: verifyFileAt(input.root),
  } satisfies Deps
})
