import { afterEach, describe, expect } from "bun:test"
import { Config, Effect, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { Session } from "@/session/session"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { SessionImportPaths } from "../../src/server/routes/instance/httpapi/groups/import"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { requestInDirectory } from "./httpapi-layer"

const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  { disableListenLog: true, disableLogger: true },
)

const httpApiServerLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)

const it = testEffect(Layer.mergeAll(Session.defaultLayer, httpApiServerLayer))

type ImportResult = {
  sessionID: string
  title: string
  messageCount: number
  startedFromParsedSessionID?: string
}

function importRequest(content: string, directory: string) {
  return requestInDirectory(
    SessionImportPaths.sessionImport,
    directory,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    },
  )
}

const legacyMarkdown = `# Available tools overview

**Session ID:** ses_legacy01abc234de56fg78hi90
**Created:** 1/15/2026, 10:30:00 AM
**Updated:** 1/15/2026, 11:45:00 AM

---

## User

Please list every tool the agent has.

---

## Assistant (Build · minimax-coding-plan/MiniMax-M3 · 1.2s)

Here is the list:

- bash
- read
- write

**Tool: bash**

**Input:**
\`\`\`json
{
  "command": "ls -1"
}
\`\`\`

**Output:**
\`\`\`
file1
file2
\`\`\`

---

## User

Thanks.
`

const machineMetadataMarkdown = `<!-- banyancode-transcript:v1
eyJ2ZXJzaW9uIjoxLCJzZXNzaW9uSUQiOiJzZXNfMDBhYWFhYWFhYWFhYWFhYWFhYWFhYSIsInRpdGxlIjoiTWFjaGluZSBtZXRhZGF0YSB0ZXN0IiwiY3JlYXRlZEF0IjoxNzM2OTYwMDAwMDAwLCJ1cGRhdGVkQXQiOjE3MzY5NjMwMDAwMDAsImFnZW50IjoiYnVpbGQiLCJwcm92aWRlcklEIjoibWluaW1heC1jb2RpbmctcGxhbiIsIm1vZGVsSUQiOiJNaW5pTWF4LU0zIiwidmFyaWFudCI6InRoaW5raW5nIiwibWVzc2FnZXMiOlt7ImlkIjoibXNnXzEyMzQ1Njc4OTBhYmNkZWYiLCJyb2xlIjoidXNlciIsImFnZW50IjoiYnVpbGQiLCJwcm92aWRlcklEIjoibWluaW1heC1jb2RpbmctcGxhbiIsIm1vZGVsSUQiOiJNaW5pTWF4LU0zIiwidGV4dCI6IkhlbGxvLCBtYWNoaW5lISIsImNyZWF0ZWRBdCI6MTczNjk2MDAwMDAwMH0seyJpZCI6Im1zZ184NzY1NDMyMTBhYWJjZGVmIiwicm9sZSI6ImFzc2lzdGFudCIsInBhcmVudElEIjoibXNnXzEyMzQ1Njc4OTBhYmNkZWYiLCJhZ2VudCI6ImJ1aWxkIiwicHJvdmlkZXJJRCI6Im1pbmltYXgtY29kaW5nLXBsYW4iLCJtb2RlbElEIjoiTWluaU1heC1NMyIsInRleHQiOiJIaSB0aGVyZSEiLCJyZWFzb25pbmciOiJBIHRoaW5raW5nIGJsb2NrLiIsImNyZWF0ZWRBdCI6MTczNjk2MDEwMDAwMCwiY29tcGxldGVkQXQiOjE3MzY5NjAyMDAwMDAsInRvb2xzIjpbeyJuYW1lIjoiYmFzaCIsImNhbGxJRCI6ImNhbGxfYWFhYWFhYWFhYWFhYWFhYWFhYWEiLCJzdGF0dXMiOiJjb21wbGV0ZWQiLCJpbnB1dCI6eyJjb21tYW5kIjoiZWNobyBoZWxsbyJ9LCJvdXRwdXQiOiJoZWxsb1xuIiwidGl0bGUiOiJiYXNoIn1dfV19
-->
`

afterEach(async () => {
  await disposeAllInstances()
})

describe("sessionImport HttpApi", () => {
  it.instance(
    "imports a legacy Markdown transcript and persists the original createdAt",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const response = yield* importRequest(legacyMarkdown, test.directory)

        expect(response.status).toBe(200)
        const body = (yield* response.json) as ImportResult
        expect(body.messageCount).toBe(3)
        expect(body.startedFromParsedSessionID).toBe("ses_legacy01abc234de56fg78hi90")
        expect(body.title).toBe("Available tools overview")

        const session = yield* Session.use.get(body.sessionID as never)
        expect(session.time.created).toBe(new Date("1/15/2026, 10:30:00 AM").getTime())
        expect(session.time.updated).toBe(new Date("1/15/2026, 11:45:00 AM").getTime())
      }),
  )

  it.instance(
    "imports a machine-metadata transcript and persists the original createdAt",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const response = yield* importRequest(machineMetadataMarkdown, test.directory)

        expect(response.status).toBe(200)
        const body = (yield* response.json) as ImportResult
        expect(body.messageCount).toBe(2)
        expect(body.startedFromParsedSessionID).toBe("ses_00aaaaaaaaaaaaaaaaaaaa")
        expect(body.title).toBe("Machine metadata test")

        const session = yield* Session.use.get(body.sessionID as never)
        expect(session.time.created).toBe(1736960000000)
        expect(session.time.updated).toBe(1736963000000)
      }),
  )

  it.instance(
    "imports the real user transcript at packages/opencode/session-ses_09b7.md",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const transcriptPath = "D:/OpenCode/packages/opencode/session-ses_09b7.md"
        const content = yield* Effect.promise(() => Bun.file(transcriptPath).text())
        const response = yield* importRequest(content, test.directory)

        expect(response.status).toBe(200)
        const body = (yield* response.json) as ImportResult
        expect(body.messageCount).toBeGreaterThan(0)
        expect(body.startedFromParsedSessionID).toBe("ses_09b76da9affedkl3SDCBfqK7yk")
        expect(body.title).toBe("Spawning coder subagent for testing")

        const session = yield* Session.use.get(body.sessionID as never)
        expect(session.time.created).toBeGreaterThanOrEqual(1784098137000)
        expect(session.time.created).toBeLessThan(1784098137000 + 1000)
        expect(session.time.updated).toBeGreaterThanOrEqual(1784104794000)
        expect(session.time.updated).toBeLessThan(1784104794000 + 1000)
      }),
  )

  it.instance(
    "imports the real user transcript at session-ses_0860.md",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const transcriptPath = "D:/OpenCode/session-ses_0860.md"
        const content = yield* Effect.promise(() => Bun.file(transcriptPath).text())
        const response = yield* importRequest(content, test.directory)

        expect(response.status).toBe(200)
        const body = (yield* response.json) as ImportResult
        expect(body.messageCount).toBeGreaterThan(0)
        expect(body.startedFromParsedSessionID).toBe("ses_08600a9e2fferTOdf9HaqxNiFe")
        expect(body.title).toBe("Available tools overview")

        const session = yield* Session.use.get(body.sessionID as never)
        expect(session.time.created).toBe(1784478004000)
        expect(session.time.updated).toBe(1784635043000)
      }),
  )

  it.instance(
    "rejects an empty transcript with a 400 InvalidRequestError",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const response = yield* importRequest("# No messages here\n", test.directory)

        expect(response.status).toBe(400)
        const body = (yield* response.json) as { _tag?: string; message?: string }
        expect(body._tag).toBe("InvalidRequestError")
        expect(body.message).toMatch(/no user\/assistant messages/i)
      }),
  )
})
