/**
 * Minimal stdio LSP fixture used by the runtime tests. Speaks Content-Length
 * framed JSON-RPC, publishes diagnostics on didOpen/didChange, and answers the
 * queries the `lsp` tool issues. Written in TS so `bun test` can spawn it with
 * `process.execPath` offline (no real language server install needed).
 *
 * Diagnostics are derived from the document text:
 * - contains "BAD" -> one ERROR at 1:1 ("fixture: BAD token found")
 * - contains "WARN" -> one WARN at 1:1
 * Exit code 0 on `exit`; the pid file lets tests prove the process is gone.
 */

import { appendFileSync, writeFileSync } from "node:fs"

interface Message {
  jsonrpc: "2.0"
  id?: number | string | null
  method?: string
  params?: any
  result?: unknown
  error?: { code: number; message: string }
}

const pidFile = process.argv[2]
if (pidFile) writeFileSync(pidFile, String(process.pid), "utf8")
const logFile = process.env.FIXTURE_LOG

const log = (line: string) => {
  if (!logFile) return
  try {
    appendFileSync(logFile, line + "\n")
  } catch {}
}

const send = (message: Message) => {
  const body = Buffer.from(JSON.stringify(message), "utf8")
  process.stdout.write(`Content-Length: ${body.byteLength}\r\n\r\n`)
  process.stdout.write(body)
}

const uriToPath = (uri: string) => {
  try {
    return decodeURIComponent(new URL(uri).pathname).replace(/^\/([A-Za-z]:)/, "$1")
  } catch {
    return uri
  }
}

const documents = new Map<string, { text: string; version: number }>()
const diagnosticsFor = (uri: string, text: string, version: number) => {
  const items: unknown[] = []
  if (text.includes("BAD")) {
    items.push({
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
      severity: 1,
      message: "fixture: BAD token found",
      source: "fixture",
    })
  }
  if (text.includes("WARN")) {
    items.push({
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
      severity: 2,
      message: "fixture: WARN token found",
      source: "fixture",
    })
  }
  return { uri, version, diagnostics: items }
}

const publish = (uri: string, version: number) => {
  const document = documents.get(uri)
  if (!document) return
  send({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: diagnosticsFor(uri, document.text, version),
  })
}

let initializationOptions: unknown
let rootUri: string | undefined

const handle = (message: Message) => {
  const method = message.method
  if (!method) return
  const params = message.params ?? {}
  log(method)

  if (method === "initialize") {
    initializationOptions = params.initializationOptions
    rootUri = params.rootUri
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        capabilities: {
          textDocumentSync: 1,
          hoverProvider: true,
          definitionProvider: true,
          referencesProvider: true,
          implementationProvider: true,
          documentSymbolProvider: true,
          workspaceSymbolProvider: true,
          callHierarchyProvider: true,
        },
        serverInfo: { name: "banyancode-lsp-fixture", version: "1.0.0" },
      },
    })
    return
  }
  if (method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: null })
    return
  }
  if (method === "exit") {
    process.exit(0)
  }
  if (method === "textDocument/didOpen") {
    documents.set(params.textDocument.uri, { text: params.textDocument.text, version: params.textDocument.version })
    publish(params.textDocument.uri, params.textDocument.version)
    return
  }
  if (method === "textDocument/didChange") {
    const document = documents.get(params.textDocument.uri)
    const text = params.contentChanges?.[0]?.text ?? document?.text ?? ""
    documents.set(params.textDocument.uri, { text, version: params.textDocument.version })
    publish(params.textDocument.uri, params.textDocument.version)
    return
  }
  if (method === "textDocument/hover") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { contents: { kind: "plaintext", value: "fixture hover" } },
    })
    return
  }
  if (method === "textDocument/definition") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: [
        {
          uri: params.textDocument.uri,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
        },
      ],
    })
    return
  }
  if (method === "textDocument/references" || method === "textDocument/implementation") {
    send({ jsonrpc: "2.0", id: message.id, result: [] })
    return
  }
  if (method === "textDocument/documentSymbol") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: [
        {
          name: "fixtureSymbol",
          kind: 12,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
          selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
        },
      ],
    })
    return
  }
  if (method === "workspace/symbol") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: [
        {
          name: `fixture:${params.query ?? ""}`,
          kind: 12,
          location: {
            uri: rootUri ?? "file:///fixture",
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
          },
        },
        { name: "wrongKind", kind: 1, location: { uri: rootUri ?? "file:///fixture", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } } },
      ],
    })
    return
  }
  if (method === "textDocument/prepareCallHierarchy") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: [
        {
          name: "fixtureFn",
          kind: 12,
          uri: params.textDocument.uri,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
          selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
        },
      ],
    })
    return
  }
  if (method === "callHierarchy/incomingCalls" || method === "callHierarchy/outgoingCalls") {
    send({ jsonrpc: "2.0", id: message.id, result: [] })
    return
  }
  if (method === "fixture/initialization") {
    send({ jsonrpc: "2.0", id: message.id, result: { initializationOptions, rootUri } })
    return
  }
  if (method === "fixture/documents") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: [...documents.entries()].map(([uri, document]) => ({ uri, path: uriToPath(uri), ...document })),
    })
    return
  }
  // Server-to-client request used to prove the transport answers requests.
  if (method === "fixture/workspaceFolders") {
    send({ jsonrpc: "2.0", id: message.id, result: null })
    return
  }

  if (message.id !== undefined && message.id !== null) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `no handler for ${method}` } })
  }
}

let buffer = Buffer.alloc(0)
process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk])
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n")
    if (headerEnd < 0) return
    const header = buffer.subarray(0, headerEnd).toString("ascii")
    const match = /content-length:\s*(\d+)/i.exec(header)
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4)
      continue
    }
    const length = Number.parseInt(match[1]!, 10)
    const start = headerEnd + 4
    if (buffer.byteLength < start + length) return
    const body = buffer.subarray(start, start + length).toString("utf8")
    buffer = buffer.subarray(start + length)
    try {
      handle(JSON.parse(body) as Message)
    } catch {
      // Keep the fixture alive on malformed frames.
    }
  }
})

process.stdin.on("end", () => process.exit(0))
