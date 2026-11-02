import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { EOL } from "node:os"
import path from "node:path"
import { errorLine } from "../../src/framework/error"
import { cli, fakeServer, rpcOutput, tmpRoot } from "./fixture"

const sessionInfo = {
  id: "ses_export_test",
  projectID: "global",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
  title: "Exported session",
  location: { directory: "/project" },
}

const transfer = {
  info: sessionInfo,
  messages: [{ id: "msg_first", type: "user", text: "First", time: { created: 1 } }],
}

async function cleanup(root: string) {
  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
}

describe("CLI error reporting", () => {
  test("unknown command prints one message with a hint", async () => {
    const root = await tmpRoot("banyancode-cli-unknown-")
    try {
      const result = await cli(root, ["bogus-command"])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('Unknown command "bogus-command"')
      expect(result.stderr).toContain("--help")
      expect(result.stderr).not.toContain("chdir")
      expect(result.stderr).not.toMatch(/^\s+at /m)
    } finally {
      await cleanup(root)
    }
  }, 120_000)

  test("invalid enum flag prints one line, not a stack", async () => {
    const root = await tmpRoot("banyancode-cli-invalid-")
    try {
      const result = await cli(root, ["--log-level", "bogus"])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('Invalid value for flag --log-level: "bogus"')
      expect(result.stderr).not.toMatch(/^\s+at /m)
      expect(result.stderr).not.toContain("CliError/InvalidValue")
    } finally {
      await cleanup(root)
    }
  }, 120_000)

  test("completion accepts the v1 spelling and defaults to bash", async () => {
    const root = await tmpRoot("banyancode-cli-completion-")
    try {
      const explicit = await cli(root, ["completion", "bash"])
      expect(explicit.exitCode).toBe(0)
      expect(explicit.stdout).toContain("banyancode")
      expect(explicit.stderr).toBe("")

      const implicit = await cli(root, ["completion"])
      expect(implicit.exitCode).toBe(0)
      expect(implicit.stdout).toBe(explicit.stdout)
    } finally {
      await cleanup(root)
    }
  }, 120_000)

  test("top-level export aliases session export", async () => {
    const root = await tmpRoot("banyancode-cli-export-")
    const fake = fakeServer((_request, url) =>
      url.pathname === `/api/experimental/session/${sessionInfo.id}/export`
        ? Response.json({ data: transfer })
        : undefined,
    )
    try {
      const result = await cli(root, ["export", sessionInfo.id, "--server", fake.url])
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual(transfer)
    } finally {
      fake.stop()
      await cleanup(root)
    }
  }, 120_000)

  test("top-level import aliases session import", async () => {
    const root = await tmpRoot("banyancode-cli-import-")
    const file = path.join(root, "session.json")
    await fs.writeFile(file, JSON.stringify(transfer))
    let imported: unknown
    const fake = fakeServer(async (request, url) => {
      if (url.pathname === "/api/location")
        return Response.json({ directory: root, project: { id: "global", directory: root, canonical: root } })
      if (url.pathname === "/api/experimental/session/import") {
        imported = await request.json()
        return Response.json({ data: { ...sessionInfo, location: { directory: root } } })
      }
      return undefined
    })
    try {
      const result = await cli(root, ["import", file, "--server", fake.url])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe(`Imported session: ${sessionInfo.id}${EOL}`)
      expect(imported).toMatchObject({ ...transfer, location: { directory: root } })
    } finally {
      fake.stop()
      await cleanup(root)
    }
  }, 120_000)

  test("malformed session import explains the expected shape without a stack", async () => {
    const root = await tmpRoot("banyancode-cli-import-bad-")
    const file = path.join(root, "bad.json")
    await fs.writeFile(file, "{ not json")
    try {
      const result = await cli(root, ["session", "import", file])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("Invalid session export")
      expect(result.stderr).toContain("banyancode session export")
      expect(result.stderr).not.toMatch(/^\s+at /m)

      const missing = await cli(root, ["session", "import", path.join(root, "does-not-exist.json")])
      expect(missing.exitCode).toBe(1)
      expect(missing.stderr).toContain("Failed to read session data")
      expect(missing.stderr).not.toMatch(/^\s+at /m)
    } finally {
      await cleanup(root)
    }
  }, 120_000)

  test("an unsupported session export reports the server message without a stack", async () => {
    const root = await tmpRoot("banyancode-cli-import-unsupported-")
    const file = path.join(root, "session.json")
    await fs.writeFile(file, JSON.stringify(transfer))
    const fake = fakeServer((request, url) => {
      if (url.pathname === "/api/location")
        return Response.json({ directory: root, project: { id: "global", directory: root, canonical: root } })
      if (url.pathname === "/api/experimental/session/import" && request.method === "POST")
        return Response.json(
          { _tag: "InvalidRequestError", kind: "Payload", message: 'Expected a session at ["messages"][0]' },
          { status: 400 },
        )
      return undefined
    })
    try {
      const result = await cli(root, ["session", "import", file, "--server", fake.url])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('Failed to import session: Expected a session at ["messages"][0]')
      expect(result.stderr).not.toMatch(/^\s+at /m)
    } finally {
      fake.stop()
      await cleanup(root)
    }
  }, 120_000)

  test("config diagnostics from the plugin are printed as warnings", async () => {
    const root = await tmpRoot("banyancode-cli-config-")
    const fake = fakeServer((_request, url) =>
      url.pathname === "/api/rpc/banyancode/config.get"
        ? rpcOutput({
            config: {},
            sources: ["/p/banyancode.json"],
            unknownKeys: [{ file: "/p/banyancode.json", keys: ["banyancode_bogus_key"] }],
            errors: [{ file: "/p/banyancode.json", message: "invalid JSON/JSONC: Unexpected token" }],
          })
        : undefined,
    )
    try {
      const result = await cli(root, ["tools", "--server", fake.url])
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toContain("Warning: /p/banyancode.json: invalid JSON/JSONC: Unexpected token")
      expect(result.stderr).toContain('Warning: /p/banyancode.json: unknown key "banyancode_bogus_key"')
    } finally {
      fake.stop()
      await cleanup(root)
    }
  }, 120_000)

  test("warns that BANYANCODE_ENABLE=0 cannot apply to an explicit server", async () => {
    const root = await tmpRoot("banyancode-cli-disabled-server-")
    const fake = fakeServer((_request, url) =>
      url.pathname === "/api/rpc/banyancode.codegraph/status"
        ? rpcOutput({ databasePath: "/db" })
        : undefined,
    )
    try {
      const result = await cli(root, ["codegraph", "path", "--server", fake.url], {
        env: { BANYANCODE_ENABLE: "0" },
      })
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toContain("Warning: BANYANCODE_ENABLE=0 cannot be applied")
      expect(result.stderr).toContain("/db")
    } finally {
      fake.stop()
      await cleanup(root)
    }
  }, 120_000)

  test("debug config warns about banyancode.json diagnostics", async () => {
    const root = await tmpRoot("banyancode-cli-debug-config-")
    const fake = fakeServer((_request, url) => {
      if (url.pathname === "/api/rpc/banyancode/config.get")
        return rpcOutput({
          config: {},
          sources: ["/p/banyancode.json"],
          unknownKeys: [{ file: "/p/banyancode.json", keys: ["banyancode_bogus_key"] }],
          errors: [],
        })
      if (url.pathname === "/api/config") return Response.json([])
      return undefined
    })
    try {
      const result = await cli(root, ["debug", "config", "--server", fake.url])
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toContain('Warning: /p/banyancode.json: unknown key "banyancode_bogus_key"')
      expect(JSON.parse(result.stdout)).toEqual([])
    } finally {
      fake.stop()
      await cleanup(root)
    }
  }, 120_000)

  test("tools rejects an unknown category instead of printing nothing", async () => {
    const root = await tmpRoot("banyancode-cli-tools-category-")
    try {
      const result = await cli(root, ["tools", "--category", "Bogus"])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('Unknown category "Bogus"')
      expect(result.stderr).toContain("Repository")
    } finally {
      await cleanup(root)
    }
  }, 120_000)

  test("tools and websearch-free honour BANYANCODE_ENABLE=0", async () => {
    const root = await tmpRoot("banyancode-cli-disabled-")
    try {
      const tools = await cli(root, ["tools"], { env: { BANYANCODE_ENABLE: "0" } })
      expect(tools.exitCode).toBe(1)
      expect(tools.stderr).toContain("BANYANCODE_ENABLE=0")

      const search = await cli(root, ["websearch-free", "hello"], { env: { BANYANCODE_ENABLE: "0" } })
      expect(search.exitCode).toBe(1)
      expect(search.stderr).toContain("websearch disabled by BANYANCODE_ENABLE=0")
    } finally {
      await cleanup(root)
    }
  }, 120_000)

  test("codegraph build rejects a missing root before calling the server", async () => {
    const root = await tmpRoot("banyancode-cli-root-")
    try {
      const result = await cli(root, ["codegraph", "build", "--root", path.join(root, "missing")])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("Directory not found")
      expect(result.stderr).not.toContain("RPC call failed")
      expect(result.stderr).not.toMatch(/^\s+at /m)
    } finally {
      await cleanup(root)
    }
  }, 120_000)

  test("mcp install propagates the client exit code without a second error", async () => {
    const root = await tmpRoot("banyancode-cli-mcp-")
    try {
      const result = await cli(root, ["mcp", "install", "vim"])
      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain('unknown client "vim"')
      expect(result.stderr).not.toContain("exited with code")
      expect(result.stderr).not.toMatch(/^\s+at /m)
    } finally {
      await cleanup(root)
    }
  }, 120_000)
})

test("ordinary service failures keep their one-line message", () => {
  const message =
    "Managed service port 39022 on 127.0.0.1 is already in use by PID 1. Configure another port with `banyancode service set port <port>` and start the service again."
  const error = new Error(message, { cause: new Error("ServeError: Failed to start server") })
  expect(errorLine(error)).toBe(message)
  expect(errorLine(error)).not.toContain("ServeError")
})
