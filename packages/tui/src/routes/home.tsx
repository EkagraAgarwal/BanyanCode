import { Prompt, type PromptRef } from "../component/prompt"
import { createEffect, createMemo, createSignal, onMount, Show, untrack } from "solid-js"
import { Logo } from "../component/logo"
import { useArgs } from "../context/args"
import { useRouteData } from "../context/route"
import { usePromptRef } from "../context/prompt"
import { useLocal } from "../context/local"
import { useEditorContext } from "../context/editor"
import { useData } from "../context/data"
import { useLocation } from "../context/location"
import { FormPrompt } from "./session/form"
import { Slot } from "../plugin/render"
import { useTerminalDimensions } from "@opentui/solid"

let once = false
const placeholder = {
  normal: ["Fix a TODO in the codebase", "What is the tech stack of this project?", "Fix broken tests"],
  shell: ["ls -la", "git status", "pwd"],
}
/** Home's footer is one row, and it is not part of the measured content box. */
const HOME_FOOTER_ROWS = 1
/** The hero, prompt, resume block and footer fit inside 40 rows once the two breathing rows are dropped. */
const ROOMY_MIN_HEIGHT = 43

export function Home() {
  const route = useRouteData("home")
  const promptRef = usePromptRef()
  const [ref, setRef] = createSignal<PromptRef | undefined>()
  const args = useArgs()
  const local = useLocal()
  const editor = useEditorContext()
  const data = useData()
  const location = useLocation()
  const dimensions = useTerminalDimensions()
  // What Home really has: the host's tab strip and devtools bar take rows off the
  // viewport. The content box is measured, never derived from its own children, so
  // nothing feeds back into the layout.
  const [contentRows, setContentRows] = createSignal(Math.max(0, dimensions().height - HOME_FOOTER_ROWS))
  const homeRows = () => contentRows() + HOME_FOOTER_ROWS
  const roomy = () => homeRows() >= ROOMY_MIN_HEIGHT
  // Global MCP elicitations can arrive without a session route, so keep them reachable from Home.
  const currentLocation = () => route.location ?? data.location.default()
  const forms = createMemo(() => data.session.form.list("global", currentLocation()) ?? [])
  let sent = false

  // Track only the route location and (when absent) the default location; location.set
  // reads other signals internally and tracking them would re-assert the route location
  // after the user overrides it with /cd.
  createEffect(() => {
    const target = currentLocation()
    untrack(() => location.set(target))
  })

  onMount(() => {
    editor.clearSelection()
  })

  const bind = (r: PromptRef | undefined) => {
    setRef(r)
    promptRef.set(r)
    if (once || !r || route.prompt || !args.prompt) return
    r.set({ text: args.prompt, files: [], agents: [], pasted: [] })
    once = true
  }

  createEffect(() => {
    const composer = ref()
    const prompt = route.prompt
    if (!composer || prompt?.text === undefined) return
    untrack(() => composer.set(prompt))
  })

  // Wait for everything submit needs before auto-submitting --prompt; it runs once.
  createEffect(() => {
    const r = ref()
    if (sent) return
    if (!r) return
    if (!local.model.ready || !local.model.catalogReady) return
    if (!local.agent.current() || !local.model.current()) return
    if (!args.prompt) return
    if (r.current.text !== args.prompt) return
    sent = true
    r.submit()
  })

  return (
    <>
      <box
        flexGrow={1}
        minHeight={0}
        alignItems="center"
        paddingLeft={dimensions().width < 44 ? 1 : 2}
        paddingRight={dimensions().width < 44 ? 1 : 2}
        onSizeChange={function () {
          setContentRows(this.height)
        }}
      >
        {/* Equal spacers: the block is centred when the terminal is taller than
            it, and starts at the top when it is exactly as tall. */}
        <box flexGrow={1} minHeight={0} />
        <box width="100%" flexDirection="column" alignItems="center" flexShrink={0}>
          <Slot path="home.logo" input={{ height: homeRows }}>
            <Logo />
          </Slot>
          <Show when={roomy()}>
            <box height={1} flexShrink={0} />
          </Show>
          <box width="100%" maxWidth={75} zIndex={1000} position="relative" flexShrink={0}>
            {/* Home's own footer already carries the directory and branch, so the
                prompt drops its location/hint row here. It stays in sessions. */}
            <Prompt ref={bind} placeholders={placeholder} disabled={forms().length > 0} footer={false} />
          </box>
        </box>
        <Show when={roomy()}>
          <box height={1} flexShrink={0} />
        </Show>
        <Slot path="home.bottom" input={{ height: homeRows }} />
        <box flexGrow={1} minHeight={0} />
      </box>
      <box width="100%" flexShrink={0}>
        <Slot path="home.footer" />
      </box>
      <Show when={forms()[0]?.id} keyed>
        {(_) => {
          const form = forms()[0]
          return form ? (
            <box position="absolute" zIndex={2000} left={0} right={0} bottom={1} paddingLeft={2} paddingRight={2}>
              <box width="100%">
                <FormPrompt form={form} />
              </box>
            </box>
          ) : null
        }}
      </Show>
    </>
  )
}
