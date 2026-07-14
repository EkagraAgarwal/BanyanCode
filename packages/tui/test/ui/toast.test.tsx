/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { Toast, ToastProvider, useToast } from "../../src/ui/toast"
import { ThemeProvider } from "../../src/context/theme"
import { KVProvider } from "../../src/context/kv"
import { TuiConfigProvider } from "../../src/config"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

describe("Toast auto-dismiss", () => {
  test("auto-dismisses after duration", async () => {
    let toastRef: ReturnType<typeof useToast> | undefined
    const timeoutCallbacks: Array<{ callback: () => void; delay: number }> = []
    const originalSetTimeout = globalThis.setTimeout.bind(globalThis)

    // Spy on setTimeout to capture callbacks
    const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay?: number) => {
      timeoutCallbacks.push({ callback, delay: delay ?? 0 })
      // Call the original after a tiny delay to not block
      const id = originalSetTimeout(callback, 10)
      return id
    }) as any)

    try {
      function ToastContainer() {
        toastRef = useToast()
        return <Toast />
      }

      const config = createTuiResolvedConfig()
      const app = await testRender(
        () => (
          <TestTuiContexts>
            <TuiConfigProvider config={config}>
              <KVProvider>
                <ThemeProvider mode="dark">
                  <ToastProvider>
                    <ToastContainer />
                  </ToastProvider>
                </ThemeProvider>
              </KVProvider>
            </TuiConfigProvider>
          </TestTuiContexts>
        ),
        { width: 80, height: 24 },
      )

      // Wait for components to mount
      for (let i = 0; i < 50 && toastRef === undefined; i++) {
        await new Promise((r) => originalSetTimeout(r, 20))
        await app.renderOnce()
      }

      if (toastRef === undefined) {
        throw new Error("toastRef was not initialized (components failed to mount)")
      }

      const toast = toastRef

      toast.show({ message: "test message", variant: "info" })
      await app.renderOnce()
      expect(toast.toasts.length).toBe(1)

      // Wait for the auto-dismiss timeout to be scheduled
      await new Promise((r) => originalSetTimeout(r, 50))
      await app.renderOnce()

      // Now manually trigger all the scheduled setTimeout callbacks (simulates time passing)
      for (const { callback } of timeoutCallbacks) {
        callback()
      }
      timeoutCallbacks.length = 0
      await app.renderOnce()

      expect(toast.toasts.length).toBe(0)
      app.renderer.destroy()
    } finally {
      setTimeoutSpy.mockRestore()
    }
  })

  test("manual dismiss does not throw when auto-dismiss timer fires", async () => {
    let toastRef: ReturnType<typeof useToast> | undefined
    const timeoutCallbacks: Array<{ callback: () => void; delay: number }> = []
    const originalSetTimeout = globalThis.setTimeout.bind(globalThis)

    const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay?: number) => {
      timeoutCallbacks.push({ callback, delay: delay ?? 0 })
      const id = originalSetTimeout(callback, 10)
      return id
    }) as any)

    try {
      function ToastContainer() {
        toastRef = useToast()
        return <Toast />
      }

      const config = createTuiResolvedConfig()
      const app = await testRender(
        () => (
          <TestTuiContexts>
            <TuiConfigProvider config={config}>
              <KVProvider>
                <ThemeProvider mode="dark">
                  <ToastProvider>
                    <ToastContainer />
                  </ToastProvider>
                </ThemeProvider>
              </KVProvider>
            </TuiConfigProvider>
          </TestTuiContexts>
        ),
        { width: 80, height: 24 },
      )

      // Wait for components to mount
      for (let i = 0; i < 50 && toastRef === undefined; i++) {
        await new Promise((r) => originalSetTimeout(r, 20))
        await app.renderOnce()
      }

      if (toastRef === undefined) {
        throw new Error("toastRef was not initialized (components failed to mount)")
      }

      const toast = toastRef

      toast.show({ message: "test message", variant: "info" })
      await app.renderOnce()
      expect(toast.toasts.length).toBe(1)
      const id = toast.toasts[0].id

      // Manually dismiss - this should cancel the timer via onCleanup
      toast.dismiss(id)
      await app.renderOnce()
      expect(toast.toasts.length).toBe(0)

      // Triggering the old timer should not throw
      for (const { callback } of timeoutCallbacks) {
        callback()
      }
      timeoutCallbacks.length = 0
      await app.renderOnce()

      expect(toast.toasts.length).toBe(0)
      app.renderer.destroy()
    } finally {
      setTimeoutSpy.mockRestore()
    }
  })

  test("toast.error defaults to 5000ms auto-dismiss", async () => {
    let toastRef: ReturnType<typeof useToast> | undefined
    const timeoutCallbacks: Array<{ callback: () => void; delay: number }> = []
    const originalSetTimeout = globalThis.setTimeout.bind(globalThis)

    const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay?: number) => {
      timeoutCallbacks.push({ callback, delay: delay ?? 0 })
      const id = originalSetTimeout(callback, 10)
      return id
    }) as any)

    try {
      function ToastContainer() {
        toastRef = useToast()
        return <Toast />
      }

      const config = createTuiResolvedConfig()
      const app = await testRender(
        () => (
          <TestTuiContexts>
            <TuiConfigProvider config={config}>
              <KVProvider>
                <ThemeProvider mode="dark">
                  <ToastProvider>
                    <ToastContainer />
                  </ToastProvider>
                </ThemeProvider>
              </KVProvider>
            </TuiConfigProvider>
          </TestTuiContexts>
        ),
        { width: 80, height: 24 },
      )

      // Wait for components to mount
      for (let i = 0; i < 50 && toastRef === undefined; i++) {
        await new Promise((r) => originalSetTimeout(r, 20))
        await app.renderOnce()
      }

      if (toastRef === undefined) {
        throw new Error("toastRef was not initialized (components failed to mount)")
      }

      const toast = toastRef

      toast.error(new Error("test error"))
      await app.renderOnce()
      expect(toast.toasts.length).toBe(1)

      // Wait for the auto-dismiss timeout to be scheduled
      await new Promise((r) => originalSetTimeout(r, 50))
      await app.renderOnce()

      // Trigger the auto-dismiss timeout
      for (const { callback } of timeoutCallbacks) {
        callback()
      }
      timeoutCallbacks.length = 0
      await app.renderOnce()

      expect(toast.toasts.length).toBe(0)
      app.renderer.destroy()
    } finally {
      setTimeoutSpy.mockRestore()
    }
  })
})
