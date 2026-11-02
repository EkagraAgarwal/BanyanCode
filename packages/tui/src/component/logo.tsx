import { RGBA, TextAttributes } from "@opentui/core"
import { For, type JSX } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../context/theme"
import { tint } from "../theme/color"
import { logo, splash } from "../logo"

const TREE = RGBA.fromInts(34, 139, 34)
const SPLASH_WIDTH = splash[0]!.length
const SPLASH_HEIGHT = 36

export function Logo() {
  const theme = useTheme()
  const dimensions = useTerminalDimensions()

  const renderLine = (line: string, fg: RGBA, bold: boolean): JSX.Element[] => {
    const shadow = tint(theme.background.base, fg, 0.25)
    const attrs = bold ? TextAttributes.BOLD : undefined
    return Array.from(line).map((char) => {
      if (char === "_") {
        return (
          <text fg={fg} bg={shadow} attributes={attrs} selectable={false}>
            {" "}
          </text>
        )
      }
      if (char === "^") {
        return (
          <text fg={fg} bg={shadow} attributes={attrs} selectable={false}>
            ▀
          </text>
        )
      }
      if (char === "~") {
        return (
          <text fg={shadow} attributes={attrs} selectable={false}>
            ▀
          </text>
        )
      }
      if (char === ",") {
        return (
          <text fg={shadow} attributes={attrs} selectable={false}>
            ▄
          </text>
        )
      }
      return (
        <text fg={fg} attributes={attrs} selectable={false}>
          {char}
        </text>
      )
    })
  }

  // The tree is fixed green and the wordmark follows the theme, so it stays readable on a light background.
  const renderSplashLine = (line: string): JSX.Element[] =>
    line
      .split(/(█+)/)
      .filter((run) => run !== "")
      .map((run) => (
        <text
          fg={run.startsWith("█") ? theme.text.base : TREE}
          attributes={run.startsWith("█") ? TextAttributes.BOLD : undefined}
          selectable={false}
        >
          {run}
        </text>
      ))

  return (
    <box>
      {dimensions().height < 12 ? null : dimensions().width < 40 ? (
        <text fg={theme.text.base} attributes={TextAttributes.BOLD} selectable={false}>
          BanyanCode
        </text>
      ) : dimensions().width >= SPLASH_WIDTH + 4 && dimensions().height >= SPLASH_HEIGHT ? (
        <For each={splash}>{(line) => <box flexDirection="row">{renderSplashLine(line)}</box>}</For>
      ) : dimensions().width < 64 ? (
        <>
          <For each={logo.left.slice(1)}>
            {(line) => <box flexDirection="row">{renderLine(line, theme.text.muted, false)}</box>}
          </For>
          <For each={logo.right}>
            {(line) => <box flexDirection="row">{renderLine(line, theme.text.base, true)}</box>}
          </For>
        </>
      ) : (
        <For each={logo.left}>
          {(line, index) => (
            <box flexDirection="row" gap={1}>
              <box flexDirection="row">{renderLine(line, theme.text.muted, false)}</box>
              <box flexDirection="row">{renderLine(logo.right[index()], theme.text.base, true)}</box>
            </box>
          )}
        </For>
      )}
    </box>
  )
}
