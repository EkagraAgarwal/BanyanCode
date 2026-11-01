// Stdout belongs to the MCP protocol in stdio mode. Every diagnostic goes to
// stderr so no non-JSON-RPC bytes ever land on the wire.
export function log(message: string): void {
  process.stderr.write(`[banyancode-mcp] ${message}\n`)
}

export const Log = { log } as const
