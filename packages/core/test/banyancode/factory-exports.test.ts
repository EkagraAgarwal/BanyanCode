import { describe, expect, it } from "bun:test"
import { parseTypeScript } from "@opencode-ai/core/banyancode/langs/typescript"

describe("Factory export indexing", () => {
  it("indexes Tool.define factory export", () => {
    const code = `export const TaskTool = Tool.define({
  name: "task",
  handlers: {}
})`
    const result = parseTypeScript(code, "test-file-id")
    const node = result.nodes.find((n) => n.name === "TaskTool")
    expect(node).toBeDefined()
    expect(node?.kind).toBe("function")
    expect(node?.signature).toBe("Tool.define")
    expect(node?.id).toBe("test-file-id:factory:TaskTool:1")
  })

  it("indexes Tool.define with generic type parameter", () => {
    const code = `export const TaskTool = Tool.define<ToolInput>({
  name: "task",
  handlers: {}
})`
    const result = parseTypeScript(code, "test-file-id")
    const node = result.nodes.find((n) => n.name === "TaskTool")
    expect(node).toBeDefined()
    expect(node?.kind).toBe("function")
    expect(node?.signature).toBe("Tool.define<ToolInput>")
    expect(node?.id).toBe("test-file-id:factory:TaskTool:1")
  })

  it("indexes Layer.effect factory export", () => {
    const code = `export const layer = Layer.effect(MyService, Effect.fn("MyService.get")(function* () {
  yield* Effect.succeed("hello")
}))`
    const result = parseTypeScript(code, "test-file-id")
    const node = result.nodes.find((n) => n.name === "layer")
    expect(node).toBeDefined()
    expect(node?.kind).toBe("function")
    expect(node?.signature).toBe("Layer.effect")
    expect(node?.id).toBe("test-file-id:factory:layer:1")
  })

  it("indexes Layer.effect with generic type parameter", () => {
    const code = `export const layer = Layer.effect<MyService>(Effect.fn("MyService.get")(function* () {}))`
    const result = parseTypeScript(code, "test-file-id")
    const node = result.nodes.find((n) => n.name === "layer")
    expect(node).toBeDefined()
    expect(node?.signature).toBe("Layer.effect<MyService>")
  })

  it("indexes Layer.succeed factory export", () => {
    const code = `export const layer = Layer.succeed(MyService, { value: "hello" })`
    const result = parseTypeScript(code, "test-file-id")
    const node = result.nodes.find((n) => n.name === "layer")
    expect(node).toBeDefined()
    expect(node?.signature).toBe("Layer.succeed")
  })

  it("indexes Layer.scoped factory export", () => {
    const code = `export const layer = Layer.scoped(MyService, Effect.gen(function* () {}))`
    const result = parseTypeScript(code, "test-file-id")
    const node = result.nodes.find((n) => n.name === "layer")
    expect(node).toBeDefined()
    expect(node?.signature).toBe("Layer.scoped")
  })

  it("indexes Context.Service factory export", () => {
    const code = `export const Service = Context.Service({
  name: "my-service"
})`
    const result = parseTypeScript(code, "test-file-id")
    const node = result.nodes.find((n) => n.name === "Service")
    expect(node).toBeDefined()
    expect(node?.signature).toBe("Context.Service")
  })

  it("indexes Context.Tag factory export with generics", () => {
    const code = `export const MyTag = Context.Tag<MyService>("my-service")`
    const result = parseTypeScript(code, "test-file-id")
    const node = result.nodes.find((n) => n.name === "MyTag")
    expect(node).toBeDefined()
    expect(node?.signature).toBe("Context.Tag<MyService>")
  })

  it("indexes Layer.mergeAll factory export", () => {
    const code = `export const layer = Layer.mergeAll(layerA, layerB)`
    const result = parseTypeScript(code, "test-file-id")
    const node = result.nodes.find((n) => n.name === "layer")
    expect(node).toBeDefined()
    expect(node?.signature).toBe("Layer.mergeAll")
  })

  it("produces no factory nodes when none exist", () => {
    const code = `export const foo = (input: string) => input
export interface Bar { }
export type Baz = string`
    const result = parseTypeScript(code, "test-file-id")
    const factoryNodes = result.nodes.filter((n) => n.id.includes(":factory:"))
    expect(factoryNodes).toHaveLength(0)
  })

  it("indexes both factory export and arrow const in same file", () => {
    const code = `export const TaskTool = Tool.define({
  name: "task"
})

export const handler = (input: string) => input`
    const result = parseTypeScript(code, "test-file-id")
    const factoryNode = result.nodes.find((n) => n.id.includes(":factory:TaskTool"))
    const arrowNode = result.nodes.find((n) => n.name === "handler" && n.id.includes(":function:"))
    expect(factoryNode).toBeDefined()
    expect(factoryNode?.signature).toBe("Tool.define")
    expect(arrowNode).toBeDefined()
    expect(arrowNode?.signature).toContain("=>")
  })

  it("factory export takes priority over arrow const for same name", () => {
    const code = `export const TaskTool = Tool.define({ name: "task" })
export const TaskTool = (input: string) => input`
    const result = parseTypeScript(code, "test-file-id")
    const factoryNodes = result.nodes.filter((n) => n.id.includes(":factory:TaskTool"))
    expect(factoryNodes).toHaveLength(1)
    expect(factoryNodes[0]?.signature).toBe("Tool.define")
  })

  it("multiline factory export is fully captured", () => {
    const code = `export const TaskTool = Tool.define(
  {
    name: "task",
    handlers: {}
  },
  {
    timeout: 5000
  }
)`
    const result = parseTypeScript(code, "test-file-id")
    const node = result.nodes.find((n) => n.name === "TaskTool")
    expect(node).toBeDefined()
    expect(node?.code).toContain("Tool.define(")
    expect(node?.code).toContain("name: \"task\"")
    expect(node?.endLine).toBeGreaterThan(1)
  })
})
