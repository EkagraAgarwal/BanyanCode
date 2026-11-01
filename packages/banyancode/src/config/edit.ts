/**
 * Minimal JSONC structural editor.
 *
 * `jsonc-parser` is not a dependency of this package (it is installed under
 * `packages/core`/`packages/cli`, so a bare import from `packages/banyancode`
 * does not resolve without a re-install). Rather than add an install-time
 * dependency just for config writes, this module parses the small JSONC subset
 * `banyancode.json[c]` uses and edits values in place so comments, key order
 * and formatting survive a write.
 *
 * Supported: `{...}` objects, `[...]` arrays, quoted keys/strings, numbers,
 * `true`/`false`/`null`, line and block comments, trailing commas. That is the
 * full JSONC surface jsonc-parser accepts for objects; this editor never needs
 * to evaluate a value, only to find its span.
 */

export type Value = null | boolean | number | string | readonly Value[] | { readonly [key: string]: Value }

interface Member {
  readonly key: string
  readonly keyStart: number
  readonly valueStart: number
  readonly valueEnd: number
}

interface ObjectNode {
  readonly kind: "object"
  readonly start: number
  readonly end: number
  readonly members: readonly Member[]
}

interface ArrayNode {
  readonly kind: "array"
  readonly start: number
  readonly end: number
  readonly items: readonly { readonly start: number; readonly end: number }[]
}

interface ScalarNode {
  readonly kind: "scalar"
  readonly start: number
  readonly end: number
}

type Node = ObjectNode | ArrayNode | ScalarNode

interface Token {
  readonly type: "{" | "}" | "[" | "]" | ":" | "," | "string" | "scalar"
  readonly start: number
  readonly end: number
  readonly value?: string
}

export class JsoncEditError extends Error {}

const scan = (text: string): Token[] => {
  const tokens: Token[] = []
  let index = 0
  while (index < text.length) {
    const char = text[index]!
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      index += 1
      continue
    }
    if (char === "/" && text[index + 1] === "/") {
      index += 2
      while (index < text.length && text[index] !== "\n" && text[index] !== "\r") index += 1
      continue
    }
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2)
      if (end === -1) throw new JsoncEditError("unterminated block comment")
      index = end + 2
      continue
    }
    if (char === "{" || char === "}" || char === "[" || char === "]" || char === ":" || char === ",") {
      tokens.push({ type: char, start: index, end: index + 1 })
      index += 1
      continue
    }
    if (char === '"') {
      const start = index
      index += 1
      let escaped = false
      while (index < text.length) {
        const next = text[index]!
        if (escaped) {
          escaped = false
          index += 1
          continue
        }
        if (next === "\\") {
          escaped = true
          index += 1
          continue
        }
        if (next === '"') {
          index += 1
          break
        }
        index += 1
      }
      if (text[index - 1] !== '"') throw new JsoncEditError("unterminated string")
      tokens.push({ type: "string", start, end: index, value: JSON.parse(text.slice(start, index)) })
      continue
    }
    const start = index
    while (index < text.length && !/[\s{}\[\]:,"]/.test(text[index]!)) index += 1
    if (index === start) throw new JsoncEditError(`unexpected character ${JSON.stringify(char)}`)
    tokens.push({ type: "scalar", start, end: index })
  }
  return tokens
}

const parseNode = (tokens: readonly Token[], cursor: { index: number }): Node => {
  const token = tokens[cursor.index]
  if (token === undefined) throw new JsoncEditError("unexpected end of input")
  if (token.type === "{") {
    cursor.index += 1
    const members: Member[] = []
    while (true) {
      const next = tokens[cursor.index]
      if (next === undefined) throw new JsoncEditError("unterminated object")
      if (next.type === "}") {
        cursor.index += 1
        return { kind: "object", start: token.start, end: next.end, members }
      }
      if (next.type === ",") {
        cursor.index += 1
        continue
      }
      if (next.type !== "string" || next.value === undefined) throw new JsoncEditError("expected an object key")
      const key = next.value
      cursor.index += 1
      const colon = tokens[cursor.index]
      if (colon?.type !== ":") throw new JsoncEditError("expected ':' after a key")
      cursor.index += 1
      const value = parseNode(tokens, cursor)
      members.push({ key, keyStart: next.start, valueStart: value.start, valueEnd: value.end })
    }
  }
  if (token.type === "[") {
    cursor.index += 1
    const items: { start: number; end: number }[] = []
    while (true) {
      const next = tokens[cursor.index]
      if (next === undefined) throw new JsoncEditError("unterminated array")
      if (next.type === "]") {
        cursor.index += 1
        return { kind: "array", start: token.start, end: next.end, items }
      }
      if (next.type === ",") {
        cursor.index += 1
        continue
      }
      const value = parseNode(tokens, cursor)
      items.push({ start: value.start, end: value.end })
    }
  }
  if (token.type === "string" || token.type === "scalar") {
    cursor.index += 1
    return { kind: "scalar", start: token.start, end: token.end }
  }
  throw new JsoncEditError(`unexpected token ${JSON.stringify(token.type)}`)
}

export const parseRoot = (text: string): Node => parseNode(scan(text), { index: 0 })

const isObject = (node: Node): node is ObjectNode => node.kind === "object"

const memberOf = (node: ObjectNode, key: string): Member | undefined =>
  node.members.find((member) => member.key === key)

const lineStart = (text: string, offset: number): number => {
  let index = offset
  while (index > 0 && text[index - 1] !== "\n" && text[index - 1] !== "\r") index -= 1
  return index
}

const indentationOf = (text: string, offset: number): string => {
  const start = lineStart(text, offset)
  return text.slice(start, offset).match(/^[ \t]*/)?.[0] ?? ""
}

const detectUnit = (text: string, node: ObjectNode): string => {
  const closingIndent = indentationOf(text, node.end - 1)
  const first = node.members[0]
  if (first === undefined) return "  "
  const childIndent = indentationOf(text, first.keyStart)
  if (childIndent.length > closingIndent.length && childIndent.startsWith(closingIndent)) {
    return childIndent.slice(closingIndent.length)
  }
  return "  "
}

const render = (value: unknown, indent: string): string => {
  if (value === undefined) throw new JsoncEditError("cannot write undefined")
  const json = JSON.stringify(value, null, 2)
  return json.split("\n").join(`\n${indent}`)
}

const insertMember = (text: string, node: ObjectNode, key: string, value: unknown): string => {
  const closingIndent = indentationOf(text, node.end - 1)
  const unit = detectUnit(text, node)
  const childIndent = closingIndent + unit
  const rendered = render(value, childIndent)
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  const last = node.members[node.members.length - 1]
  if (last !== undefined) {
    const tail = text.slice(last.valueEnd, node.end - 1)
    const comma = tail.indexOf(",")
    // Insert before an existing trailing comma so that comma ends up after the
    // new member; otherwise append the separator ourselves. Either way the
    // comma separates the previous last value from the new member.
    const at = comma === -1 ? last.valueEnd : last.valueEnd + comma
    return `${text.slice(0, at)},${eol}${childIndent}${JSON.stringify(key)}: ${rendered}${text.slice(at)}`
  }
  // Empty object: `{}` or whitespace/comments only. Insert just after `{` and
  // keep whatever the user already had before `}`.
  const at = node.start + 1
  const closingOnOwnLine = /^\s*$/.test(text.slice(at, node.end - 1))
  const suffix = closingOnOwnLine ? `${eol}${closingIndent}` : ""
  return `${text.slice(0, at)}${eol}${childIndent}${JSON.stringify(key)}: ${rendered}${suffix}${text.slice(at)}`
}

const removeMember = (text: string, node: ObjectNode, member: Member): string => {
  const index = node.members.indexOf(member)
  const previous = index > 0 ? node.members[index - 1] : undefined
  const next = node.members[index + 1]
  const boundary = next === undefined ? node.end - 1 : next.keyStart
  const trailingComma = text.slice(member.valueEnd, boundary).indexOf(",")
  if (trailingComma !== -1) {
    // Drop the member and its own trailing comma. The previous separator (or
    // the opening brace for the first member) now separates the neighbours.
    const to = member.valueEnd + trailingComma + 1
    return `${text.slice(0, member.keyStart)}${text.slice(to)}`
  }
  if (previous !== undefined) {
    const comma = text.indexOf(",", previous.valueEnd)
    const from = comma !== -1 && comma < member.keyStart ? comma : member.keyStart
    return `${text.slice(0, from)}${text.slice(member.valueEnd)}`
  }
  return `${text.slice(0, member.keyStart)}${text.slice(member.valueEnd)}`
}

const setMember = (text: string, node: ObjectNode, key: string, value: unknown): string => {
  const member = memberOf(node, key)
  if (member === undefined) return value === undefined ? text : insertMember(text, node, key, value)
  if (value === undefined) return removeMember(text, node, member)
  const indent = indentationOf(text, member.keyStart)
  return `${text.slice(0, member.valueStart)}${render(value, indent)}${text.slice(member.valueEnd)}`
}

const pathError = (path: readonly string[]): JsoncEditError =>
  new JsoncEditError(`config path ${path.join(".")} does not resolve to an object`)

const emptyObjectAt = (text: string, node: ObjectNode): boolean => {
  const inner = text.slice(node.start + 1, node.end - 1)
  return node.members.length === 0 && inner.trim().length === 0
}

/**
 * Set `path` to `value`. `undefined` deletes the leaf and prunes parents that
 * become empty. Non-existent intermediate objects are created.
 */
export const set = (text: string, path: readonly string[], value: unknown): string => {
  if (path.length === 0) throw new JsoncEditError("config path must not be empty")
  const root = parseRoot(text)
  if (!isObject(root)) throw pathError([])
  return editIn(text, root, path, value)
}

const parseSpan = (text: string, start: number, end: number): Node => {
  const slice = text.slice(start, end)
  const node = parseRoot(slice)
  const shift = (input: Node): Node => {
    if (input.kind === "scalar") return { kind: "scalar", start: input.start + start, end: input.end + start }
    if (input.kind === "array") {
      return {
        kind: "array",
        start: input.start + start,
        end: input.end + start,
        items: input.items.map((item) => ({ start: item.start + start, end: item.end + start })),
      }
    }
    return {
      kind: "object",
      start: input.start + start,
      end: input.end + start,
      members: input.members.map((member) => ({
        key: member.key,
        keyStart: member.keyStart + start,
        valueStart: member.valueStart + start,
        valueEnd: member.valueEnd + start,
      })),
    }
  }
  return shift(node)
}

const editIn = (text: string, node: ObjectNode, path: readonly string[], value: unknown): string => {
  if (path.length === 0) throw new JsoncEditError("empty nested path")
  const key = path[0]!
  if (path.length === 1) return setMember(text, node, key, value)
  const member = memberOf(node, key)
  if (member === undefined) {
    if (value === undefined) return text
    const tail = path.slice(1).reduceRight<unknown>((acc, nextKey) => ({ [nextKey]: acc }), value)
    return setMember(text, node, key, tail)
  }
  const child = parseSpan(text, member.valueStart, member.valueEnd)
  if (!isObject(child)) throw pathError(path.slice(0, 1))
  const edited = editIn(text, child, path.slice(1), value)
  return edited
}

/**
 * Convenience wrapper for a top-level patch. `null` deletes the key,
 * `undefined` is ignored, everything else is written.
 */
export const patchTopLevel = (text: string, patch: Readonly<Record<string, unknown>>): string =>
  Object.entries(patch).reduce(
    (current, [key, value]) => (value === undefined ? current : set(current, [key], value === null ? undefined : value)),
    text,
  )

/** Delete a key path; parents that become empty objects are removed too. */
export const remove = (text: string, path: readonly string[]): string => {
  if (path.length === 0) throw new JsoncEditError("config path must not be empty")
  let current = set(text, path, undefined)
  // Prune empty parent objects bottom-up.
  for (let depth = path.length - 1; depth > 0; depth -= 1) {
    const root = parseRoot(current)
    if (!isObject(root)) break
    let node: ObjectNode = root
    for (let index = 0; index < depth - 1; index += 1) {
      const next = memberOf(node, path[index]!)
      if (next === undefined) return current
      const child = parseSpan(current, next.valueStart, next.valueEnd)
      if (!isObject(child)) return current
      node = child
    }
    const parent = memberOf(node, path[depth - 1]!)
    if (parent === undefined) return current
    const child = parseSpan(current, parent.valueStart, parent.valueEnd)
    if (isObject(child) && emptyObjectAt(current, child)) {
      current = set(current, path.slice(0, depth), undefined)
    } else {
      return current
    }
  }
  return current
}

export { insertMember, removeMember, setMember }
