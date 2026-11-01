/**
 * Tiny JSONC reader for `banyancode.jsonc`: strips line/block comments and
 * trailing commas outside strings, then delegates to `JSON.parse`. We do not
 * pull `jsonc-parser` in just for config discovery; the scanner below is the
 * same shape used by editors and keeps the package dependency-free.
 */
export const stripJsonc = (input: string): string => {
  const withoutBom = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  let output = ""
  let inString = false
  let escaped = false
  let lineComment = false
  let blockComment = false

  for (let index = 0; index < withoutBom.length; index++) {
    const char = withoutBom[index]!
    const next = withoutBom[index + 1]

    if (lineComment) {
      if (char === "\n" || char === "\r") {
        lineComment = false
        output += char
      }
      continue
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false
        index++
      }
      continue
    }
    if (inString) {
      output += char
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      output += char
      continue
    }
    if (char === "/" && next === "/") {
      lineComment = true
      index++
      continue
    }
    if (char === "/" && next === "*") {
      blockComment = true
      index++
      continue
    }
    output += char
  }

  return stripTrailingCommas(output)
}

const stripTrailingCommas = (input: string): string => {
  let output = ""
  let inString = false
  let escaped = false

  for (let index = 0; index < input.length; index++) {
    const char = input[index]!
    if (inString) {
      output += char
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      output += char
      continue
    }
    if (char === ",") {
      let lookahead = index + 1
      while (lookahead < input.length && /\s/.test(input[lookahead]!)) lookahead++
      if (input[lookahead] === "}" || input[lookahead] === "]") continue
    }
    output += char
  }

  return output
}

export const parseJsonc = (input: string): unknown => JSON.parse(stripJsonc(input))
