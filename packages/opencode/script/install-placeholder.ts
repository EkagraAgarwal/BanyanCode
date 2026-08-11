/**
 * Generates the placeholder `bin/banyancode.exe` script shipped inside the
 * umbrella `banyancode` npm package. The real binary is written by
 * `postinstall.mjs`; this placeholder only runs when lifecycle scripts were
 * skipped (--ignore-scripts, npm 11 allow-scripts, pnpm defaults) and exists
 * to print an actionable error instead of a raw spawn failure.
 *
 * The tarball shape must stay platform-invariant (the bin entry is always
 * `bin/banyancode.exe`, and postinstall.mjs always writes the real binary
 * there), but the placeholder CONTENT may differ per platform:
 * - win32 keeps cmd-compatible batch lines (no shebang — cmd shims invoke the
 *   file directly and `exit 1` works in cmd).
 * - darwin/linux get a `#!/bin/sh` shebang first line so posix_spawn execs
 *   the script cleanly instead of surfacing ENOEXEC.
 */
export function placeholderScript(platform: NodeJS.Platform): string {
  const lines = [
    `echo "Error: banyancode's postinstall script was not run." >&2`,
    `echo "" >&2`,
    `echo "npm 11+ blocks lifecycle scripts unless they are approved. Install or" >&2`,
    `echo "upgrade banyancode with the allow-scripts flag:" >&2`,
    `echo "  npm install -g --allow-scripts=banyancode banyancode" >&2`,
    `echo "  npm config set allow-scripts=banyancode --location=user" >&2`,
    `echo "" >&2`,
    `echo "This also occurs with --ignore-scripts, or with package managers like" >&2`,
    `echo "pnpm that skip postinstall by default (approve banyancode with pnpm" >&2`,
    `echo "approve-builds or an onlyBuiltDependencies entry)." >&2`,
    `echo "" >&2`,
    `echo "To fix this install, run the postinstall script manually:" >&2`,
    `echo "  cd node_modules/banyancode && node postinstall.mjs" >&2`,
    `echo "" >&2`,
    `echo "Or reinstall banyancode without the --ignore-scripts flag." >&2`,
    `exit 1`,
    ``,
  ]
  const body = lines.join("\n")
  return platform === "win32" ? body : `#!/bin/sh\n${body}`
}
