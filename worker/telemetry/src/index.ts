/**
 * BanyanCode install telemetry endpoint (Cloudflare Worker + D1).
 * Per specs/banyancode/install-telemetry.md, section "Endpoint (Cloudflare Worker + KV/D1)".
 *
 * Routes:
 *   POST /ping    — accept a first_run/heartbeat event, upsert into D1, 204
 *   GET  /stats   — aggregate metric contract over an optional ISO from/to window
 *   GET  /health  — 200 { ok: true }
 *
 * Privacy posture (enforced contract): this worker NEVER reads, logs, or stores the
 * client IP or any request header beyond the payload fields. No cookies, no user-agent
 * persistence. The only header inspected is Content-Length (a hop header) for an early
 * body-size short-circuit; it is never persisted.
 *
 * CORS: `Access-Control-Allow-Origin: *` is acceptable here because /stats is an
 * anonymous aggregate API (no credentials, no auth cookies). See README.md.
 *
 * D1 binding types are declared structurally below so the file typechecks without
 * pulling @cloudflare/workers-types into the (minimal) package.
 */

const MAX_BODY_BYTES = 300 // client payload is <= 200 bytes; hard reject above 300
const MAX_STRING = 64 // clamp for optional free-form strings (version/channel/os/arch)
const MAX_INSTALL_METHOD = 32 // clamp for install_method (client normalizes to enum)

const EVENT_TYPES = new Set(["first_run", "heartbeat"])

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
}

// --- Minimal structural types for the D1 binding ---------------------------------------

interface D1Result {
  success: boolean
  meta?: { changes?: number }
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  run(): Promise<D1Result>
  first<T = unknown>(): Promise<T | null>
}
interface D1Database {
  prepare(sql: string): D1PreparedStatement
}

export interface Env {
  DB: D1Database
}

// --- Helpers ---------------------------------------------------------------------------

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/** Optional string field; returns null when absent and the clamped value when present (non-strings are dropped). */
function optStr(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "string") return null
  return value.length > max ? value.slice(0, max) : value
}

function parseIsoMs(value: string): number | undefined {
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? undefined : ms
}

// --- Handlers --------------------------------------------------------------------------

async function handlePing(request: Request, env: Env): Promise<Response> {
  // Early short-circuit on Content-Length before buffering the body (not persisted).
  const declared = request.headers.get("Content-Length")
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    return json({ error: "payload_too_large" }, 413)
  }

  const body = await request.text()
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    return json({ error: "payload_too_large" }, 413)
  }

  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    return json({ error: "invalid_json" }, 400)
  }
  if (typeof raw !== "object" || raw === null) {
    return json({ error: "invalid_payload" }, 400)
  }
  const p = raw as Record<string, unknown>

  const installId = p.install_id
  if (typeof installId !== "string" || installId.length === 0 || installId.length > MAX_STRING) {
    return json({ error: "invalid_install_id" }, 400)
  }
  const eventType = p.event_type
  if (typeof eventType !== "string" || !EVENT_TYPES.has(eventType)) {
    return json({ error: "invalid_event_type" }, 400)
  }
  if (p.ci !== undefined && typeof p.ci !== "boolean") {
    return json({ error: "invalid_ci" }, 400)
  }

  // One row per (install_id, event_type), latest wins. install_method is stored as-is
  // (client-side enum normalization is the client's job) but clamped to 32 chars here.
  await env.DB.prepare(
    `INSERT INTO install_events
       (event_id, install_id, event_type, timestamp, version, channel, os, arch, install_method, ci)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (install_id, event_type) DO UPDATE SET
       timestamp = excluded.timestamp,
       version = excluded.version,
       channel = excluded.channel,
       os = excluded.os,
       arch = excluded.arch,
       install_method = excluded.install_method,
       ci = excluded.ci`,
  )
    .bind(
      crypto.randomUUID(),
      installId,
      eventType,
      Date.now(),
      optStr(p.version, MAX_STRING),
      optStr(p.channel, MAX_STRING),
      optStr(p.os, MAX_STRING),
      optStr(p.arch, MAX_STRING),
      optStr(p.install_method, MAX_INSTALL_METHOD),
      p.ci === undefined ? null : p.ci ? 1 : 0,
    )
    .run()

  return new Response(null, { status: 204 })
}

async function handleStats(url: URL, env: Env): Promise<Response> {
  const fromRaw = url.searchParams.get("from")
  const toRaw = url.searchParams.get("to")
  if (fromRaw !== null && fromRaw === "") return json({ error: "invalid_range" }, 400)
  if (toRaw !== null && toRaw === "") return json({ error: "invalid_range" }, 400)
  const fromMs = fromRaw !== null ? parseIsoMs(fromRaw) : null
  const toMs = toRaw !== null ? parseIsoMs(toRaw) : null
  if (fromMs === undefined || toMs === undefined) {
    return json({ error: "invalid_range" }, 400)
  }

  const count = async (
    sql: string,
    vals: Array<string | number>,
  ): Promise<number> => {
    let stmt = env.DB.prepare(sql)
    if (vals.length > 0) stmt = stmt.bind(...vals)
    const row = await stmt.first<{ n: number }>()
    return row?.n ?? 0
  }

  // Range bounds: [from, to), half-open in milliseconds; absent bounds mean all-time.
  const rangeSql = (col: string): { sql: string; vals: Array<string | number> } => {
    const parts: string[] = []
    const vals: Array<string | number> = []
    if (fromMs !== null) {
      parts.push(`${col} >= ?`)
      vals.push(fromMs)
    }
    if (toMs !== null) {
      parts.push(`${col} < ?`)
      vals.push(toMs)
    }
    return { sql: parts.length > 0 ? ` WHERE ${parts.join(" AND ")}` : "", vals }
  }

  const within = rangeSql("timestamp")

  const total = await count("SELECT COUNT(DISTINCT install_id) AS n FROM install_events", [])
  const newInstalls = await count(
    `SELECT COUNT(DISTINCT install_id) AS n FROM install_events WHERE event_type = 'first_run'${within.sql}`,
    within.vals,
  )
  const active = await count(
    `SELECT COUNT(DISTINCT install_id) AS n FROM install_events WHERE event_type = 'heartbeat'${within.sql}`,
    within.vals,
  )
  // ci split is scoped to the window (or all-time when omitted), consistent with new/active.
  const ci = await count(
    `SELECT COUNT(DISTINCT install_id) AS n FROM install_events WHERE ci = 1${within.sql}`,
    within.vals,
  )
  const nonCi = await count(
    `SELECT COUNT(DISTINCT install_id) AS n FROM install_events WHERE (ci = 0 OR ci IS NULL)${within.sql}`,
    within.vals,
  )

  return json(
    {
      total_install_ids: total,
      new_install_ids: newInstalls,
      active_install_ids: active,
      ci_install_ids: ci,
      non_ci_install_ids: nonCi,
    },
    200,
  )
}

// --- Worker entry ----------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    const url = new URL(request.url)

    let response: Response
    try {
      if (request.method === "POST" && url.pathname === "/ping") {
        response = await handlePing(request, env)
      } else if (request.method === "GET" && url.pathname === "/stats") {
        response = await handleStats(url, env)
      } else if (request.method === "GET" && url.pathname === "/health") {
        response = json({ ok: true }, 200)
      } else {
        response = json({ error: "not_found" }, 404)
      }
    } catch (err) {
      // Never leak internals (DB errors, stack traces) to callers.
      response = json({ error: "internal_error" }, 500)
    }

    const headers = new Headers(response.headers)
    for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value)
    return new Response(response.body, { status: response.status, headers })
  },
}
