import { expect, test } from "bun:test"
import { removalTargets } from "../src/commands/handlers/uninstall"

test("uninstall keep flags preserve data and configuration", () => {
  const targets = removalTargets(
    { data: "/data", cache: "/cache", config: "/config", state: "/state" },
    { keepConfig: true, keepData: true },
  )
  expect(targets).toEqual([
    { path: "/data", label: "Data", keep: true },
    { path: "/cache", label: "Cache", keep: false },
    { path: "/config", label: "Config", keep: true },
    { path: "/state", label: "State", keep: false },
  ])
})

test("uninstall removes data and configuration by default", () => {
  const targets = removalTargets(
    { data: "/data", cache: "/cache", config: "/config", state: "/state" },
    { keepConfig: false, keepData: false },
  )
  expect(targets.filter((target) => target.keep)).toEqual([])
})
