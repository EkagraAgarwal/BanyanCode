/** @jsxImportSource @opentui/solid */
import { createContext, createSignal, useContext, type ParentProps } from "solid-js"
import type { BoxRenderable, TextareaRenderable } from "@opentui/core"
import { type AutocompleteRef } from "../component/prompt/autocomplete"
import type { PromptInfo } from "../prompt/history"

export { Autocomplete } from "../component/prompt/autocomplete"
export type { AutocompleteRef } from "../component/prompt/autocomplete"

export type AutocompleteContextProps = {
  sessionID?: string
  setPrompt: (cb: (draft: PromptInfo) => void) => void
  setExtmark: (partIndex: number, extmarkId: number) => void
  value: string
  fileStyleId: number
  agentStyleId: number
  promptPartTypeId: () => number
  anchor: () => BoxRenderable
  input: () => TextareaRenderable
  ref: (ref: AutocompleteRef) => void
}

export type AutocompleteContextValue = {
  register: (props: AutocompleteContextProps | undefined) => void
  getProps: () => AutocompleteContextProps | undefined
}

const AutocompleteCtx = createContext<AutocompleteContextValue>()

export function useAutocomplete(): AutocompleteContextValue {
  const value = useContext(AutocompleteCtx)
  if (!value) throw new Error("Autocomplete context must be used within a context provider")
  return value
}

export function AutocompleteProvider(props: ParentProps) {
  const [current, setCurrent] = createSignal<AutocompleteContextProps | undefined>(undefined)
  const value: AutocompleteContextValue = {
    register: setCurrent,
    getProps: current,
  }
  return <AutocompleteCtx.Provider value={value}>{props.children}</AutocompleteCtx.Provider>
}
