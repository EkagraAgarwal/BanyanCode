// Dual-era protocol harness (gap-plan D0): every protocol suite runs TWICE.
//
// - legacy: a 2025-era client that opens with `initialize`, over the SDK's
//   InMemoryTransport linked pair against a hand-wired McpServer (which serves
//   the 2025 era only — exactly what the old SDK did).
// - modern: a 2026-07-28 client (pinned, so no silent fallback) that opens
//   with `server/discover` and sends per-request `_meta` on every call,
//   driven in-process through `createMcpHandler` with the documented
//   fetch-shim transport (no sockets).
//
// The same `buildServer` factory feeds both legs: registration is pure
// (closures over the shared sdk/engine deps), and one engine serves both
// surfaces. The negotiated era is asserted after connect, so a test can only
// pass in the era it claims — a modern test that silently fell back to
// `initialize` fails here, not deeper in the assertions.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { InMemoryTransport, McpServer, createMcpHandler } from "@modelcontextprotocol/server"

export type McpEra = "legacy" | "modern"
export const MCP_ERAS: readonly McpEra[] = ["legacy", "modern"]
export const MODERN_PROTOCOL_VERSION = "2026-07-28"

export type McpClientInfo = { name: string; version: string }

const assertEra = (client: Client, era: McpEra): void => {
  const negotiated = client.getProtocolEra()
  if (negotiated !== era) {
    throw new Error(`expected ${era} era, negotiated ${String(negotiated)}`)
  }
}

const tagEra = (era: McpEra, error: unknown): unknown => {
  if (error instanceof Error && !error.message.startsWith(`[mcp era=${era}]`)) {
    const tagged = new Error(`[mcp era=${era}] ${error.message}`, { cause: error })
    tagged.stack = error.stack
    return tagged
  }
  return error
}

export async function withEraClient<A>(
  era: McpEra,
  buildServer: () => McpServer,
  clientInfo: McpClientInfo,
  body: (client: Client) => Promise<A>,
): Promise<A> {
  if (era === "legacy") {
    const mcp = buildServer()
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client(clientInfo)
    // Server first: client.connect sends `initialize` and waits for the
    // response, so connecting the client before the server deadlocks (the
    // server side would never get to drain the queued message).
    await mcp.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      assertEra(client, era)
      return await body(client)
    } catch (error) {
      throw tagEra(era, error)
    } finally {
      await client.close().catch(() => {})
      await mcp.close().catch(() => {})
    }
  }
  const handler = createMcpHandler(() => buildServer())
  const transport = new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  })
  const client = new Client(clientInfo, { versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } } })
  await client.connect(transport)
  try {
    assertEra(client, era)
    return await body(client)
  } catch (error) {
    throw tagEra(era, error)
  } finally {
    await client.close().catch(() => {})
    await handler.close().catch(() => {})
  }
}

// Run `body` once per era against a freshly built server each time, so one
// protocol test covers both the `initialize` and the `server/discover` +
// per-request-`_meta` paths. Failures are tagged with the era that failed.
export async function forEachEra<A>(
  buildServer: () => McpServer,
  clientInfo: McpClientInfo,
  body: (client: Client) => Promise<A>,
): Promise<void> {
  for (const era of MCP_ERAS) {
    await withEraClient(era, buildServer, clientInfo, body)
  }
}

export * as McpEraHarness from "./era-harness"
