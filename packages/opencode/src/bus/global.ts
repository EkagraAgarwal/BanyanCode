import { EventEmitter } from "events"
import { Identifier } from "@/id/id"

export type GlobalEvent<T = any> = {
  directory?: string
  project?: string
  workspace?: string
  payload: T
}

class GlobalBusFacade {
  private readonly emitter = new EventEmitter<{
    event: [GlobalEvent]
  }>()

  emit(eventName: "event", event: GlobalEvent): boolean {
    if (event.payload && typeof event.payload === "object" && !("id" in event.payload)) {
      (event.payload as any).id = (event.payload as any).syncEvent?.id ?? Identifier.create("evt", "ascending")
    }
    return this.emitter.emit(eventName, event)
  }

  on(eventName: "event", listener: (event: GlobalEvent) => void): this {
    this.emitter.on(eventName, listener)
    return this
  }

  off(eventName: "event", listener: (event: GlobalEvent) => void): this {
    this.emitter.off(eventName, listener)
    return this
  }
}

export const GlobalBus = new GlobalBusFacade()
