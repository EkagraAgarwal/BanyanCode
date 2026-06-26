import { onCleanup } from "solid-js"

export interface TelemetrySample {
  uptimeMs: number
  rssMB: number
  heapUsedMB: number
  externalMB: number
  activeHandles: number
  activeRequests: number
  queueDepths?: Record<string, number>
}

export function startTelemetry(intervalMs = 5000) {
  const startedAt = Date.now()
  const interval = setInterval(() => {
    const mem = process.memoryUsage()
    const sample: TelemetrySample = {
      uptimeMs: Date.now() - startedAt,
      rssMB: Math.round(mem.rss / 1024 / 1024),
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1028),
      externalMB: Math.round(mem.external / 1024 / 1024),
      activeHandles: (process as any)._getActiveHandles?.()?.length ?? -1,
      activeRequests: (process as any)._getActiveRequests?.()?.length ?? -1,
    }
    console.log(`[telemetry] uptime=${sample.uptimeMs}ms rss=${sample.rssMB}MB heap=${sample.heapUsedMB}MB handles=${sample.activeHandles} reqs=${sample.activeRequests}`)
  }, intervalMs)
  onCleanup(() => clearInterval(interval))
}

export function logEvent(event: string, data?: Record<string, unknown>) {
  console.log(`[event] ${event}`, data ? JSON.stringify(data) : "")
}

export function logError(scope: string, err: unknown, extra?: Record<string, unknown>) {
  const errInfo = err instanceof Error ? { message: err.message, stack: err.stack } : { value: String(err) }
  console.error(`[error] ${scope}:`, { ...errInfo, ...extra })
}
