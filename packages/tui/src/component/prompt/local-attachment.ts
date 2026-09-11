import { readFile } from "node:fs/promises"
import path from "node:path"

export type LocalFiles = Readonly<{
  readText(path: string): Promise<string>
  readBytes(path: string): Promise<Uint8Array>
  mime(path: string): Promise<string>
}>

export type LocalAttachment =
  | Readonly<{ type: "text"; mime: "image/svg+xml"; content: string }>
  | Readonly<{ type: "binary"; mime: string; content: Uint8Array }>

// Predictable bound on pasted attachments (~8MB raw). The session prompt
// path only supports inline data URLs for file parts (no file:// refs), so
// oversized attachments are refused at the call site before any base64
// intermediate is allocated — never after.
export const MAX_LOCAL_ATTACHMENT_BYTES = 8 * 1024 * 1024

// Base64-cap mirror for already-encoded payloads (clipboard path), so the
// prompt component can gate before building the `data:...` URL string.
export const MAX_PASTE_ATTACHMENT_BASE64_CHARS = Math.ceil(MAX_LOCAL_ATTACHMENT_BYTES / 3) * 4

export function binaryAttachmentToDataUrl(
  attachment: Extract<LocalAttachment, { type: "binary" }>,
): string | undefined {
  if (attachment.content.byteLength > MAX_LOCAL_ATTACHMENT_BYTES) return undefined
  return `data:${attachment.mime};base64,${Buffer.from(attachment.content).toString("base64")}`
}

export function readLocalAttachment(file: string) {
  return readLocalAttachmentWith(
    {
      readText: (value) => readFile(value, "utf8"),
      readBytes: (value) => readFile(value),
      mime: async (value) => mimeTypes[path.extname(value).toLowerCase()] ?? "application/octet-stream",
    },
    file,
  )
}

const mimeTypes: Record<string, string> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
}

export async function readLocalAttachmentWith(files: LocalFiles, path: string): Promise<LocalAttachment | undefined> {
  const mime = await files.mime(path).catch(() => undefined)
  if (!mime) return
  if (mime === "image/svg+xml") {
    const content = await files.readText(path).catch(() => undefined)
    if (!content) return
    return { type: "text", mime, content }
  }
  if (!mime.startsWith("image/") && mime !== "application/pdf") return
  const content = await files.readBytes(path).catch(() => undefined)
  if (!content) return
  return { type: "binary", mime, content }
}
