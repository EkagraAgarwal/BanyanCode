import path from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { LANGUAGE_EXTENSIONS } from "./language.js"
import { connect, type Connection } from "./jsonrpc.js"
import { normalizePath, readText } from "./fs.js"
import { stop } from "./process.js"
import type { Diagnostic } from "./types.js"

/**
 * LSP client. Port of v1 `packages/opencode/src/lsp/client.ts` with the same
 * push + pull diagnostics behavior, the same debounce/wait windows, and the
 * same initialize capabilities. Only the JSON-RPC transport differs (local
 * framing instead of `vscode-jsonrpc`).
 */

const DIAGNOSTICS_DEBOUNCE_MS = 150
const DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS = 5_000
const DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS = 10_000
const DIAGNOSTICS_REQUEST_TIMEOUT_MS = 3_000
const INITIALIZE_TIMEOUT_MS = 45_000
const REQUEST_TIMEOUT_MS = 30_000

const FILE_CHANGE_CREATED = 1
const FILE_CHANGE_CHANGED = 2
const TEXT_DOCUMENT_SYNC_INCREMENTAL = 2

export class InitializeError extends Error {
  readonly serverID: string
  constructor(serverID: string, cause: unknown) {
    super(`LSP initialize failed for ${serverID}`)
    this.name = "LSPInitializeError"
    this.serverID = serverID
    this.cause = cause
  }
}

type DocumentDiagnosticReport = {
  items?: Diagnostic[]
  relatedDocuments?: Record<string, DocumentDiagnosticReport>
}

type WorkspaceDiagnosticReport = {
  items?: {
    uri?: string
    items?: Diagnostic[]
  }[]
}

type DiagnosticRequestResult = {
  handled: boolean
  matched: boolean
  byFile: Map<string, Diagnostic[]>
}

type CapabilityRegistration = {
  id: string
  method: string
  registerOptions?: {
    identifier?: string
    workspaceDiagnostics?: boolean
  }
}

type ServerCapabilities = {
  textDocumentSync?:
    | number
    | {
        change?: number
      }
  diagnosticProvider?: unknown
  [key: string]: unknown
}

const getFilePath = (uri: string) => {
  if (!uri.startsWith("file://")) return
  return normalizePath(fileURLToPath(uri))
}

const getSyncKind = (capabilities?: ServerCapabilities) => {
  if (!capabilities) return
  const sync = capabilities.textDocumentSync
  if (typeof sync === "number") return sync
  return sync?.change
}

const endPosition = (text: string) => {
  const lines = text.split(/\r\n|\r|\n/)
  return {
    line: lines.length - 1,
    character: lines.at(-1)?.length ?? 0,
  }
}

const dedupeDiagnostics = (items: Diagnostic[]) => {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = JSON.stringify({
      code: item.code,
      severity: item.severity,
      message: item.message,
      source: item.source,
      range: item.range,
    })
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const configurationValue = (settings: unknown, section?: string) => {
  if (!section) return settings ?? null
  const result = section.split(".").reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== "object" || !(key in acc)) return undefined
    return (acc as Record<string, unknown>)[key]
  }, settings)
  return result ?? null
}

/**
 * TypeScript's built-in LSP pushes diagnostics aggressively on first open. We
 * seed the push cache on the very first publish so waitForFreshPush can
 * resolve immediately instead of waiting for a second debounced push.
 */
const shouldSeedDiagnosticsOnFirstPush = (serverID: string) => serverID === "typescript"

export interface CreateInput {
  readonly serverID: string
  readonly server: {
    readonly process: ChildProcessWithoutNullStreams
    readonly initialization?: Record<string, unknown>
  }
  readonly root: string
  readonly directory: string
}

export interface Info {
  readonly root: string
  readonly serverID: string
  readonly connection: Connection
  readonly notify: {
    open(request: { path: string }): Promise<number>
  }
  readonly diagnostics: Map<string, Diagnostic[]>
  waitForDiagnostics(request: {
    path: string
    version: number
    mode?: "document" | "full"
    after?: number
  }): Promise<void>
  shutdown(): Promise<void>
}

export async function create(input: CreateInput): Promise<Info> {
  const connection = connect(input.server.process)

  const pushDiagnostics = new Map<string, Diagnostic[]>()
  const pullDiagnostics = new Map<string, Diagnostic[]>()
  const published = new Map<string, { at: number; version?: number }>()
  const diagnosticRegistrations = new Map<string, CapabilityRegistration>()
  const registrationListeners = new Set<() => void>()
  const diagnosticListeners = new Set<(input: { path: string; serverID: string }) => void>()
  const mergedDiagnostics = (filePath: string) =>
    dedupeDiagnostics([...(pushDiagnostics.get(filePath) ?? []), ...(pullDiagnostics.get(filePath) ?? [])])
  const updatePushDiagnostics = (filePath: string, next: Diagnostic[]) => {
    pushDiagnostics.set(filePath, next)
    for (const listener of diagnosticListeners) listener({ path: filePath, serverID: input.serverID })
  }
  const updatePullDiagnostics = (filePath: string, next: Diagnostic[]) => {
    pullDiagnostics.set(filePath, next)
  }
  const emitRegistrationChange = () => {
    for (const listener of [...registrationListeners]) listener()
  }

  connection.onNotification("textDocument/publishDiagnostics", (params) => {
    const payload = params as {
      uri: string
      version?: number
      diagnostics: Diagnostic[]
    }
    const filePath = getFilePath(payload.uri)
    if (!filePath) return
    published.set(filePath, {
      at: Date.now(),
      version: typeof payload.version === "number" ? payload.version : undefined,
    })
    if (shouldSeedDiagnosticsOnFirstPush(input.serverID) && !pushDiagnostics.has(filePath)) {
      pushDiagnostics.set(filePath, payload.diagnostics)
      return
    }
    updatePushDiagnostics(filePath, payload.diagnostics)
  })
  connection.onRequest("window/workDoneProgress/create", () => null)
  connection.onRequest("workspace/configuration", (params) => {
    const items = (params as { items?: { section?: string }[] }).items ?? []
    return items.map((item) => configurationValue(input.server.initialization, item.section))
  })
  connection.onRequest("client/registerCapability", (params) => {
    const registrations = (params as { registrations?: CapabilityRegistration[] }).registrations ?? []
    let changed = false
    for (const registration of registrations) {
      if (registration.method !== "textDocument/diagnostic") continue
      diagnosticRegistrations.set(registration.id, registration)
      changed = true
    }
    if (changed) emitRegistrationChange()
    return null
  })
  connection.onRequest("client/unregisterCapability", (params) => {
    const registrations = (params as { unregisterations?: { id: string; method: string }[] }).unregisterations ?? []
    let changed = false
    for (const registration of registrations) {
      if (registration.method !== "textDocument/diagnostic") continue
      diagnosticRegistrations.delete(registration.id)
      changed = true
    }
    if (changed) emitRegistrationChange()
    return null
  })
  connection.onRequest("workspace/workspaceFolders", () => [
    {
      name: "workspace",
      uri: pathToFileURL(input.root).href,
    },
  ])
  connection.onRequest("workspace/diagnostic/refresh", () => null)

  const initialized = await connection
    .request<{ capabilities?: ServerCapabilities }>(
      "initialize",
      {
        rootUri: pathToFileURL(input.root).href,
        processId: input.server.process.pid,
        workspaceFolders: [
          {
            name: "workspace",
            uri: pathToFileURL(input.root).href,
          },
        ],
        initializationOptions: {
          ...input.server.initialization,
        },
        capabilities: {
          window: {
            workDoneProgress: true,
          },
          workspace: {
            configuration: true,
            didChangeWatchedFiles: {
              dynamicRegistration: true,
            },
            diagnostics: {
              refreshSupport: false,
            },
          },
          textDocument: {
            synchronization: {
              didOpen: true,
              didChange: true,
            },
            diagnostic: {
              dynamicRegistration: true,
              relatedDocumentSupport: true,
            },
            publishDiagnostics: {
              versionSupport: false,
            },
          },
        },
      },
      INITIALIZE_TIMEOUT_MS,
    )
    .catch((error) => {
      throw new InitializeError(input.serverID, error)
    })

  const syncKind = getSyncKind(initialized.capabilities)
  const hasStaticPullDiagnostics = Boolean(initialized.capabilities?.diagnosticProvider)

  await connection.notify("initialized", {})

  if (input.server.initialization) {
    await connection.notify("workspace/didChangeConfiguration", {
      settings: input.server.initialization,
    })
  }

  const files: Record<string, { version: number; text: string }> = {}

  const mergeResults = (filePath: string, results: DiagnosticRequestResult[]) => {
    const handled = results.some((result) => result.handled)
    const matched = results.some((result) => result.matched)
    if (!handled) return { handled: false, matched: false }

    const merged = new Map<string, Diagnostic[]>()
    for (const result of results) {
      for (const [target, items] of result.byFile.entries()) {
        const existing = merged.get(target) ?? []
        merged.set(target, existing.concat(items))
      }
    }

    if (matched && !merged.has(filePath)) merged.set(filePath, [])
    for (const [target, items] of merged.entries()) {
      updatePullDiagnostics(target, dedupeDiagnostics(items))
    }

    return { handled, matched }
  }

  const requestDiagnosticReport = async (filePath: string, identifier?: string): Promise<DiagnosticRequestResult> => {
    const report = await connection
      .request<DocumentDiagnosticReport | null>(
        "textDocument/diagnostic",
        {
          ...(identifier ? { identifier } : {}),
          textDocument: {
            uri: pathToFileURL(filePath).href,
          },
        },
        DIAGNOSTICS_REQUEST_TIMEOUT_MS,
      )
      .catch(() => null)
    if (!report) return { handled: false, matched: false, byFile: new Map<string, Diagnostic[]>() }

    const byFile = new Map<string, Diagnostic[]>()
    const push = (target: string, items: Diagnostic[]) => {
      const existing = byFile.get(target) ?? []
      byFile.set(target, existing.concat(items))
    }

    let handled = false
    let matched = false
    if (Array.isArray(report.items)) {
      push(filePath, report.items)
      handled = true
      matched = true
    }
    for (const [uri, related] of Object.entries(report.relatedDocuments ?? {})) {
      const relatedPath = getFilePath(uri)
      if (!relatedPath || !Array.isArray(related.items)) continue
      push(relatedPath, related.items)
      handled = true
      matched = matched || relatedPath === filePath
    }

    return { handled, matched, byFile }
  }

  const requestWorkspaceDiagnosticReport = async (
    filePath: string,
    identifier?: string,
  ): Promise<DiagnosticRequestResult> => {
    const report = await connection
      .request<WorkspaceDiagnosticReport | null>(
        "workspace/diagnostic",
        {
          ...(identifier ? { identifier } : {}),
          previousResultIds: [],
        },
        DIAGNOSTICS_REQUEST_TIMEOUT_MS,
      )
      .catch(() => null)
    if (!report) return { handled: false, matched: false, byFile: new Map<string, Diagnostic[]>() }

    const byFile = new Map<string, Diagnostic[]>()
    let matched = false
    for (const item of report.items ?? []) {
      const relatedPath = item.uri ? getFilePath(item.uri) : undefined
      if (!relatedPath || !Array.isArray(item.items)) continue
      const existing = byFile.get(relatedPath) ?? []
      byFile.set(relatedPath, existing.concat(item.items))
      matched = matched || relatedPath === filePath
    }

    return { handled: true, matched, byFile }
  }

  const documentPullState = () => {
    const documentRegistrations = [...diagnosticRegistrations.values()].filter(
      (registration) => registration.registerOptions?.workspaceDiagnostics !== true,
    )
    return {
      documentIdentifiers: [
        ...new Set(documentRegistrations.flatMap((registration) => registration.registerOptions?.identifier ?? [])),
      ],
      supported: hasStaticPullDiagnostics || documentRegistrations.length > 0,
    }
  }

  const workspacePullState = () => {
    const workspaceRegistrations = [...diagnosticRegistrations.values()].filter(
      (registration) => registration.registerOptions?.workspaceDiagnostics === true,
    )
    return {
      workspaceIdentifiers: [
        ...new Set(workspaceRegistrations.flatMap((registration) => registration.registerOptions?.identifier ?? [])),
      ],
      supported: workspaceRegistrations.length > 0,
    }
  }

  const hasCurrentFileDiagnostics = (filePath: string, results: DiagnosticRequestResult[]) =>
    results.some((result) => (result.byFile.get(filePath)?.length ?? 0) > 0)

  const requestDiagnostics = async (
    filePath: string,
    requests: Promise<DiagnosticRequestResult>[],
    done: (results: DiagnosticRequestResult[]) => boolean,
  ) => {
    if (!requests.length) return { handled: false, matched: false }

    const results: DiagnosticRequestResult[] = []
    return new Promise<{ handled: boolean; matched: boolean }>((resolve) => {
      let pending = requests.length
      let resolved = false
      const finish = (merged: { handled: boolean; matched: boolean }, force = false) => {
        if (resolved) return
        if (!force && !done(results)) return
        resolved = true
        resolve(merged)
      }

      for (const request of requests) {
        request.then((result) => {
          results.push(result)
          pending -= 1
          const merged = mergeResults(filePath, results)
          finish(merged)
          if (pending === 0) finish(merged, true)
        })
      }
    })
  }

  // LATENCY-CRITICAL: dispatch identifier pulls in parallel and unblock once one
  // batch already produced diagnostics for the current file. Let slower pulls
  // keep merging in the background; do not sequence identifier-by-identifier,
  // and do not add a post-match settle/debounce delay.
  const requestDocumentDiagnostics = async (filePath: string) => {
    const state = documentPullState()
    if (!state.supported) return { handled: false, matched: false }
    return requestDiagnostics(
      filePath,
      [
        requestDiagnosticReport(filePath),
        ...state.documentIdentifiers.map((identifier) => requestDiagnosticReport(filePath, identifier)),
      ],
      (results) => hasCurrentFileDiagnostics(filePath, results),
    )
  }

  const requestFullDiagnostics = async (filePath: string) => {
    const documentState = documentPullState()
    const workspaceState = workspacePullState()
    if (!documentState.supported && !workspaceState.supported) return { handled: false, matched: false }
    return mergeResults(
      filePath,
      await Promise.all([
        ...(documentState.supported ? [requestDiagnosticReport(filePath)] : []),
        ...documentState.documentIdentifiers.map((identifier) => requestDiagnosticReport(filePath, identifier)),
        ...(workspaceState.supported ? [requestWorkspaceDiagnosticReport(filePath)] : []),
        ...workspaceState.workspaceIdentifiers.map((identifier) =>
          requestWorkspaceDiagnosticReport(filePath, identifier),
        ),
      ]),
    )
  }

  const waitForRegistrationChange = (timeout: number) => {
    if (timeout <= 0) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      let finished = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (result: boolean) => {
        if (finished) return
        finished = true
        if (timer) clearTimeout(timer)
        registrationListeners.delete(listener)
        resolve(result)
      }
      const listener = () => finish(true)
      registrationListeners.add(listener)
      timer = setTimeout(() => finish(false), timeout)
      timer.unref?.()
    })
  }

  const waitForFreshPush = (request: { path: string; version: number; after: number; timeout: number }) => {
    if (request.timeout <= 0) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      let finished = false
      let debounceTimer: ReturnType<typeof setTimeout> | undefined
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined
      let unsub: (() => void) | undefined
      const finish = (result: boolean) => {
        if (finished) return
        finished = true
        if (debounceTimer) clearTimeout(debounceTimer)
        if (timeoutTimer) clearTimeout(timeoutTimer)
        unsub?.()
        resolve(result)
      }
      const schedule = () => {
        const hit = published.get(request.path)
        if (!hit) return
        if (typeof hit.version === "number" && hit.version !== request.version) return
        if (hit.at < request.after && hit.version !== request.version) return
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => finish(true), Math.max(0, DIAGNOSTICS_DEBOUNCE_MS - (Date.now() - hit.at)))
        debounceTimer.unref?.()
      }

      timeoutTimer = setTimeout(() => finish(false), request.timeout)
      timeoutTimer.unref?.()
      const listener = (event: { path: string; serverID: string }) => {
        if (event.path !== request.path || event.serverID !== input.serverID) return
        schedule()
      }
      diagnosticListeners.add(listener)
      unsub = () => diagnosticListeners.delete(listener)
      schedule()
    })
  }

  const waitForDocumentDiagnostics = async (request: { path: string; version: number; after?: number }) => {
    const startedAt = request.after ?? Date.now()
    const pushWait = waitForFreshPush({
      path: request.path,
      version: request.version,
      after: startedAt,
      timeout: DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS,
    })

    while (Date.now() - startedAt < DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS) {
      const result = await requestDocumentDiagnostics(request.path)
      if (result.matched) return
      const remaining = DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS - (Date.now() - startedAt)
      if (remaining <= 0) return
      const next = await Promise.race([
        pushWait.then((ready) => (ready ? "push" : ("timeout" as const))),
        waitForRegistrationChange(remaining).then((changed) => (changed ? "registration" : ("timeout" as const))),
      ])
      if (next !== "registration") return
    }
  }

  const waitForFullDiagnostics = async (request: { path: string; version: number; after?: number }) => {
    const startedAt = request.after ?? Date.now()
    const pushWait = waitForFreshPush({
      path: request.path,
      version: request.version,
      after: startedAt,
      timeout: DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS,
    })

    while (Date.now() - startedAt < DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS) {
      const result = await requestFullDiagnostics(request.path)
      if (result.handled || result.matched) return
      const remaining = DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS - (Date.now() - startedAt)
      if (remaining <= 0) return
      const next = await Promise.race([
        pushWait.then((ready) => (ready ? "push" : ("timeout" as const))),
        waitForRegistrationChange(remaining).then((changed) => (changed ? "registration" : ("timeout" as const))),
      ])
      if (next !== "registration") return
    }
  }

  return {
    root: input.root,
    serverID: input.serverID,
    connection: {
      ...connection,
      request: <T = unknown>(method: string, params?: unknown, timeoutMs = REQUEST_TIMEOUT_MS) =>
        connection.request<T>(method, params, timeoutMs),
    },
    notify: {
      async open(request) {
        const target = normalizePath(path.isAbsolute(request.path) ? request.path : path.resolve(input.directory, request.path))
        const text = await readText(target)
        const languageId = LANGUAGE_EXTENSIONS[path.extname(target)] ?? "plaintext"

        const document = files[target]
        if (document !== undefined) {
          // Do not wipe diagnostics on didChange. Some servers (e.g. clangd) only
          // re-emit diagnostics when the content actually changes, so clearing
          // here would lose errors for no-op touchFile calls.
          await connection.notify("workspace/didChangeWatchedFiles", {
            changes: [
              {
                uri: pathToFileURL(target).href,
                type: FILE_CHANGE_CHANGED,
              },
            ],
          })

          const next = document.version + 1
          files[target] = { version: next, text }
          await connection.notify("textDocument/didChange", {
            textDocument: {
              uri: pathToFileURL(target).href,
              version: next,
            },
            contentChanges:
              syncKind === TEXT_DOCUMENT_SYNC_INCREMENTAL
                ? [
                    {
                      range: {
                        start: { line: 0, character: 0 },
                        end: endPosition(document.text),
                      },
                      text,
                    },
                  ]
                : [{ text }],
          })
          return next
        }

        await connection.notify("workspace/didChangeWatchedFiles", {
          changes: [
            {
              uri: pathToFileURL(target).href,
              type: FILE_CHANGE_CREATED,
            },
          ],
        })

        pushDiagnostics.delete(target)
        pullDiagnostics.delete(target)
        await connection.notify("textDocument/didOpen", {
          textDocument: {
            uri: pathToFileURL(target).href,
            languageId,
            version: 0,
            text,
          },
        })
        files[target] = { version: 0, text }
        return 0
      },
    },
    get diagnostics() {
      const result = new Map<string, Diagnostic[]>()
      for (const key of new Set([...pushDiagnostics.keys(), ...pullDiagnostics.keys()])) {
        result.set(key, mergedDiagnostics(key))
      }
      return result
    },
    async waitForDiagnostics(request) {
      const target = normalizePath(path.isAbsolute(request.path) ? request.path : path.resolve(input.directory, request.path))
      if (request.mode === "document") {
        await waitForDocumentDiagnostics({ path: target, version: request.version, after: request.after })
        return
      }
      await waitForFullDiagnostics({ path: target, version: request.version, after: request.after })
    },
    async shutdown() {
      connection.dispose()
      await stop(input.server.process)
    },
  }
}
