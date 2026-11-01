// Shared argv assembly for the `banyancode mcp` passthrough handlers.
//
// The command implementation lives in `@banyancode/mcp` (it must also work
// when the package is embedded elsewhere), so the CLI only translates parsed
// flags back into the argv it understands.

export function baseArgs(input: { cwd?: string; config?: string; permission?: string }): string[] {
  const argv: string[] = []
  argv.push("--cwd", input.cwd ?? process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd())
  if (input.config !== undefined && input.config !== "") argv.push("--config", input.config)
  if (input.permission !== undefined) argv.push("--permission", input.permission)
  return argv
}
