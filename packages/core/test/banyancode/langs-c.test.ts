import { describe, expect, it } from "bun:test"
import { parseC } from "@opencode-ai/core/banyancode/langs/c"
import {
  getParserForPath,
  parseGeneric,
  parseMarkdown,
  parsePython,
  parseTypeScript,
} from "@opencode-ai/core/banyancode/langs/registry"

const C_FIXTURE = `#include <stdio.h>
#include "util.h"

#define MAX_MOVES 256
#define SQUARE(x) ((x) * (x))

typedef struct {
    int rank;
    int file;
} Square;

struct Board {
    int squares[64];
};

enum Color { WHITE, BLACK };

static int rank_of(int sq) {
    return sq / 8;
}

int square_name(int sq) {
    return rank_of(sq) * 8;
}

int global_count = 42;
`

describe("c parser", () => {
  it("extracts functions, types, macros and globals from a C file", () => {
    const result = parseC(C_FIXTURE, "c-file-id")

    const functions = result.nodes.filter((n) => n.kind === "function")
    const types = result.nodes.filter((n) => n.kind === "type")
    const variables = result.nodes.filter((n) => n.kind === "variable")

    expect(functions.map((n) => n.name).sort()).toEqual(["SQUARE", "rank_of", "square_name"])
    const rankOf = functions.find((n) => n.name === "rank_of")
    expect(rankOf?.startLine).toBe(18)
    expect(rankOf?.endLine).toBe(20)
    expect(functions.find((n) => n.name === "square_name")?.startLine).toBe(22)
    expect(functions.find((n) => n.name === "SQUARE")?.startLine).toBe(5)

    expect(types.map((n) => n.name).sort()).toEqual(["Board", "Color", "Square"])
    expect(types.find((n) => n.name === "Square")?.startLine).toBe(7)
    expect(types.find((n) => n.name === "Board")?.startLine).toBe(12)
    expect(types.find((n) => n.name === "Color")?.startLine).toBe(16)

    expect(variables.map((n) => n.name).sort()).toEqual(["MAX_MOVES", "global_count"])
    expect(variables.find((n) => n.name === "MAX_MOVES")?.startLine).toBe(4)
    expect(variables.find((n) => n.name === "global_count")?.startLine).toBe(26)

    // Locals and struct members never surface as symbols.
    expect(result.nodes.some((n) => n.name === "rank" || n.name === "file" || n.name === "squares")).toBe(false)
  })

  it("emits include edges, same-file call edges and parent edges", () => {
    const result = parseC(C_FIXTURE, "c-file-id")

    const imports = result.edges.filter((e) => e.kind === "imports")
    expect(imports.some((e) => e.toNodeID === "module:stdio.h")).toBe(true)
    expect(imports.some((e) => e.toNodeID === "module:util.h")).toBe(true)

    const squareName = result.nodes.find((n) => n.name === "square_name")
    const rankOf = result.nodes.find((n) => n.name === "rank_of")
    expect(
      result.edges.some((e) => e.kind === "calls" && e.fromNodeID === squareName?.id && e.toNodeID === rankOf?.id),
    ).toBe(true)

    // Every symbol points at its containing file node.
    const parentEdges = result.edges.filter((e) => e.toNodeID === "c-file-id:file" && e.kind === "references")
    expect(parentEdges.length).toBe(result.nodes.length)
  })
})

const CPP_FIXTURE = `#include <string>

class Player {
public:
    Player() {}
    void move(int x, int y) { pos_x = x; }
    int score() const { return pts; }
private:
    int pos_x;
    int pts;
};

template <typename T>
T max_of(T a, T b) {
    return a > b ? a : b;
}

int Player::win_count() const {
    return wins;
}
`

describe("c++ parser", () => {
  it("extracts classes with methods, templates and out-of-line methods", () => {
    const result = parseC(CPP_FIXTURE, "cpp-file-id")

    const classes = result.nodes.filter((n) => n.kind === "class")
    expect(classes.map((n) => n.name)).toEqual(["Player"])
    expect(classes[0]?.startLine).toBe(3)
    expect(classes[0]?.endLine).toBe(11)

    const methods = result.nodes.filter((n) => n.kind === "method")
    expect(methods.map((n) => n.name).sort()).toEqual(["move", "score"])
    expect(methods.find((n) => n.name === "move")?.startLine).toBe(6)
    expect(methods.find((n) => n.name === "score")?.startLine).toBe(7)

    const functions = result.nodes.filter((n) => n.kind === "function")
    expect(functions.map((n) => n.name).sort()).toEqual(["max_of", "win_count"])
    // max_of's declaration starts on its template line.
    expect(functions.find((n) => n.name === "max_of")?.startLine).toBe(13)
    expect(functions.find((n) => n.name === "win_count")?.startLine).toBe(18)

    // Class members are not top-level symbols; constructor is not a method node.
    expect(result.nodes.some((n) => n.name === "pos_x" || n.name === "pts")).toBe(false)
    expect(methods.some((n) => n.name === "Player")).toBe(false)
  })
})

describe("c parser robustness", () => {
  it("never throws on garbage input and returns empty results", () => {
    const garbage = `this is not c at all !!! ????
{{{{{{ unclosed braces
$%^&*() foo( bar
"string literal" int x = 5;
`
    let result: ReturnType<typeof parseC> = { nodes: [], edges: [] }
    expect(() => {
      result = parseC(garbage, "garbage-id")
    }).not.toThrow()
    expect(result.nodes.length).toBe(0)
    expect(result.edges.length).toBe(0)
  })

  it("survives an unclosed function body", () => {
    const result = parseC(`int open_fn(int x) {
    return x + 1;
`, "open-id")
    expect(result.nodes.some((n) => n.kind === "function" && n.name === "open_fn")).toBe(true)
  })
})

describe("parser routing", () => {
  it("routes C/C++ extensions to the C parser and leaves others unchanged", () => {
    expect(getParserForPath("src/main.c").parse).toBe(parseC)
    expect(getParserForPath("include/util.h").parse).toBe(parseC)
    expect(getParserForPath("src/engine.cpp").parse).toBe(parseC)
    expect(getParserForPath("src/engine.cc").parse).toBe(parseC)
    expect(getParserForPath("src/engine.cxx").parse).toBe(parseC)
    expect(getParserForPath("include/engine.hpp").parse).toBe(parseC)
    expect(getParserForPath("include/engine.hh").parse).toBe(parseC)
    expect(getParserForPath("include/engine.hxx").parse).toBe(parseC)
    expect(getParserForPath("main.py").parse).toBe(parsePython)
    expect(getParserForPath("main.ts").parse).toBe(parseTypeScript)
    expect(getParserForPath("readme.md").parse).toBe(parseMarkdown)
    expect(getParserForPath("data.xyz").parse).toBe(parseGeneric)
  })
})
