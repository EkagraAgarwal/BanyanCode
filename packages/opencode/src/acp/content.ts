import type { ContentBlock, ContentChunk, ResourceLink, Role } from "@agentclientprotocol/sdk"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { SessionV1 } from "@opencode-ai/core/v1/session"

export type PromptPart = SessionV1.TextPartInput | SessionV1.FilePartInput

// Predictable bound on inline base64 payloads (~6MB decoded). The gate runs
// BEFORE any `data:...;base64,${...}` concatenation so an oversized input
// never materializes a second giant string, and oversized blobs prefer a
// URI/file ref where the block carries one instead of inlining.
export const MAX_INLINE_BASE64_CHARS = 8 * 1024 * 1024

export type ReplayPart =
  | {
      type: "text"
      text: string
      synthetic?: boolean
      ignored?: boolean
    }
  | {
      type: "file"
      url: string
      mime: string
      filename?: string
    }
  | {
      type: "reasoning"
      text: string
    }

export function promptContentToParts(content: readonly ContentBlock[]): PromptPart[] {
  return content.flatMap(contentBlockToParts)
}

export function contentBlockToParts(block: ContentBlock): PromptPart[] {
  switch (block.type) {
    case "text":
      return [
        {
          type: "text",
          text: block.text,
          ...audienceFlags(block.annotations?.audience ?? undefined),
        },
      ]

    case "image":
      if (block.data) {
        if (block.data.length > MAX_INLINE_BASE64_CHARS) return oversizedImageRef(block)
        return [
          {
            type: "file",
            url: `data:${block.mimeType};base64,${block.data}`,
            filename: filenameFromUri(block.uri ?? undefined) ?? "image",
            mime: block.mimeType,
          },
        ]
      }
      if (block.uri?.startsWith("data:")) {
        if (block.uri.length > MAX_INLINE_BASE64_CHARS) return []
        return [
          {
            type: "file",
            url: block.uri,
            filename: filenameFromUri(block.uri) ?? "image",
            mime: block.mimeType,
          },
        ]
      }
      if (block.uri?.startsWith("http://") || block.uri?.startsWith("https://")) {
        return [
          {
            type: "file",
            url: block.uri,
            filename: filenameFromUri(block.uri) ?? "image",
            mime: block.mimeType,
          },
        ]
      }
      return []

    case "resource_link":
      return [resourceLinkToPart(block)]

    case "resource":
      if ("text" in block.resource) {
        return [{ type: "text", text: block.resource.text }]
      }
      if (block.resource.mimeType) {
        if (block.resource.blob.length > MAX_INLINE_BASE64_CHARS) return oversizedResourceRef(block.resource)
        return [
          {
            type: "file",
            url: block.resource.uri.startsWith("data:")
              ? block.resource.uri
              : `data:${block.resource.mimeType};base64,${block.resource.blob}`,
            filename: filenameFromUri(block.resource.uri) ?? "file",
            mime: block.resource.mimeType,
          },
        ]
      }
      return []

    default:
      return []
  }
}

export function partsToContentChunks(parts: readonly ReplayPart[]): ContentChunk[] {
  return parts.flatMap(partToContentChunks)
}

export function partToContentChunks(part: ReplayPart): ContentChunk[] {
  switch (part.type) {
    case "text":
      if (!part.text) return []
      return [
        {
          content: {
            type: "text",
            text: part.text,
            ...partAudience(part),
          },
        },
      ]

    case "file":
      return filePartToContentChunks(part)

    case "reasoning":
      if (!part.text) return []
      return [
        {
          content: {
            type: "text",
            text: part.text,
          },
        },
      ]
  }
}

// Oversized image data prefers the block's own URI ref (http/file) over
// inlining; without a usable URI the block is dropped to keep the bound.
function oversizedImageRef(block: Extract<ContentBlock, { type: "image" }>): PromptPart[] {
  const uri = block.uri
  if (uri && !uri.startsWith("data:")) {
    return [
      {
        type: "file",
        url: uri,
        filename: filenameFromUri(uri) ?? "image",
        mime: block.mimeType,
      },
    ]
  }
  return []
}

// Oversized resource blobs prefer the resource URI as a file ref when it
// resolves to one; otherwise dropped to keep the bound.
function oversizedResourceRef(resource: {
  uri: string
  mimeType?: string | null
  blob: string
}): PromptPart[] {
  const part = uriToFilePart(resource.uri, resource.mimeType ?? "application/octet-stream", filenameFromUri(resource.uri))
  return part.type === "file" ? [part] : []
}

function resourceLinkToPart(link: ResourceLink): PromptPart {  const parsed = uriToFilePart(link.uri, link.mimeType ?? "text/plain", link.name)
  if (parsed.type === "file") return parsed
  return { type: "text", text: parsed.text }
}

function uriToFilePart(
  uri: string,
  mime: string,
  filename?: string,
): SessionV1.FilePartInput | SessionV1.TextPartInput {
  try {
    if (uri.startsWith("file://")) {
      return {
        type: "file",
        url: uri,
        filename: filename ?? filenameFromUri(uri) ?? "file",
        mime,
      }
    }
    if (uri.startsWith("zed://")) {
      const pathname = new URL(uri).searchParams.get("path")
      if (pathname) {
        return {
          type: "file",
          url: pathToFileURL(pathname).href,
          filename: filename ?? (path.basename(pathname) || "file"),
          mime,
        }
      }
    }
    return { type: "text", text: uri }
  } catch {
    return { type: "text", text: uri }
  }
}

function filePartToContentChunks(part: Extract<ReplayPart, { type: "file" }>): ContentChunk[] {
  if (part.url.startsWith("file://")) {
    return [
      {
        content: {
          type: "resource_link",
          uri: part.url,
          name: part.filename ?? "file",
          mimeType: part.mime,
        },
      },
    ]
  }
  if (!part.url.startsWith("data:")) return []

  // Gate before decodeDataUrl/Buffer.from so replaying an oversized part
  // never allocates the decoded bytes; the oversized intermediate is dropped.
  const base64Length = part.url.length - part.url.indexOf(",") - 1
  if (base64Length > MAX_INLINE_BASE64_CHARS) return []

  const data = decodeDataUrl(part.url)
  if (!data) return []
  if (data.mime.startsWith("image/")) {
    return [
      {
        content: {
          type: "image",
          mimeType: data.mime,
          data: data.base64,
          uri: pathToFileURL(part.filename ?? "image").href,
        },
      },
    ]
  }

  return [
    {
      content: {
        type: "resource",
        resource:
          data.mime.startsWith("text/") || data.mime === "application/json"
            ? {
                uri: pathToFileURL(part.filename ?? "file").href,
                mimeType: data.mime,
                text: Buffer.from(data.base64, "base64").toString("utf8"),
              }
            : {
                uri: pathToFileURL(part.filename ?? "file").href,
                mimeType: data.mime,
                blob: data.base64,
              },
      },
    },
  ]
}

function decodeDataUrl(url: string) {
  const match = /^data:([^;]+);base64,(.*)$/.exec(url)
  if (!match) return
  return { mime: match[1], base64: match[2] }
}

function audienceFlags(audience: readonly Role[] | null | undefined) {
  if (audience?.length === 1 && audience[0] === "assistant") return { synthetic: true }
  if (audience?.length === 1 && audience[0] === "user") return { ignored: true }
  return {}
}

function partAudience(part: Extract<ReplayPart, { type: "text" }>) {
  const audience: Role[] | undefined = part.synthetic ? ["assistant"] : part.ignored ? ["user"] : undefined
  if (!audience) return {}
  return { annotations: { audience } }
}

function filenameFromUri(uri: string | undefined) {
  if (!uri) return
  if (uri.startsWith("data:")) return
  try {
    const parsed = new URL(uri)
    const name = path.basename(parsed.pathname)
    return name || undefined
  } catch {
    return path.basename(uri) || undefined
  }
}
