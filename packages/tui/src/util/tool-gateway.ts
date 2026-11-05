/**
 * Human-facing markers for the repository gateway's provenance metadata.
 *
 * The gateway stamps `metadata.gateway` on every `read`/`grep`/`glob` result
 * (`{ route, from, to?, op?, reason, bytesSaved? }`); the same metadata is
 * persisted on the tool part, so a marker renders identically live and after a
 * reload. The text is plain enough to read without colour: the colour only
 * separates a swap from a fallback.
 */

export type GatewayRoute = "swapped" | "fallback" | "augmented" | "direct"

export interface GatewayView {
  readonly route: GatewayRoute
  readonly from: string
  readonly to?: string
  readonly op?: string
  readonly reason?: string
  readonly bytesSaved?: number
}

export interface GatewayMarker {
  readonly tone: "accent" | "muted" | "faint"
  readonly text: string
}

const ROUTES = new Set<string>(["swapped", "fallback", "augmented", "direct"])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Reads `metadata.gateway` from a tool part's metadata; anything malformed is "no marker". */
export function gatewayView(metadata: Record<string, unknown> | undefined): GatewayView | undefined {
  const value = metadata?.gateway
  if (!isRecord(value)) return undefined
  const route = value.route
  const from = value.from
  if (typeof route !== "string" || !ROUTES.has(route)) return undefined
  if (typeof from !== "string" || from === "") return undefined
  return {
    route: route as GatewayRoute,
    from,
    ...(typeof value.to === "string" && value.to !== "" ? { to: value.to } : {}),
    ...(typeof value.op === "string" && value.op !== "" ? { op: value.op } : {}),
    ...(typeof value.reason === "string" && value.reason !== "" ? { reason: value.reason } : {}),
    ...(typeof value.bytesSaved === "number" && Number.isFinite(value.bytesSaved)
      ? { bytesSaved: Math.max(0, value.bytesSaved) }
      : {}),
  }
}

/** `3200` -> `3.2 KB`; keeps the marker short at narrow widths. */
export function formatBytesSaved(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Short words for a fallback reason, so the row stays one line. */
const SHORT_REASON: Readonly<Record<string, string>> = {
  "graph-unbuilt": "graph missing",
  "graph-stale": "graph stale",
  "graph-empty": "graph empty",
  "not-indexed": "not indexed",
  "file-stale": "file changed",
  "tool-unavailable": "tool unavailable",
  "rewrite-refused": "not runnable",
  "augment-empty": "no symbols",
  "routing-error": "route error",
}

const reasonText = (reason: string | undefined): string => {
  if (reason === undefined) return "not used"
  return SHORT_REASON[reason] ?? reason.replace(/-/g, " ")
}

/**
 * The marker for one tool row. A swapped call names the tool that ran; a
 * fallback names the short reason; an augmented read gets a small note; a direct
 * call renders exactly as before, with no marker at all.
 */
export function gatewayMarker(metadata: Record<string, unknown> | undefined): GatewayMarker | undefined {
  const view = gatewayView(metadata)
  if (view === undefined) return undefined
  if (view.route === "direct") return undefined
  if (view.route === "swapped") {
    const target = view.to ?? "graph"
    const saved = view.bytesSaved !== undefined && view.bytesSaved > 0 ? ` (${formatBytesSaved(view.bytesSaved)} saved)` : ""
    return { tone: "accent", text: `⇢ ${target}${saved}` }
  }
  if (view.route === "augmented") return { tone: "faint", text: "+symbols" }
  return { tone: "muted", text: `↩ ${reasonText(view.reason)}` }
}

/**
 * Collapsed rows hide each call's marker, so they carry the totals instead,
 * e.g. `⇢ 3 via graph, ↩ 1 fallback`. Empty when no call touched the graph.
 */
export function gatewayTally(metadata: ReadonlyArray<Record<string, unknown> | undefined>): string {
  const views = metadata.flatMap((item) => gatewayView(item) ?? [])
  const swapped = views.filter((view) => view.route === "swapped").length
  const fallback = views.filter((view) => view.route === "fallback").length
  return [swapped > 0 ? `⇢ ${swapped} via graph` : "", fallback > 0 ? `↩ ${fallback} fallback` : ""]
    .filter((text) => text !== "")
    .join(", ")
}

/** One-line text form, used by renderers that only have a string label. */
export function gatewayMarkerText(metadata: Record<string, unknown> | undefined): string | undefined {
  return gatewayMarker(metadata)?.text
}
