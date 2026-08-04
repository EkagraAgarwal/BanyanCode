import { Config } from "@/config/config"
import { AppRuntime } from "@/effect/app-runtime"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Installation } from "@/installation"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import { GlobalBus } from "@/bus/global"

// Whether the startup check should auto-install (vs only notifying). Dev
// (canary) users always auto-follow the absolute latest regardless of release
// kind; stable keeps the upstream patch-only gate. `autoupdate === "notify"`
// opts out of installing entirely.
export function shouldAutoInstall(
  channel: string,
  kind: Installation.ReleaseType,
  autoupdate: boolean | "notify" | undefined,
): boolean {
  if (autoupdate === "notify") return false
  return kind === "patch" || channel === "dev"
}

export async function upgrade() {
  const config = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal()))
  if (config.autoupdate === false || Flag.OPENCODE_DISABLE_AUTOUPDATE) return
  const method = await Installation.method()
  const latest = await Installation.latest(method).catch(() => {})
  if (!latest) return

  if (Flag.OPENCODE_ALWAYS_NOTIFY_UPDATE) {
    GlobalBus.emit("event", {
      directory: "global",
      payload: {
        type: Installation.Event.UpdateAvailable.type,
        properties: { version: latest },
      },
    })
    return
  }

  // Compare normalized versions: npm drops the leading zero from the CalVer
  // month (baked "26.07.4" vs registry "26.7.4"), and same-base canaries with
  // different shas must still upgrade.
  if (Installation.shouldSkipUpgrade(InstallationVersion, latest)) return

  const kind = Installation.getReleaseType(
    Installation.canonicalVersion(InstallationVersion),
    Installation.canonicalVersion(latest),
  )

  if (!shouldAutoInstall(InstallationChannel, kind, config.autoupdate)) {
    GlobalBus.emit("event", {
      directory: "global",
      payload: {
        type: Installation.Event.UpdateAvailable.type,
        properties: { version: latest },
      },
    })
    return
  }

  if (method === "unknown") return
  await Installation.upgrade(method, latest)
    .then(() =>
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: latest },
        },
      }),
    )
    .catch(() => {})
}
