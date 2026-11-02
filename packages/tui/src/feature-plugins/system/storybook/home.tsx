import type { Plugin } from "@opencode/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createRoot, createSignal, onCleanup, onMount, Show } from "solid-js"
import { BanyanHero, createGrowth, type Growth } from "@banyancode/tui/home"
import { StoryFooter } from "./footer"
import type { Story } from "./index"

/**
 * The real home hero on the real growth clock, with the two things a story
 * needs: start over, and jump to the finished frame.
 */
function HomeStory(props: { context: Plugin.Context }) {
  const theme = props.context.theme
  const dimensions = useTerminalDimensions()
  const [player, setPlayer] = createSignal<{ growth: Growth; dispose: () => void }>()

  const play = () => {
    player()?.dispose()
    setPlayer(
      createRoot((dispose) => {
        const growth = createGrowth({ animations: () => props.context.ui.animations() })
        growth.start()
        return { growth, dispose }
      }),
    )
  }

  props.context.keymap.layer(() => ({
    commands: [
      {
        bind: "escape",
        title: "Back to storybook",
        group: "Storybook",
        run: () => props.context.ui.router.navigate({ type: "plugin", name: "storybook" }),
      },
      { bind: "r", title: "Replay growth", group: "Storybook", run: play },
      { bind: "s", title: "Skip to final frame", group: "Storybook", run: () => player()?.growth.finish() },
    ],
  }))

  onMount(play)
  onCleanup(() => player()?.dispose())

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      backgroundColor={theme.background.base}
    >
      <box flexGrow={1} width="100%" alignItems="center" paddingTop={1}>
        <Show when={player()}>
          {(item) => <BanyanHero context={props.context} growth={item().growth} />}
        </Show>
      </box>
      <StoryFooter
        context={props.context}
        title="home"
        details={["banyan hero", "real growth clock"]}
        controls={[
          { shortcut: "r", label: "replay" },
          { shortcut: "s", label: "final frame" },
          { shortcut: "esc", label: "storybook" },
        ]}
      />
    </box>
  )
}

export const homeStory: Story = {
  id: "home",
  title: "Home hero",
  render: (context) => <HomeStory context={context} />,
}
