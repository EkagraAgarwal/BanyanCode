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

  test("emits imports edges with correct target_key", () => {
    const content = `import React from "react"
import { useState } from "react"
import * as utils from "./utils"
function hello() { }`
    const result = parseTypeScript(content, "file1", "src/App.tsx", "typescript")
    const importsEdges = result.edges.filter((e) => e.kind === "imports")
    expect(importsEdges.length).toBe(3)
    const reactEdge = importsEdges.find((e) => e.toTargetKey === "import:react")
    expect(reactEdge).toBeDefined()
    expect(reactEdge?.fromNodeID).toContain(":file:App.tsx")
    expect(reactEdge?.toNodeID).toBeUndefined()
    expect(reactEdge?.toTargetKey).toBe("import:react")
  })

  test("emits extends edges with correct target_key", () => {
    const content = `class Parent { }
class Child extends Parent { }
export class Extended extends Base { }`
    const result = parseTypeScript(content, "file1", "src/classes.ts", "typescript")
    const extendsEdges = result.edges.filter((e) => e.kind === "extends")
    expect(extendsEdges.length).toBe(2)
    const childExtends = extendsEdges.find((e) => e.toTargetKey === "Parent")
    expect(childExtends).toBeDefined()
    expect(childExtends?.fromNodeID).toContain(":class:Child")
    expect(childExtends?.toNodeID).toBeUndefined()
    expect(childExtends?.toTargetKey).toBe("Parent")
    const extendedExtends = extendsEdges.find((e) => e.toTargetKey === "Base")
    expect(extendedExtends).toBeDefined()
    expect(extendedExtends?.fromNodeID).toContain(":class:Extended")
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

  test("emits imports edges with correct target_key", () => {
    const content = `import React from "react"
import { useState } from "react"
import * as utils from "./utils"
function hello() { }`
    const result = parseJavaScript(content, "file1", "src/App.js", "javascript")
    const importsEdges = result.edges.filter((e) => e.kind === "imports")
    expect(importsEdges.length).toBe(3)
    const reactEdge = importsEdges.find((e) => e.toTargetKey === "import:react")
    expect(reactEdge).toBeDefined()
    expect(reactEdge?.fromNodeID).toContain(":file:App.js")
    expect(reactEdge?.toNodeID).toBeUndefined()
    expect(reactEdge?.toTargetKey).toBe("import:react")
  })

  test("emits extends edges with correct target_key", () => {
    const content = `class Parent { }
class Child extends Parent { }
export class Extended extends Base { }`
    const result = parseJavaScript(content, "file1", "src/classes.js", "javascript")
    const extendsEdges = result.edges.filter((e) => e.kind === "extends")
    expect(extendsEdges.length).toBe(2)
    const childExtends = extendsEdges.find((e) => e.toTargetKey === "Parent")
    expect(childExtends).toBeDefined()
    expect(childExtends?.fromNodeID).toContain(":class:Child")
    expect(childExtends?.toNodeID).toBeUndefined()
    expect(childExtends?.toTargetKey).toBe("Parent")
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

  test("emits imports edges with correct target_key", () => {
    // Python imports use quoted module paths: from "os" import path
    const content = `from "os" import path
from "sys" import path as sys_path
from "json" import JSONDecoder
def hello():
    pass`
    const result = parsePython(content, "file1", "src/app.py", "python")
    const importsEdges = result.edges.filter((e) => e.kind === "imports")
    expect(importsEdges.length).toBe(3)
    const osEdge = importsEdges.find((e) => e.toTargetKey === "import:os")
    expect(osEdge).toBeDefined()
    expect(osEdge?.fromNodeID).toContain(":file:app.py")
    expect(osEdge?.toNodeID).toBeUndefined()
    expect(osEdge?.toTargetKey).toBe("import:os")
    const sysEdge = importsEdges.find((e) => e.toTargetKey === "import:sys")
    expect(sysEdge).toBeDefined()
  })

  test("emits extends edges with correct target_key", () => {
    const content = `class Parent:
    pass

class Child(Parent):
    pass`
    const result = parsePython(content, "file1", "src/classes.py", "python")
    const extendsEdges = result.edges.filter((e) => e.kind === "extends")
    expect(extendsEdges.length).toBe(1)
    const childExtends = extendsEdges.find((e) => e.toTargetKey === "Parent")
    expect(childExtends).toBeDefined()
    expect(childExtends?.fromNodeID).toContain(":class:Child")
    expect(childExtends?.toNodeID).toBeUndefined()
    expect(childExtends?.toTargetKey).toBe("Parent")
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

  test("emits imports edges with correct target_key", () => {
    const content = `package main

import "fmt"
import "os"

func main() { }`
    const result = parseGo(content, "file1", "src/main.go", "go")
    const importsEdges = result.edges.filter((e) => e.kind === "imports")
    expect(importsEdges.length).toBe(2)
    const fmtEdge = importsEdges.find((e) => e.toTargetKey === "import:fmt")
    expect(fmtEdge).toBeDefined()
    expect(fmtEdge?.fromNodeID).toContain(":file:main.go")
    expect(fmtEdge?.toNodeID).toBeUndefined()
    expect(fmtEdge?.toTargetKey).toBe("import:fmt")
  })

  test("emits imports edges for multi-line import blocks", () => {
    const content = `package main

import (
    "fmt"
    "os"
    io "io"
)

func main() { }`
    const result = parseGo(content, "file1", "src/main.go", "go")
    const importsEdges = result.edges.filter((e) => e.kind === "imports")
    expect(importsEdges.length).toBe(3)
    const fmtEdge = importsEdges.find((e) => e.toTargetKey === "import:fmt")
    expect(fmtEdge).toBeDefined()
    const osEdge = importsEdges.find((e) => e.toTargetKey === "import:os")
    expect(osEdge).toBeDefined()
    const ioEdge = importsEdges.find((e) => e.toTargetKey === "import:io")
    expect(ioEdge).toBeDefined()
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

  test("emits imports edges with correct target_key", () => {
    const content = `use std::collections::HashMap;
use crate::module::something;
mod inner;
fn hello() { }`
    const result = parseRust(content, "file1", "src/lib.rs", "rust")
    const importsEdges = result.edges.filter((e) => e.kind === "imports")
    expect(importsEdges.length).toBe(3)
    const stdEdge = importsEdges.find((e) => e.toTargetKey === "import:std::collections::HashMap")
    expect(stdEdge).toBeDefined()
    expect(stdEdge?.fromNodeID).toContain(":file:lib.rs")
    expect(stdEdge?.toNodeID).toBeUndefined()
    const crateEdge = importsEdges.find((e) => e.toTargetKey === "import:crate::module::something")
    expect(crateEdge).toBeDefined()
    const modEdge = importsEdges.find((e) => e.toTargetKey === "import:inner")
    expect(modEdge).toBeDefined()
  })
})