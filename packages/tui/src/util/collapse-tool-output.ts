export function collapseToolOutput(output: string, maxLines: number, maxChars: number) {
  const lines = output.split("\n")
  if (lines.length <= maxLines && Array.from(output).length <= maxChars) {
    return { output, overflow: false }
  }

  const preview = lines.slice(0, maxLines).join("\n")
  if (Array.from(preview).length > maxChars) {
    return {
      output:
        Array.from(preview)
          .slice(0, Math.max(0, maxChars - 1))
          .join("") + "…",
      overflow: true,
    }
  }

  return { output: [...lines.slice(0, maxLines), "…"].join("\n"), overflow: true }
}

/**
 * Render tail cap for huge tool outputs (V3/T8). Keeps the last N chars/lines
 * so per-delta split + layout work stays bounded; the underlying part state
 * is untouched, only the rendered slice is capped.
 */
export const TOOL_OUTPUT_TAIL_CHARS = 8 * 1024
export const TOOL_OUTPUT_TAIL_LINES = 200

export type ToolOutputTail = {
  output: string
  omittedChars: number
  omittedLines: number
  overflow: boolean
}

/** Pure: returns the last `maxLines` lines then the last `maxChars` chars. */
export function tailToolOutput(
  output: string,
  maxChars: number = TOOL_OUTPUT_TAIL_CHARS,
  maxLines: number = TOOL_OUTPUT_TAIL_LINES,
): ToolOutputTail {
  const text = output ?? ""
  const totalChars = Array.from(text).length
  if (totalChars <= maxChars) {
    const lines = text === "" ? [] : text.split("\n")
    if (lines.length <= maxLines) return { output: text, omittedChars: 0, omittedLines: 0, overflow: false }
    const kept = lines.slice(-maxLines)
    return {
      output: kept.join("\n"),
      omittedChars: totalChars - Array.from(kept.join("\n")).length,
      omittedLines: lines.length - kept.length,
      overflow: true,
    }
  }
  const tailChars = Array.from(text).slice(-maxChars).join("")
  const lines = tailChars.split("\n")
  if (lines.length <= maxLines) {
    return {
      output: tailChars,
      omittedChars: totalChars - maxChars,
      omittedLines: 0,
      overflow: true,
    }
  }
  const kept = lines.slice(-maxLines)
  return {
    output: kept.join("\n"),
    omittedChars: totalChars - Array.from(kept.join("\n")).length,
    omittedLines: Math.max(0, text.split("\n").length - kept.length),
    overflow: true,
  }
}

/**
 * Length-scaled markdown window (V3/T8). While streaming, huge markdown
 * bodies re-lex on every flush; cap the in-flight parse to the tail window.
 * Finished parts always render in full so the final output is exact.
 */
export const MARKDOWN_STREAM_WINDOW_CHARS = 16 * 1024

/** Pure: full text when done or small, otherwise the tail window. */
export function markdownStreamWindow(
  text: string,
  done: boolean,
  maxChars: number = MARKDOWN_STREAM_WINDOW_CHARS,
): string {
  if (done) return text
  const chars = Array.from(text ?? "")
  if (chars.length <= maxChars) return text
  return "…\n" + chars.slice(-maxChars).join("")
}
