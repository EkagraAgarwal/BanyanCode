export type Driver = "bun:sqlite" | "node:sqlite"

export interface NativeStatement {
  all(...params: readonly unknown[]): unknown[]
  get(...params: readonly unknown[]): unknown
  run(...params: readonly unknown[]): unknown
}

/**
 * Minimal cross-runtime SQLite surface. `bun:sqlite` and `node:sqlite` both
 * expose these calls; keeping the interface here lets the conditional
 * `#sqlite` import in driver.ts resolve to either implementation without
 * leaking Bun-only or Node-only types into the rest of the package.
 */
export interface NativeDatabase {
  readonly driver: Driver
  exec(sql: string): void
  prepare(sql: string): NativeStatement
  close(): void
}
