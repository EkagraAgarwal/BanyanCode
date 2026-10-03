// MCP server bootstrap: cwd correctness (§2.3), password handling (§2.4),
// ephemeral ports (§2.5).
//
// Pure unit tests cover the path/env helpers; integration tests boot a real
// Server.listen (same shape as test/server/httpapi-listen.test.ts) to prove
// the in-process bootstrap targets --cwd and never leaks the password.

import { afterEach, describe, expect, test } from "bun:test"
import net from "node:net"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Server } from "../../src/server/server"
import {
  createMcpServer,
  isEqualOrAncestor,
  resolveCwd,
  scrubServerSecretsFromEnv,
} from "../../src/mcp-server/server"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"

const savedCwd = process.cwd()
const savedPassword = process.env.OPENCODE_SERVER_PASSWORD

afterEach(async () => {
  process.chdir(savedCwd)
  if (savedPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
  else process.env.OPENCODE_SERVER_PASSWORD = savedPassword
  await disposeAllInstances()
  await resetDatabase()
})

// Bind 4096 if it is free, so the caller can prove what happens with and
// without the well-known port held. Returns undefined when 4096 is already
// taken (coexistence case — still a valid run, just not discriminating).
async function tryOccupy4096(): Promise<net.Server | undefined> {
  const squatter = net.createServer()
  const free = await new Promise<boolean>((resolve) => {
    squatter.once("error", () => resolve(false))
    squatter.listen(4096, "127.0.0.1", () => resolve(true))
  })
  if (!free) return undefined
  return squatter
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

describe("mcp server bootstrap helpers", () => {
  test("resolveCwd rejects missing paths and files, resolves directories", async () => {
    const tmp = await tmpdir()
    try {
      await expect(resolveCwd(path.join(tmp.path, "nope"))).rejects.toThrow(/does not exist/)
      const file = path.join(tmp.path, "f.txt")
      await Bun.write(file, "x")
      await expect(resolveCwd(file)).rejects.toThrow(/not a directory/)
      expect(await resolveCwd(tmp.path)).toBe(tmp.path)
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  })

  test("isEqualOrAncestor matches self and children, rejects siblings", () => {
    expect(isEqualOrAncestor("/repo", "/repo")).toBe(true)
    expect(isEqualOrAncestor("/repo", "/repo/sub/dir")).toBe(true)
    expect(isEqualOrAncestor("/repo", "/repo2")).toBe(false)
    expect(isEqualOrAncestor("/repo", "/other")).toBe(false)
    // Relative inputs resolve against the process cwd on both sides.
    expect(isEqualOrAncestor(savedCwd, path.join(savedCwd, "x"))).toBe(true)
  })

  test("scrubServerSecretsFromEnv removes both password keys and keeps the rest", () => {
    const input = {
      KEEP: "1",
      OPENCODE_SERVER_PASSWORD: "secret",
      BANYANCODE_SERVER_PASSWORD: "secret",
    }
    expect(scrubServerSecretsFromEnv(input)).toEqual({ KEEP: "1" })
    expect(input.OPENCODE_SERVER_PASSWORD).toBe("secret")
  })
})

describe("mcp server listen ports", () => {
  test("ephemeral never claims 4096 when it is free, coexists when taken", async () => {
    const squatter = await tryOccupy4096()
    const wasFree = squatter !== undefined
    if (squatter) await closeServer(squatter)
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0, ephemeral: true })
    try {
      expect(listener.port).toBeGreaterThan(0)
      if (wasFree) expect(listener.port).not.toBe(4096)
    } finally {
      await listener.stop(true)
    }
  })

  test("default port 0 still prefers 4096 when free (banyancode serve behavior)", async () => {
    const squatter = await tryOccupy4096()
    if (!squatter) return
    await closeServer(squatter)
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    try {
      expect(listener.port).toBe(4096)
    } finally {
      await listener.stop(true)
    }
  })
})

describe("mcp in-process bootstrap", () => {
  test(
    "targets --cwd when the launcher cwd differs, scrubs the password",
    async () => {
      // Git roots: on machines where the temp dir itself sits inside a
      // parent git repo (e.g. a home-dir dotfiles repo), a plain tmpdir
      // resolves to that parent project — git init pins the target root.
      const target = await tmpdir({ git: true })
      const decoy = await tmpdir()
      try {
        delete process.env.OPENCODE_SERVER_PASSWORD
        process.chdir(decoy.path)
        const boot = await createMcpServer({ cwd: target.path })
        try {
          expect(boot.cwd).toBe(target.path)
          expect(process.cwd()).toBe(target.path)
          expect(process.env.OPENCODE_SERVER_PASSWORD).toBeUndefined()
          expect(new URL(boot.baseUrl).port).not.toBe("4096")
          // The server itself resolves the requested root, not the
          // launcher's directory.
          const current = await boot.sdk.project.current({ directory: target.path }, { throwOnError: true })
          expect((current.data as { worktree: string }).worktree).toBe(target.path)
        } finally {
          await boot.cleanup()
        }
      } finally {
        await target[Symbol.asyncDispose]()
        await decoy[Symbol.asyncDispose]()
      }
    },
    120_000,
  )

  test(
    "restores a pre-existing server password instead of deleting it",
    async () => {
      const target = await tmpdir({ git: true })
      try {
        process.env.OPENCODE_SERVER_PASSWORD = "sentinel-prior-value"
        const boot = await createMcpServer({ cwd: target.path })
        try {
          expect(process.env.OPENCODE_SERVER_PASSWORD).toBe("sentinel-prior-value")
          // The listener captured the per-process password, not the
          // restored sentinel: an authed call through the SDK still works.
          const current = await boot.sdk.project.current({ directory: target.path }, { throwOnError: true })
          expect((current.data as { worktree: string }).worktree).toBe(target.path)
        } finally {
          await boot.cleanup()
        }
      } finally {
        await target[Symbol.asyncDispose]()
      }
    },
    120_000,
  )
})

describe("mcp --attach worktree guard", () => {
  test(
    "accepts the server root and subdirectories, refuses foreign roots",
    async () => {
      // Git root for the same reason as above: the probe reads the
      // attached server's own project, which must be the server root.
      const serverRoot = await tmpdir({ git: true })
      const foreign = await tmpdir()
      try {
        const sub = path.join(serverRoot.path, "sub")
        await mkdir(sub, { recursive: true })
        process.chdir(serverRoot.path)
        const listener = await Server.listen({ hostname: "127.0.0.1", port: 0, ephemeral: true })
        const baseUrl = `http://${listener.hostname}:${listener.port}`
        try {
          const same = await createMcpServer({ attach: baseUrl, cwd: serverRoot.path })
          await same.cleanup()
          const child = await createMcpServer({ attach: baseUrl, cwd: sub })
          await child.cleanup()
          await expect(createMcpServer({ attach: baseUrl, cwd: foreign.path })).rejects.toThrow(
            /refusing to start/,
          )
        } finally {
          await listener.stop(true)
        }
      } finally {
        await serverRoot[Symbol.asyncDispose]()
        await foreign[Symbol.asyncDispose]()
      }
    },
    120_000,
  )
})
