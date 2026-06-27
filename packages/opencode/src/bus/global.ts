import { EventEmitter } from "events"
import { Identifier } from "@/id/id"

export type GlobalEvent<T = any> = {
  directory?: string
  project?: string
  workspace?: string
  payload: T
}

class GlobalBusEmitter extends EventEmitter<{
  event: [GlobalEvent]
}> {
  override emit(eventName: "event", event: GlobalEvent): boolean {
    if (event.payload && typeof event.payload === "object" && !("id" in event.payload)) {
      (event.payload as any).id = (event.payload as any).syncEvent?.id ?? Identifier.create("evt", "ascending")
    }
    return super.emit(eventName, event)
  }
}

export const GlobalBus = new GlobalBusEmitter()
