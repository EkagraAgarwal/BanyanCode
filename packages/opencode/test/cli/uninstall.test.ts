import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Probe } from "../../src/installation/probe"
import { executeUninstall, type RemovalTargets } from "../../src/cli/cmd/uninstall"
import { Process } from "../../src/util/process"
import { tmpdir } from "../fixture/fixture"

function processResult(code: number, stdout = "", stderr = ""): Process.Result {
  return {
    code,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  }
}

async function exists(target: string) {
  return fs
    .lstat(target)
    .then(() => true)
    .catch(() => false)
}

async function createFixture(root: string) {
  const curl = path.join(root, ".banyancode", "bin", "banyancode")
  const bun = path.join(root, ".bun", "install", "global", "node_modules", ".bin", "banyancode")
  const bunPackage = path.join(root, ".bun", "install", "global", "node_modules", "banyancode")
  const directories: RemovalTargets["directories"] = [
    { path: path.join(root, ".local", "share", "banyancode"), label: "Data", keep: false },
    { path: path.join(root, ".cache", "banyancode"), label: "Cache", keep: false },
    { path: path.join(root, ".config", "banyancode"), label: "Config", keep: false },
    { path: path.join(root, ".local", "state", "banyancode"), label: "State", keep: false },
  ]

  await Promise.all([
    fs.mkdir(path.dirname(curl), { recursive: true }),
    fs.mkdir(path.dirname(bun), { recursive: true }),
    fs.mkdir(bunPackage, { recursive: true }),
    ...directories.map((directory) => fs.mkdir(directory.path, { recursive: true })),
  ])
  await Promise.all([
    fs.writeFile(curl, "fake curl binary"),
    fs.writeFile(bun, "fake bun binary"),
    fs.writeFile(path.join(bunPackage, "package.json"), JSON.stringify({ name: "banyancode", version: "26.7.6" })),
    ...directories.map((directory) => fs.writeFile(path.join(directory.path, "sample.txt"), directory.label)),
  ])

  const probeRun: typeof Process.run = async (command) => {
    if (command[0] === "where" || command[0] === "which") {
      const binaries = (
        await Promise.all([curl, bun].map(async (binary) => ((await exists(binary)) ? binary : undefined)))
      )
        .filter((binary) => binary !== undefined)
        .join("\n")
      return processResult(binaries ? 0 : 1, binaries)
    }
    if (command[0] === curl) return processResult(0, "banyancode 26.07.5")
    if (command[0] === bun) return processResult(0, "banyancode 26.7.6")
    return processResult(1)
  }

  const installs = (await Probe.findAllBanyanCodeInstalls({ home: root, run: probeRun })).filter((install) =>
    install.path.startsWith(root),
  )
  return { curl, bun, bunPackage, directories, installs, probeRun }
}

describe("banyancode uninstall", () => {
  test("removes curl and bun installs plus every data directory", async () => {
    await using tmp = await tmpdir()
    const fixture = await createFixture(tmp.path)
    const logs: string[] = []

    expect(fixture.installs.map((install) => install.method).sort()).toEqual(["bun", "curl"])

    const result = await executeUninstall(
      { installs: fixture.installs, directories: fixture.directories },
      {
        run: async (command) => {
          if (command[0] !== "bun") return processResult(1, "", "unexpected package manager")
          await Promise.all([
            fs.rm(fixture.bun, { force: true }),
            fs.rm(fixture.bunPackage, { recursive: true, force: true }),
          ])
          return processResult(0)
        },
        findRemaining: () => Probe.findBanyanCodeOnPath({ home: tmp.path, run: fixture.probeRun }),
        log: (message) => logs.push(message),
      },
    )

    expect(await exists(fixture.curl)).toBe(false)
    expect(await exists(fixture.bun)).toBe(false)
    for (const directory of fixture.directories) expect(await exists(directory.path)).toBe(false)
    expect(result.installs.every((install) => install.status === "removed")).toBe(true)
    expect(logs.some((message) => message.includes("Removed") && message.includes("(curl, v26.07.5)"))).toBe(true)
    expect(logs.some((message) => message.includes("Removed") && message.includes("(bun, v26.7.6)"))).toBe(true)
    expect(logs.some((message) => message.includes("Remaining:"))).toBe(false)
    expect(result.remaining).toEqual([])
  })

  test("continues after one package-manager uninstall fails", async () => {
    await using tmp = await tmpdir()
    const fixture = await createFixture(tmp.path)
    const logs: string[] = []

    const result = await executeUninstall(
      { installs: fixture.installs, directories: fixture.directories },
      {
        run: async (command) =>
          command[0] === "bun" ? processResult(1, "", "simulated permission failure") : processResult(1),
        findRemaining: () => Probe.findBanyanCodeOnPath({ home: tmp.path, run: fixture.probeRun }),
        log: (message) => logs.push(message),
      },
    )

    expect(await exists(fixture.curl)).toBe(false)
    expect(await exists(fixture.bun)).toBe(true)
    for (const directory of fixture.directories) expect(await exists(directory.path)).toBe(false)
    expect(result.installs.find((install) => install.install.method === "curl")?.status).toBe("removed")
    expect(result.installs.find((install) => install.install.method === "bun")?.status).toBe("skipped")
    expect(logs.some((message) => message.includes("Removed") && message.includes("(curl, v26.07.5)"))).toBe(true)
    expect(
      logs.some((message) => message.includes("⚠ Skipped") && message.includes("simulated permission failure")),
    ).toBe(true)
    expect(logs.some((message) => message.includes("⚠ Remaining:") && message.includes("banyancode"))).toBe(true)
  })
})
