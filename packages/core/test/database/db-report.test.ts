import { describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { dbReport, LARGE_DB_WARN_BYTES } from "@opencode-ai/core/database/db-report"
import { tmpdir } from "../fixture/tmpdir"

describe("dbReport", () => {
  test("sums db + wal + shm and does not warn for small files", async () => {
    await using tmp = await tmpdir()
    const file = join(tmp.path, "x.db")
    writeFileSync(file, "a".repeat(10))
    writeFileSync(`${file}-wal`, "b".repeat(5))
    const report = dbReport(file)
    expect(report.bytes).toBe(15)
    expect(report.warning).toBeUndefined()
  })

  test("missing file reports zero bytes without throwing", () => {
    expect(dbReport(join("D:", "nope", "missing.db")).bytes).toBe(0)
  })

  test("warns above the threshold and names the path", async () => {
    await using tmp = await tmpdir()
    const file = join(tmp.path, "big.db")
    writeFileSync(file, "")
    // sparse file: size without disk usage
    const fd = require("node:fs").openSync(file, "r+")
    require("node:fs").ftruncateSync(fd, LARGE_DB_WARN_BYTES + 1)
    require("node:fs").closeSync(fd)
    const report = dbReport(file)
    expect(report.warning).toContain(file)
    expect(report.warning).toContain("codegraph remove")
  })
})
