/**
 * Output helpers for the BanyanCode CLI subcommands.
 *
 * v1 printed these commands through `UI.println`, which writes to **stderr**
 * with a fixed ANSI palette. Scripts that captured `2>&1` (or asserted on the
 * styled text) depend on both facts, so this module reproduces them instead of
 * using the v2 `process.stdout.write` convention. Machine-readable payloads
 * (JSON / JSONL) keep going to stdout.
 */
import { EOL } from "node:os"

export const Style = {
  TEXT_HIGHLIGHT: "\x1b[96m",
  TEXT_HIGHLIGHT_BOLD: "\x1b[96m\x1b[1m",
  TEXT_DIM: "\x1b[90m",
  TEXT_DIM_BOLD: "\x1b[90m\x1b[1m",
  TEXT_NORMAL: "\x1b[0m",
  TEXT_NORMAL_BOLD: "\x1b[1m",
  TEXT_WARNING: "\x1b[93m",
  TEXT_WARNING_BOLD: "\x1b[93m\x1b[1m",
  TEXT_DANGER: "\x1b[91m",
  TEXT_DANGER_BOLD: "\x1b[91m\x1b[1m",
  TEXT_SUCCESS: "\x1b[92m",
  TEXT_SUCCESS_BOLD: "\x1b[92m\x1b[1m",
  TEXT_INFO: "\x1b[94m",
  TEXT_INFO_BOLD: "\x1b[94m\x1b[1m",
} as const

export const dim = (value: string) => Style.TEXT_DIM + value + Style.TEXT_NORMAL

export function print(...message: string[]) {
  process.stderr.write(message.join(" "))
}

export function println(...message: string[]) {
  print(...message)
  process.stderr.write(EOL)
}

export function out(value: string) {
  process.stdout.write(value + EOL)
}
