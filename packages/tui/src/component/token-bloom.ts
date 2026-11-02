import {
  CodeRenderable,
  RGBA,
  type MarkdownOptions,
  type OnChunksCallback,
  type Renderable,
  type TextChunk,
} from "@opentui/core"

/** How many trailing characters glow while text streams in. */
export const BLOOM_CHARS = 12

/**
 * Bloom strength for a character `distance` places from the newest one: the newest
 * character is closest to the highlight color, the oldest still-blooming one is the
 * plain text color. Matches the mockup: `mix(highlight, text, (distance + 1) / count)`.
 */
export function bloomStrength(distance: number, count = BLOOM_CHARS) {
  if (count <= 0) return 1
  return Math.min(1, Math.max(0, (distance + 1) / count))
}

export function bloomColor(highlight: RGBA, text: RGBA, distance: number, count = BLOOM_CHARS) {
  const amount = bloomStrength(distance, count)
  return RGBA.fromValues(
    highlight.r + (text.r - highlight.r) * amount,
    highlight.g + (text.g - highlight.g) * amount,
    highlight.b + (text.b - highlight.b) * amount,
    1,
  )
}

/**
 * Recolors the newest `count` characters of a styled run. Chunks before the bloom
 * window are returned untouched; the window itself is split per character because
 * each one gets its own blend step.
 */
export function bloomChunks(
  chunks: readonly TextChunk[],
  highlight: RGBA,
  text: RGBA,
  count = BLOOM_CHARS,
): TextChunk[] {
  if (count <= 0) return [...chunks]
  const lengths = chunks.map((chunk) => Array.from(chunk.text).length)
  const total = lengths.reduce((sum, length) => sum + length, 0)
  const start = Math.max(0, total - count)
  if (start >= total) return [...chunks]
  const colors = new Map<number, RGBA>()
  let offset = 0
  return chunks.flatMap((chunk) => {
    const characters = Array.from(chunk.text)
    const chunkStart = offset
    offset += characters.length
    if (offset <= start) return [chunk]
    const tail = characters.map((character, index) => {
      const distance = total - 1 - (chunkStart + index)
      if (chunkStart + index < start) return { ...chunk, text: character }
      const cached = colors.get(distance)
      const color = cached ?? bloomColor(highlight, text, distance, count)
      if (!cached) colors.set(distance, color)
      return { ...chunk, text: character, fg: color }
    })
    const head = tail.findIndex((item, index) => chunkStart + index >= start)
    if (head <= 0) return tail
    return [{ ...chunk, text: characters.slice(0, head).join("") }, ...tail.slice(head)]
  })
}

export type BloomOptions = {
  /** False for completed messages and when animations are disabled. */
  active: () => boolean
  /** The part's full text; its last block is the one that blooms. */
  text: () => string
  highlight: () => RGBA
  textColor: () => RGBA
}

type BloomHook = {
  readonly renderable: CodeRenderable
  original: OnChunksCallback | undefined
  /** Tail state the installed wrapper was created for; the wrapper re-checks at run time. */
  installedTail: boolean
  installed: boolean
}

/**
 * Wraps a markdown `renderNode` so the trailing block of the streamed text gets a
 * token bloom. The bloom lives in `onChunks`, so it follows the real text chunks
 * and needs no timer: it is recomputed when the block's content changes.
 */
export function createTokenBloom(options: BloomOptions) {
  const hooks = new Set<BloomHook>()
  const visited = new WeakSet<Renderable>()
  let scheduled = false
  let disposed = false

  const isTail = (content: string) => {
    if (!options.active()) return false
    const block = content.trimEnd()
    if (!block) return false
    return options.text().trimEnd().endsWith(block)
  }

  const install = (hook: BloomHook, tail: boolean) => {
    hook.installed = true
    hook.installedTail = tail
    hook.renderable.onChunks = async (chunks, context) => {
      const transformed = (await hook.original?.(chunks, context)) ?? chunks
      if (!isTail(context.content)) return transformed
      return bloomChunks(transformed, options.highlight(), options.textColor())
    }
  }

  const sync = () => {
    if (disposed) return
    for (const hook of hooks) {
      if (hook.renderable.isDestroyed) {
        hooks.delete(hook)
        continue
      }
      const tail = isTail(hook.renderable.content)
      if (hook.installed && tail === hook.installedTail) continue
      if (!hook.installed && !tail) continue
      // A fresh wrapper identity invalidates highlights, so a stale or missing bloom is repainted.
      install(hook, tail)
    }
  }

  const schedule = () => {
    if (scheduled || disposed) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      sync()
    })
  }

  const decorate = (renderable: Renderable) => {
    if (!visited.has(renderable)) {
      visited.add(renderable)
      // Markdown reconciles nested lists and tables without calling renderNode; hook
      // descendants as they are added so the tail block is found wherever it lives.
      const add = renderable.add.bind(renderable)
      renderable.add = (child: Renderable, index?: number) => {
        if (child instanceof CodeRenderable) decorate(child)
        return add(child, index)
      }
      if (renderable instanceof CodeRenderable && renderable.filetype === "markdown") {
        const hook: BloomHook = {
          renderable,
          original: renderable.onChunks,
          installedTail: false,
          installed: false,
        }
        hooks.add(hook)
        // A trailing block that is created mid-stream starts with the bloom in place, no extra pass.
        if (isTail(renderable.content)) install(hook, true)
      }
      renderable.getChildren().forEach(decorate)
    }
    schedule()
  }

  const renderNode =
    (base?: MarkdownOptions["renderNode"]): NonNullable<MarkdownOptions["renderNode"]> =>
    (token, context) => {
      const renderable = base?.(token, context) ?? context.defaultRender()
      if (renderable) decorate(renderable)
      return renderable
    }

  return {
    renderNode,
    sync,
    syncSoon: schedule,
    dispose() {
      disposed = true
      for (const hook of hooks) if (hook.installed && !hook.renderable.isDestroyed) hook.renderable.onChunks = hook.original
      hooks.clear()
    },
  }
}

export type TokenBloom = ReturnType<typeof createTokenBloom>
