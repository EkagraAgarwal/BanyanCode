/** @jsxImportSource @opentui/solid */
import { createContext, useContext, type ParentProps, Show, For, onCleanup } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useTheme } from "../context/theme"
import { useTerminalDimensions } from "@opentui/solid"
import { SplitBorder } from "./border"
import { TextAttributes } from "@opentui/core"
export type ToastOptions = {
  title?: string
  message: string
  variant: "info" | "success" | "warning" | "error"
  duration: number
}
type ToastInput = Omit<ToastOptions, "duration"> & { duration?: number }

export type ToastEntry = ToastOptions & { id: number }

const MAX_TOASTS = 3

export function Toast() {
  const toast = useToast()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

  return (
    <Show when={toast.toasts.length > 0}>
      <box
        position="absolute"
        justifyContent="flex-end"
        alignItems="flex-start"
        top={2}
        right={2}
        flexDirection="column"
        gap={1}
      >
        <For each={toast.toasts}>
          {(entry) => <ToastItem entry={entry} theme={theme} maxWidth={Math.min(60, dimensions().width - 6)} />}
        </For>
      </box>
    </Show>
  )
}

function ToastItem(props: { entry: ToastEntry; theme: ReturnType<typeof useTheme>["theme"]; maxWidth: number }) {
  const toast = useToast()
  const theme = () => props.theme
  const entry = props.entry

  let progress = 1
  let startTime = Date.now()
  let rafId: number | null = null

  const tick = () => {
    const elapsed = Date.now() - startTime
    progress = Math.max(0, 1 - elapsed / entry.duration)
    rafId = requestAnimationFrame(tick)
  }
  rafId = requestAnimationFrame(tick)
  onCleanup(() => { if (rafId !== null) cancelAnimationFrame(rafId) })

  return (
    <box
      position="relative"
      width={props.maxWidth}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      backgroundColor={theme().backgroundPanel}
      borderColor={theme()[entry.variant]}
      border={["left", "right", "top", "bottom"]}
      customBorderChars={SplitBorder.customBorderChars}
      onMouseUp={() => toast.dismiss(entry.id)}
    >
      <Show when={entry.title}>
        <text attributes={TextAttributes.BOLD} marginBottom={1} fg={theme().text}>
          {entry.title}
        </text>
      </Show>
      <text fg={theme().text} wrapMode="word" width="100%">
        {entry.message}
      </text>
      <box
        position="absolute"
        bottom={0}
        left={0}
        height={1}
        width={`${Math.round(progress * 100)}%`}
        backgroundColor={theme()[entry.variant]}
      />
    </box>
  )
}

let nextId = 0

function init() {
  const [store, setStore] = createStore<{ toasts: ToastEntry[] }>({
    toasts: [],
  })

  const toast = {
    show(options: ToastInput) {
      const toastOptions = { ...options, duration: options.duration ?? 5000 }
      setStore(
        produce((s) => {
          const entry: ToastEntry = { ...toastOptions, id: nextId++ }
          s.toasts.unshift(entry)
          if (s.toasts.length > MAX_TOASTS) {
            s.toasts = s.toasts.slice(0, MAX_TOASTS)
          }
        }),
      )
    },
    error(err: any) {
      if (err instanceof Error)
        return this.show({
          variant: "error",
          message: err.message,
        })
      this.show({
        variant: "error",
        message: "An unknown error has occurred",
      })
    },
    get toasts(): ToastEntry[] {
      return store.toasts
    },
    dismiss(id: number) {
      setStore("toasts", (t) => t.filter((x) => x.id !== id))
    },
  }
  return toast
}

export type ToastContext = ReturnType<typeof init>

const ctx = createContext<ToastContext>()

export function ToastProvider(props: ParentProps) {
  const value = init()
  return <ctx.Provider value={value}>{props.children}</ctx.Provider>
}

export function useToast() {
  const value = useContext(ctx)
  if (!value) {
    throw new Error("useToast must be used within a ToastProvider")
  }
  return value
}
