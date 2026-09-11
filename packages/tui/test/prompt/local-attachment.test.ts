import { describe, expect, test } from "bun:test"
import {
  MAX_LOCAL_ATTACHMENT_BYTES,
  MAX_PASTE_ATTACHMENT_BASE64_CHARS,
  binaryAttachmentToDataUrl,
  readLocalAttachmentWith,
} from "../../src/component/prompt/local-attachment"
import type { LocalFiles } from "../../src/component/prompt/local-attachment"

function files(input: { mime: string; text?: string; bytes?: Uint8Array }): LocalFiles {
  return {
    mime: async () => input.mime,
    readText: async () => input.text ?? "",
    readBytes: async () => input.bytes ?? new Uint8Array(),
  }
}

describe("prompt local attachments", () => {
  test("reads SVG attachments as text", async () => {
    expect(await readLocalAttachmentWith(files({ mime: "image/svg+xml", text: "<svg />" }), "/tmp/image.svg")).toEqual({
      type: "text",
      mime: "image/svg+xml",
      content: "<svg />",
    })
  })

  test("reads image and PDF attachments as bytes", async () => {
    const content = new Uint8Array([1, 2, 3])
    expect(await readLocalAttachmentWith(files({ mime: "application/pdf", bytes: content }), "/tmp/file.pdf")).toEqual({
      type: "binary",
      mime: "application/pdf",
      content,
    })
  })

  test("ignores unsupported and unreadable local files", async () => {
    expect(await readLocalAttachmentWith(files({ mime: "text/plain" }), "/tmp/file.txt")).toBeUndefined()
    expect(
      await readLocalAttachmentWith(
        {
          ...files({ mime: "image/png" }),
          readBytes: async () => Promise.reject(new Error("missing")),
        },
        "/tmp/missing.png",
      ),
    ).toBeUndefined()
  })
})

describe("prompt attachment size bound", () => {
  test("base64 cap mirrors the byte cap", () => {
    expect(MAX_PASTE_ATTACHMENT_BASE64_CHARS).toBe(Math.ceil(MAX_LOCAL_ATTACHMENT_BYTES / 3) * 4)
  })

  test("binary attachments at the byte cap convert to a data URL", () => {
    const content = new Uint8Array(MAX_LOCAL_ATTACHMENT_BYTES)
    expect(binaryAttachmentToDataUrl({ type: "binary", mime: "image/png", content })).toBe(
      `data:image/png;base64,${Buffer.from(content).toString("base64")}`,
    )
  })

  test("binary attachments over the byte cap are refused before conversion", () => {
    const content = new Uint8Array(MAX_LOCAL_ATTACHMENT_BYTES + 1)
    expect(binaryAttachmentToDataUrl({ type: "binary", mime: "image/png", content })).toBeUndefined()
  })
})
