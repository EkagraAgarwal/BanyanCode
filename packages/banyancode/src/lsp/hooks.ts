import path from "node:path"
import { Effect, type Scope } from "effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Tool } from "@opencode/schema/tool"
import { report } from "./diagnostic.js"
import { normalizePath } from "./fs.js"
import type { Manager } from "./manager.js"
import type { Instance } from "./types.js"

/**
 * Diagnostics on edit/write/patch. v1 appended the blocks inside each tool
 * (`tool/edit.ts`, `tool/write.ts`, `tool/apply_patch.ts`); v2 hands plugins an
 * `execute.after` hook that can rewrite `result.content`, so the same text is
 * appended here with the exact v1 wording and caps.
 */

const TARGETS = new Set(["edit", "write", "patch"])

const MAX_PROJECT_DIAGNOSTICS_FILES = 5

const append = (content: Tool.Result["content"], suffix: string): Tool.Result["content"] => {
  if (typeof content === "string") return content + suffix
  if (Array.isArray(content)) return [...content, { type: "text", text: suffix }]
  return suffix
}

const resolvePath = (target: string, instance: Instance) =>
  normalizePath(path.isAbsolute(target) ? target : path.join(instance.directory, target))

const targetsFor = (
  event: {
    readonly tool: string
    readonly input: unknown
    readonly result: Tool.Result
  },
  instance: Instance,
): string[] => {
  if (event.tool === "patch") {
    const output = event.result.output as { applied?: { type?: string; target?: string }[] } | undefined
    return (output?.applied ?? [])
      .filter((item) => item.type !== "delete" && typeof item.target === "string")
      .map((item) => resolvePath(item.target!, instance))
  }
  const input = event.input as { path?: unknown } | undefined
  return typeof input?.path === "string" ? [resolvePath(input.path, instance)] : []
}

export const registerDiagnosticsHook = (
  ctx: Context,
  manager: Manager,
): Effect.Effect<void, never, Scope.Scope> =>
  ctx.tool.hook("execute.after", (event) => {
    if (event.status !== "completed") return Effect.void
    if (!TARGETS.has(event.tool)) return Effect.void
    return Effect.promise(async () => {
      if (!manager.enabled()) return
      const targets = targetsFor({ tool: event.tool, input: event.input, result: event.result }, manager.instance)
      if (targets.length === 0) return

      await Promise.all(targets.map((target) => manager.touch(target, "document")))
      const diagnostics = await manager.diagnostics()

      let suffix = ""
      if (event.tool === "patch") {
        for (const target of targets) {
          const block = report(target, diagnostics[normalizePath(target)] ?? [])
          if (!block) continue
          const rel = path.relative(manager.instance.worktree, target).replaceAll("\\", "/")
          suffix += `\n\nLSP errors detected in ${rel}, please fix:\n${block}`
        }
      } else if (event.tool === "edit") {
        const target = targets[0]!
        const block = report(target, diagnostics[resolvePath(target, manager.instance)] ?? [])
        if (block) suffix += `\n\nLSP errors detected in this file, please fix:\n${block}`
      } else {
        const current = resolvePath(targets[0]!, manager.instance)
        let projectDiagnosticsCount = 0
        for (const [file, issues] of Object.entries(diagnostics)) {
          const isCurrent = file === current
          if (!isCurrent && projectDiagnosticsCount >= MAX_PROJECT_DIAGNOSTICS_FILES) continue
          const block = report(isCurrent ? targets[0]! : file, issues)
          if (!block) continue
          if (isCurrent) {
            suffix += `\n\nLSP errors detected in this file, please fix:\n${block}`
            continue
          }
          projectDiagnosticsCount++
          suffix += `\n\nLSP errors detected in other files:\n${block}`
        }
      }

      // v1 also exposed the full map as `metadata.diagnostics`; keep it so UI
      // consumers see the same shape even when no block is appended.
      event.result = {
        ...event.result,
        metadata: { ...(event.result.metadata ?? {}), diagnostics },
        ...(suffix ? { content: append(event.result.content, suffix) } : {}),
      }
    }).pipe(Effect.catchCause(() => Effect.void))
  })
