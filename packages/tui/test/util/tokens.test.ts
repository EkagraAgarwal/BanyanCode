import { describe, expect, test } from "bun:test"
import { density, fontWeight, glyph, separator, space } from "../../src/ui/tokens"

describe("ui/tokens", () => {
  test("space scale is monotonically non-decreasing and zero-anchored", () => {
    expect(space.none).toBe(0)
    expect(space.xs).toBeLessThanOrEqual(space.sm)
    expect(space.sm).toBeLessThanOrEqual(space.md)
    expect(space.md).toBeLessThanOrEqual(space.lg)
    expect(space.lg).toBeLessThanOrEqual(space.xl)
  })

  test("density reuses space scale", () => {
    expect(density.rowGap).toBe(space.sm)
    expect(density.sectionGap).toBe(space.md)
    expect(density.columnGap).toBe(space.sm)
    expect(density.blockGap).toBe(space.lg)
  })

  test("fontWeight is well-ordered", () => {
    expect(fontWeight.regular).toBeLessThan(fontWeight.bold)
    expect(fontWeight.bold).toBeLessThanOrEqual(fontWeight.dim)
  })

  test("glyph set covers empty-state lifecycle and tree glyphs", () => {
    expect(glyph.loading).toBe("◌")
    expect(glyph.empty).toBe("∅")
    expect(glyph.bullet).toBe("●")
    expect(glyph.circle).toBe("○")
    expect(glyph.cross).toBe("✗")
    expect(glyph.expand).toBe("▼")
    expect(glyph.collapse).toBe("▶")
    expect(glyph.branch).toBeTruthy()
    expect(glyph.corner).toBeTruthy()
    expect(glyph.pipe).toBeTruthy()
    expect(glyph.tee).toBeTruthy()
  })

  test("separator variants differ", () => {
    expect(separator.thin).not.toBe(separator.thick)
    expect(separator.thick).not.toBe(separator.double)
  })
})
