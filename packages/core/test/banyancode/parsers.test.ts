import { describe, test, expect } from "bun:test"
import { parseTypeScript } from "../../src/banyancode/langs/typescript"
import { parseJavaScript } from "../../src/banyancode/langs/javascript"
import { parsePython } from "../../src/banyancode/langs/python"
import { parseGo } from "../../src/banyancode/langs/go"
import { parseRust } from "../../src/banyancode/langs/rust"

describe("TypeScript parser", () => {
  test("parses a simple function", () => {
    const content = `function hello() { return 1; }`
    const result = parseTypeScript(content, "file1", "src/hello.ts", "typescript")
    expect(result.nodes.length).toBeGreaterThanOrEqual(2) // function + file node
    const fnNode = result.nodes.find((n) => n.kind === "function")
    expect(fnNode).toBeDefined()
    expect(fnNode?.name).toBe("hello")
    expect(fnNode?.qualifiedName).toBe("src/hello.ts::hello")
  })

  test("parses a class", () => {
    const content = `class MyClass { }`
    const result = parseTypeScript(content, "file1", "src/MyClass.ts", "typescript")
    const classNode = result.nodes.find((n) => n.kind === "class")
    expect(classNode).toBeDefined()
    expect(classNode?.name).toBe("MyClass")
  })

  test("parses a file node", () => {
    const content = `function hello() { }`
    const result = parseTypeScript(content, "file1", "src/hello.ts", "typescript")
    const fileNode = result.nodes.find((n) => n.kind === "type" && n.name === "hello.ts")
    expect(fileNode).toBeDefined()
    expect(fileNode?.qualifiedName).toBe("src/hello.ts")
  })

  test("extracts qualified name from relative path", () => {
    const content = `function hello() { }`
    const result = parseTypeScript(content, "file1", "foo/bar/hello.ts", "typescript")
    const fnNode = result.nodes.find((n) => n.kind === "function")
    expect(fnNode?.qualifiedName).toBe("foo/bar/hello.ts::hello")
  })

  test("handles a multi-line class correctly", () => {
    const content = `class MyClass {
  property: string;
  method() { }
}`
    const result = parseTypeScript(content, "file1", "src/MyClass.ts", "typescript")
    const classNode = result.nodes.find((n) => n.kind === "class")
    expect(classNode).toBeDefined()
    expect(classNode?.endLine).toBeGreaterThan(classNode?.startLine ?? 0)
  })
})

describe("JavaScript parser", () => {
  test("parses a simple function", () => {
    const content = `function hello() { return 1; }`
    const result = parseJavaScript(content, "file1", "src/hello.js", "javascript")
    expect(result.nodes.length).toBeGreaterThanOrEqual(2)
    const fnNode = result.nodes.find((n) => n.kind === "function")
    expect(fnNode).toBeDefined()
    expect(fnNode?.name).toBe("hello")
  })

  test("parses a class", () => {
    const content = `class MyClass { }`
    const result = parseJavaScript(content, "file1", "src/MyClass.js", "javascript")
    const classNode = result.nodes.find((n) => n.kind === "class")
    expect(classNode).toBeDefined()
    expect(classNode?.name).toBe("MyClass")
  })

  test("parses a file node", () => {
    const content = `function hello() { }`
    const result = parseJavaScript(content, "file1", "src/hello.js", "javascript")
    const fileNode = result.nodes.find((n) => n.kind === "type" && n.name === "hello.js")
    expect(fileNode).toBeDefined()
  })

  test("extracts qualified name from relative path", () => {
    const content = `function hello() { }`
    const result = parseJavaScript(content, "file1", "foo/bar/hello.js", "javascript")
    const fnNode = result.nodes.find((n) => n.kind === "function")
    expect(fnNode?.qualifiedName).toBe("foo/bar/hello.js::hello")
  })

  test("parses a const/let/var declaration", () => {
    const content = `const myConst = 42;`
    const result = parseJavaScript(content, "file1", "src/const.js", "javascript")
    const varNode = result.nodes.find((n) => n.kind === "variable")
    expect(varNode).toBeDefined()
    expect(varNode?.name).toBe("myConst")
  })
})

describe("Python parser", () => {
  test("parses a simple function", () => {
    const content = `def hello():
    return 1`
    const result = parsePython(content, "file1", "src/hello.py", "python")
    expect(result.nodes.length).toBeGreaterThanOrEqual(2)
    const fnNode = result.nodes.find((n) => n.kind === "function")
    expect(fnNode).toBeDefined()
    expect(fnNode?.name).toBe("hello")
  })

  test("parses a class", () => {
    const content = `class MyClass:
    pass`
    const result = parsePython(content, "file1", "src/MyClass.py", "python")
    const classNode = result.nodes.find((n) => n.kind === "class")
    expect(classNode).toBeDefined()
    expect(classNode?.name).toBe("MyClass")
  })

  test("parses a file node", () => {
    const content = `def hello():
    pass`
    const result = parsePython(content, "file1", "src/hello.py", "python")
    const fileNode = result.nodes.find((n) => n.kind === "type" && n.name === "hello.py")
    expect(fileNode).toBeDefined()
  })

  test("extracts qualified name from relative path", () => {
    const content = `def hello():
    pass`
    const result = parsePython(content, "file1", "foo/bar/hello.py", "python")
    const fnNode = result.nodes.find((n) => n.kind === "function")
    expect(fnNode?.qualifiedName).toBe("foo/bar/hello.py::hello")
  })

  test("handles a multi-line class correctly", () => {
    const content = `class MyClass:
    def __init__(self):
        self.x = 1
    def method(self):
        pass`
    const result = parsePython(content, "file1", "src/MyClass.py", "python")
    const classNode = result.nodes.find((n) => n.kind === "class")
    expect(classNode).toBeDefined()
    expect(classNode?.endLine).toBeGreaterThan(classNode?.startLine ?? 0)
  })
})

describe("Go parser", () => {
  test("parses a simple function", () => {
    const content = `func hello() { return 1 }`
    const result = parseGo(content, "file1", "src/hello.go", "go")
    expect(result.nodes.length).toBeGreaterThanOrEqual(2)
    const fnNode = result.nodes.find((n) => n.kind === "function")
    expect(fnNode).toBeDefined()
    expect(fnNode?.name).toBe("hello")
  })

  test("parses a method", () => {
    const content = `func (r *Receiver) Method() { }`
    const result = parseGo(content, "file1", "src/receiver.go", "go")
    const methodNode = result.nodes.find((n) => n.kind === "method")
    expect(methodNode).toBeDefined()
    expect(methodNode?.name).toBe("Method")
    expect(methodNode?.qualifiedName).toBe("Receiver.Method")
  })

  test("parses a type", () => {
    const content = `type MyStruct struct { }`
    const result = parseGo(content, "file1", "src/my_struct.go", "go")
    const typeNode = result.nodes.find((n) => n.kind === "type")
    expect(typeNode).toBeDefined()
    expect(typeNode?.name).toBe("MyStruct")
  })

  test("parses a file node", () => {
    const content = `func hello() { }`
    const result = parseGo(content, "file1", "src/hello.go", "go")
    const fileNode = result.nodes.find((n) => n.kind === "type" && n.name === "hello.go")
    expect(fileNode).toBeDefined()
  })

  test("extracts qualified name from relative path", () => {
    const content = `func hello() { }`
    const result = parseGo(content, "file1", "foo/bar/hello.go", "go")
    const fnNode = result.nodes.find((n) => n.kind === "function")
    expect(fnNode?.qualifiedName).toBe("foo/bar/hello.go::hello")
  })
})

describe("Rust parser", () => {
  test("parses a simple function", () => {
    const content = `fn hello() { }`
    const result = parseRust(content, "file1", "src/hello.rs", "rust")
    expect(result.nodes.length).toBeGreaterThanOrEqual(2)
    const fnNode = result.nodes.find((n) => n.kind === "function")
    expect(fnNode).toBeDefined()
    expect(fnNode?.name).toBe("hello")
  })

  test("parses a struct", () => {
    const content = `struct MyStruct { field: i32 }`
    const result = parseRust(content, "file1", "src/my_struct.rs", "rust")
    const structNode = result.nodes.find((n) => n.kind === "type" && n.name === "MyStruct")
    expect(structNode).toBeDefined()
  })

  test("parses a trait", () => {
    const content = `trait MyTrait { fn method(&self); }`
    const result = parseRust(content, "file1", "src/my_trait.rs", "rust")
    const traitNode = result.nodes.find((n) => n.kind === "type" && n.name === "MyTrait")
    expect(traitNode).toBeDefined()
  })

  test("parses an enum", () => {
    const content = `enum MyEnum { A, B, C }`
    const result = parseRust(content, "file1", "src/my_enum.rs", "rust")
    const enumNode = result.nodes.find((n) => n.kind === "enum")
    expect(enumNode).toBeDefined()
    expect(enumNode?.name).toBe("MyEnum")
  })

  test("parses a file node", () => {
    const content = `fn hello() { }`
    const result = parseRust(content, "file1", "src/hello.rs", "rust")
    const fileNode = result.nodes.find((n) => n.kind === "type" && n.name === "hello.rs")
    expect(fileNode).toBeDefined()
  })

  test("extracts qualified name from relative path", () => {
    const content = `fn hello() { }`
    const result = parseRust(content, "file1", "foo/bar/hello.rs", "rust")
    const fnNode = result.nodes.find((n) => n.kind === "function")
    expect(fnNode?.qualifiedName).toBe("foo/bar/hello.rs::hello")
  })

  test("handles impl blocks correctly", () => {
    const content = `impl trait MyTrait for MyStruct { }`
    const result = parseRust(content, "file1", "src/impl.rs", "rust")
    // Find impl nodes that are NOT the file node
    const implNodes = result.nodes.filter((n) => n.kind === "type" && n.name.startsWith("impl "))
    expect(implNodes.length).toBeGreaterThan(0)
    const implNode = implNodes[0]
    expect(implNode?.name).toContain("impl")
    expect(implNode?.name).toContain("MyStruct")
  })
})