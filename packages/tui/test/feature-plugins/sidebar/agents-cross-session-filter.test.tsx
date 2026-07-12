/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { readFileSync } from "fs"
import { resolve } from "path"

/**
 * Regression test for the AGENTS sidebar cross-session flicker.
 *
 * Root cause (see plan): `banyancode-mesh-bridge.ts` republishes the mesh
 * status for EVERY tracked parent session every 2 seconds. The sidebar's
 * `View` (in `agents.tsx`) used to subscribe to the same `banyancode.mesh.status`
 * event and unconditionally overwrite its local `meshStatus` signal. When a
 * different tracked session's event arrived with `peers: []`, the sidebar
 * for the currently-viewed session transiently showed "No active agents",
 * causing the visible jump. The fix is to filter on
 * `event.properties.parentSessionID === props.session_id` BEFORE calling
 * `setMeshStatus`, plus a stale-while-revalidate guard that keeps the last
 * populated peer list when a same-session update arrives empty.
 *
 * This test asserts the source-side shape of that fix.
 */

test("agents sidebar: ignores banyancode.mesh.status events from other sessions", () => {
  const source = readFileSync(
    resolve(__dirname, "../../../src/feature-plugins/sidebar/agents.tsx"),
    "utf8",
  )
  // The filter MUST compare event.properties.parentSessionID against the
  // current session_id before touching local state.
  expect(source).toContain("parentSessionID")
  expect(source).toMatch(/next\.parentSessionID\s*!==\s*props\.session_id/)
  // And it MUST early-return on mismatch so the local signal is untouched.
  expect(source).toMatch(/if\s*\(\s*!\s*next\s*\|\|\s*next\.parentSessionID\s*!==\s*props\.session_id\s*\)\s*return/)
})

test("agents sidebar: keeps the last populated peer list when same-session update arrives empty", () => {
  const source = readFileSync(
    resolve(__dirname, "../../../src/feature-plugins/sidebar/agents.tsx"),
    "utf8",
  )
  // Stale-while-revalidate: an empty peer update for the same session MUST
  // NOT stomp a previously populated list (this would still cause the same
  // flicker even with the cross-session filter, if the bridge ever returns
  // an empty snapshot mid-update for the parent session).
  expect(source).toContain("next.peers.length === 0 && (prev?.peers.length ?? 0) > 0")
  expect(source).toMatch(/setMeshStatus\(\(prev\)/)
})

test("attention-strip: ignores banyancode.mesh.status events from other sessions", () => {
  const source = readFileSync(
    resolve(__dirname, "../../../src/component/attention-strip.tsx"),
    "utf8",
  )
  expect(source).toContain("parentSessionID")
  expect(source).toMatch(/event\.properties\.parentSessionID\s*!==\s*props\.sessionID/)
})

test("session-footer: ignores banyancode.mesh.status events from other sessions", () => {
  const source = readFileSync(
    resolve(__dirname, "../../../src/feature-plugins/footer/session-footer.tsx"),
    "utf8",
  )
  expect(source).toContain("parentSessionID")
  expect(source).toMatch(/event\.properties\.parentSessionID\s*!==\s*currentSessionID/)
})