// Runs before any test module imports `@opencode/util/global`, whose paths are
// read from XDG_* at import time. Every plugin test gets a throwaway home so no
// test writes a project database or config into the real BanyanCode data dir.
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const home = mkdtempSync(join(tmpdir(), "banyancode-plugin-test-"))
process.env.OPENCODE_TEST_HOME = home
process.env.XDG_CONFIG_HOME = join(home, ".config")
process.env.XDG_DATA_HOME = join(home, ".local", "share")
process.env.XDG_CACHE_HOME = join(home, ".cache")
process.env.XDG_STATE_HOME = join(home, ".local", "state")

// Never send install telemetry from tests, even when a developer has a key exported.
process.env.BANYANCODE_TELEMETRY = "off"
delete process.env.BANYANCODE_POSTHOG_KEY
