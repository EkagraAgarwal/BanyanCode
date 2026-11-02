/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { CodeRenderable, RGBA, SyntaxStyle, type Renderable, type TextChunk } from "@opentui/core"
import { MockTreeSitterClient } from "@opentui/core/testing"
import { testRender, useRenderer } from "@opentui/solid"
import { createSignal } from "solid-js"
import {
  BLOOM_CHARS,
  bloomChunks,
  bloomColor,
  bloomStrength,
  createTokenBloom,
} from "../../src/component/token-bloom"

const HIGHLIGHT = RGBA.fromHex("#c8f27c")
const TEXT = RGBA.fromHex("#dce5d8")

test("bloomChunks recolors only the trailing window and keeps styles", () => {
  const chunks: TextChunk[] = [
    { __isChunk: true, text: "hello ", fg: TEXT },
    { __isChunk: true, text: "world", fg: TEXT, attributes: 1 },
  ]
  const result = bloomChunks(chunks, HIGHLIGHT, TEXT, 4)
  expect(result.map((chunk) => chunk.text).join("")).toBe("hello world")
  expect(result[0]!.fg!.equals(TEXT)).toBe(true)
  // The newest characters are separate chunks, each one step further from the highlight.
  expect(result.at(-1)!.fg!.equals(bloomColor(HIGHLIGHT, TEXT, 0, 4))).toBe(true)
  expect(result.at(-2)!.fg!.equals(bloomColor(HIGHLIGHT, TEXT, 1, 4))).toBe(true)
  expect(result.some((chunk) => chunk.attributes === 1)).toBe(true)
})

test("bloomChunks leaves text that fits inside the window fully bloomed", () => {
  const result = bloomChunks([{ __isChunk: true, text: "abc" }], HIGHLIGHT, TEXT)
  expect(result.map((chunk) => chunk.text).join("")).toBe("abc")
  expect(result.map((chunk) => chunk.fg!.equals(TEXT))).toEqual([false, false, false])
  expect(result[0]!.fg!.equals(bloomColor(HIGHLIGHT, TEXT, 2))).toBe(true)
})

function codeBlocks(node: Renderable): CodeRenderable[] {
  return [
    ...(node instanceof CodeRenderable ? [node] : []),
    ...node.getChildren().flatMap(codeBlocks),
  ]
}

async function painted(app: Awaited<ReturnType<typeof testRender>>) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const pending = codeBlocks(app.renderer.root).filter((block) => block.isHighlighting)
    if (pending.length > 0) await Promise.all(pending.map((block) => block.highlightingDone))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await app.renderOnce()
  }
}

function cells(app: Awaited<ReturnType<typeof testRender>>) {
  return app
    .captureSpans()
    .lines.flatMap((item) => item.spans)
    .flatMap((span) => Array.from(span.text).map((character) => ({ character, fg: span.fg })))
}

async function mount(input: { content: string; streaming: boolean }) {
  const [content, setContent] = createSignal(input.content)
  const [streaming, setStreaming] = createSignal(input.streaming)
  const bloom = createTokenBloom({
    active: () => streaming(),
    text: () => content(),
    highlight: () => HIGHLIGHT,
    textColor: () => TEXT,
  })
  const client = new MockTreeSitterClient({ autoResolveTimeout: 0 })
  client.setMockResult({ highlights: [] })
  const styles: SyntaxStyle[] = []
  const app = await testRender(
    () => {
      const renderer = useRenderer()
      const style = SyntaxStyle.fromStyles({ default: { fg: TEXT } }, renderer.nativeScene)
      styles.push(style)
      return (
        <markdown
          syntaxStyle={style}
          treeSitterClient={client}
          renderNode={bloom.renderNode()}
          content={content()}
          streaming={streaming()}
          fg={TEXT}
        />
      )
    },
    { width: 60, height: 6, remote: true },
  )
  await app.renderOnce()
  await painted(app)
  return Object.assign(app, {
    bloom,
    styles,
    async append(text: string) {
      setContent(text)
      await painted(app)
    },
    async complete() {
      setStreaming(false)
      bloom.sync()
      await painted(app)
    },
  })
}

const SAMPLE = "abcdefghijklmnopqrstuvwxyz"

test("the newest twelve characters blend from the highlight color", async () => {
  await using app = await mount({ content: SAMPLE, streaming: true })
  const paintedCells = cells(app)
  const start = paintedCells.findIndex((cell) => cell.character === "a")
  expect(start).toBeGreaterThanOrEqual(0)
  const visible = paintedCells.slice(start, start + SAMPLE.length)
  expect(visible.map((cell) => cell.character).join("")).toBe(SAMPLE)

  for (let index = 0; index < SAMPLE.length; index++) {
    const distance = SAMPLE.length - 1 - index
    const expected = distance < BLOOM_CHARS ? bloomColor(HIGHLIGHT, TEXT, distance) : TEXT
    expect(visible[index]!.fg.equals(expected)).toBe(true)
  }
})

test("appending real text moves the bloom to the newest characters", async () => {
  await using app = await mount({ content: SAMPLE, streaming: true })
  const longer = `${SAMPLE} more`
  await app.append(longer)
  const paintedCells = cells(app)
  const start = paintedCells.findIndex((cell) => cell.character === "a")
  const visible = paintedCells.slice(start, start + longer.length)
  expect(visible.map((cell) => cell.character).join("")).toBe(longer)

  const diffs = longer.split("").flatMap((character, index) => {
    const distance = longer.length - 1 - index
    const expected = distance < BLOOM_CHARS ? bloomColor(HIGHLIGHT, TEXT, distance) : TEXT
    return visible[index]!.fg.equals(expected) ? [] : [`${index}${character}`]
  })
  expect(diffs).toEqual([])
  // The character that was newest before the chunk is now inside the gradient, not at full highlight.
  expect(visible[SAMPLE.length - 1]!.fg.equals(bloomColor(HIGHLIGHT, TEXT, longer.length - SAMPLE.length))).toBe(true)
  expect(bloomStrength(longer.length - SAMPLE.length)).toBeGreaterThan(0)
})

test("a completed message shows plain text colors", async () => {
  await using app = await mount({ content: SAMPLE, streaming: true })
  await app.complete()
  const paintedCells = cells(app)
  const start = paintedCells.findIndex((cell) => cell.character === "a")
  const visible = paintedCells.slice(start, start + SAMPLE.length)
  expect(visible.map((cell) => cell.character).join("")).toBe(SAMPLE)
  for (const cell of visible) expect(cell.fg.equals(TEXT)).toBe(true)
})
