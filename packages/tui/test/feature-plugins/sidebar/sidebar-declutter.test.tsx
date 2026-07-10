/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { readFileSync } from "fs"
import { resolve } from "path"

/**
 * Regression test for the BANYANTREE / session-id / CODEBASE sidebar declutter.
 *
 * User asked to remove three things from the sidebar:
 *   1. The "BANYANTREE" header label that was always rendered at the top of
 *      the sidebar.
 *   2. The session ID line that was conditionally rendered under the title
 *      when `InstallationChannel !== "latest"`.
 *   3. The entire CODEBASE plugin (codebase-tree) — unregistered from the
 *      built-in TUI plugin list so it no longer shows up under sidebar_content.
 *
 * These assertions verify the removals at the source level:
 *   - sidebar.tsx no longer contains the literal "BANYANTREE".
 *   - sidebar.tsx no longer renders `{props.sessionID}` inside the
 *     sidebar_title fallback.
 *   - sidebar.tsx no longer imports `InstallationChannel` (used only by
 *     the removed session-id conditional).
 *   - builtins.ts no longer imports `SidebarCodebaseTree` and no longer
 *     references it in the createBuiltinPlugins array.
 *
 * The CODEBASE plugin file itself is preserved (other tests still load
 * it directly), but it is no longer wired up to the running TUI.
 */
test("sidebar: BANYANTREE header has been removed", () => {
  const source = readFileSync(
    resolve(__dirname, "../../../src/routes/session/sidebar.tsx"),
    "utf8",
  )
  expect(source).not.toContain("BANYANTREE")
})

test("sidebar: session id is no longer rendered inside the sidebar_title fallback", () => {
  const source = readFileSync(
    resolve(__dirname, "../../../src/routes/session/sidebar.tsx"),
    "utf8",
  )
  // The conditional <Show when={InstallationChannel !== "latest"}> block
  // contained a <text>{props.sessionID}</text>. The InstallationChannel gate
  // and the inner text are gone. Note that `session_id={props.sessionID}` on
  // the slot itself is unrelated — that's a slot prop, not a rendered text.
  expect(source).not.toMatch(/InstallationChannel/)
  expect(source).not.toMatch(/<text[^>]*>\s*\{props\.sessionID\}\s*<\/text>/)
  // Also assert no <text>{props.sessionID} with any whitespace patterns.
  expect(source).not.toMatch(/\{props\.sessionID\}<\/text>/)
})

test("sidebar: InstallationChannel import is no longer pulled in", () => {
  const source = readFileSync(
    resolve(__dirname, "../../../src/routes/session/sidebar.tsx"),
    "utf8",
  )
  // After removing the session-id conditional, InstallationChannel was the
  // only consumer of that import. The import is dropped.
  expect(source).not.toMatch(/import\s+\{[^}]*InstallationChannel[^}]*\}\s+from\s+"@opencode-ai\/core\/installation\/version"/)
})

test("sidebar: close-button row is only rendered when onClose is provided", () => {
  // The BANYANTREE row previously always rendered. After dropping the label,
  // the only remaining purpose of that header row is the close (✕) button for
  // the overlay sidebar. So the whole row must be wrapped in
  // <Show when={props.onClose}> to avoid an empty header row in the
  // persistent sidebar.
  const source = readFileSync(
    resolve(__dirname, "../../../src/routes/session/sidebar.tsx"),
    "utf8",
  )
  // Find the close-button block — must be inside a Show gate.
  const closeButtonPattern = /<text fg=\{theme\.textMuted\} onMouseDown=\{props\.onClose\}>[\s\S]*?✕[\s\S]*?<\/text>/
  expect(source).toMatch(closeButtonPattern)

  // The row containing the ✕ button must be inside a Show when={props.onClose}.
  // We extract the substring that contains the close button and verify it
  // contains the gate.
  const idx = source.search(closeButtonPattern)
  const window = source.slice(Math.max(0, idx - 200), idx + 200)
  expect(window).toMatch(/<Show when=\{props\.onClose\}>/)
})

test("builtins: SidebarCodebaseTree import has been removed", () => {
  const source = readFileSync(
    resolve(__dirname, "../../../src/feature-plugins/builtins.ts"),
    "utf8",
  )
  expect(source).not.toContain("SidebarCodebaseTree")
  expect(source).not.toContain("./sidebar/codebase-tree")
})

test("builtins: SidebarCodebaseTree is no longer in the createBuiltinPlugins list", () => {
  const source = readFileSync(
    resolve(__dirname, "../../../src/feature-plugins/builtins.ts"),
    "utf8",
  )
  // Look inside the createBuiltinPlugins function body for the
  // SidebarCodebaseTree identifier.
  const fnStart = source.indexOf("export function createBuiltinPlugins")
  expect(fnStart).toBeGreaterThan(-1)
  const fnBody = source.slice(fnStart)
  expect(fnBody).not.toContain("SidebarCodebaseTree")
})