/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { Context, KeymapCommand } from "@opencode/plugin/tui/context"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import BanyanTui from "../src/tui"
import { context } from "./harness"

const transcript = `# Imported from Markdown

**Created:** 2026-01-15T10:30:00.000Z

---

## User

Hello from the transcript.

---

## Assistant (Build · provider/model · 1.0s)

Hello back.

---

## User

Thanks.
`

function recordingContext(directory: string) {
  const toasts: Array<{ readonly message: string; readonly variant?: string }> = []
  const navigated: unknown[] = []
  const imported: unknown[] = []
  const commands: KeymapCommand[] = []
  const base = context()
  const stub = { events: { on: () => () => {}, subscribe: () => () => {} } }
  const proxy = new Proxy(stub, {
    get: (target, property) => {
      if (property in target) return (target as Record<string | symbol, unknown>)[property]
      if (typeof property !== "string") return undefined
      return async () => {
        throw { type: "rpc.unavailable", message: "stub" }
      }
    },
  })
  const value = {
    ...base,
    location: { directory },
    client: {
      rpc: () => proxy,
      experimental: {
        session: {
          import: async (input: unknown) => {
            imported.push(input)
            return { id: "ses_imported", title: "Imported from Markdown" }
          },
        },
      },
    },
    keymap: {
      ...base.keymap,
      layer: (factory: () => { readonly commands?: readonly KeymapCommand[] }) => {
        commands.push(...(factory().commands ?? []))
      },
    },
    ui: {
      ...base.ui,
      toast: { show: (options: { readonly message: string; readonly variant?: string }) => toasts.push(options) },
      router: {
        ...base.ui.router,
        navigate: (destination: unknown) => navigated.push(destination),
      },
    },
  } as unknown as Context
  return { context: value, toasts, navigated, imported, commands }
}

async function runImport(input: string) {
  const directory = await mkdtemp(join(tmpdir(), "banyancode-import-"))
  try {
    const file = join(directory, "session.md")
    await Bun.write(file, transcript)
    const recorded = recordingContext(directory)
    const cleanup = BanyanTui.setup(recorded.context)
    try {
      const command = recorded.commands.find((item) => item.id === "session.import")
      expect(command).toBeDefined()
      await command!.run(input === "*" ? file : join(directory, "missing.md"))
    } finally {
      if (typeof cleanup === "function") cleanup()
    }
    return recorded
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test("/import reads a transcript, imports it and opens the new session", async () => {
  const recorded = await runImport("*")
  expect(recorded.imported).toHaveLength(1)
  const payload = recorded.imported[0] as {
    readonly info: { readonly title: string; readonly agent: string }
    readonly messages: readonly unknown[]
    readonly location: { readonly directory: string }
  }
  expect(payload.info.title).toBe("Imported from Markdown")
  expect(payload.info.agent).toBe("Build")
  expect(payload.messages).toHaveLength(3)
  expect(payload.location.directory).toContain("banyancode-import-")
  expect(recorded.toasts.at(-1)?.variant).toBe("success")
  expect(recorded.toasts.at(-1)?.message).toContain("Imported 3 messages")
  expect(recorded.navigated).toEqual([{ type: "session", sessionID: "ses_imported" }])
})

test("/import reports a clear error when the file cannot be read", async () => {
  const recorded = await runImport("missing")
  expect(recorded.imported).toEqual([])
  expect(recorded.toasts.at(-1)?.variant).toBe("error")
  expect(recorded.toasts.at(-1)?.message).toContain("Import failed")
})
