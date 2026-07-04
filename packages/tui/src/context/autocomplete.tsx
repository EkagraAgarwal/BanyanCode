/** @jsxImportSource @opentui/solid */
import { createContext, useContext, type ParentProps } from "solid-js"
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
  visible: () => false | "@" | "/"
  anchor: () => BoxRenderable | null
  input: () => TextareaRenderable | null
  getProps: () => AutocompleteContextProps
}

const AutocompleteCtx = createContext<AutocompleteContextValue>()

export function useAutocomplete(): AutocompleteContextValue {
  const value = useContext(AutocompleteCtx)
  if (!value) throw new Error("Autocomplete context must be used within a context provider")
  return value
}

export function AutocompleteProvider(
  props: ParentProps<{
    anchor: () => BoxRenderable
    input: () => TextareaRenderable
    setPrompt: (cb: (draft: PromptInfo) => void) => void
    setExtmark: (partIndex: number, extmarkId: number) => void
    value: string
    fileStyleId: number
    agentStyleId: number
    promptPartTypeId: () => number
    sessionID?: string
    setAuto: (ref: AutocompleteRef | undefined) => void
  }>,
) {
  let autoRef: AutocompleteRef | undefined

  const value: AutocompleteContextValue = {
    visible: () => autoRef?.visible ?? false,
    anchor: () => props.anchor() ?? null,
    input: () => props.input() ?? null,
    getProps: () => ({
      sessionID: props.sessionID,
      setPrompt: props.setPrompt,
      setExtmark: props.setExtmark,
      value: props.value,
      fileStyleId: props.fileStyleId,
      agentStyleId: props.agentStyleId,
      promptPartTypeId: props.promptPartTypeId,
      anchor: () => props.anchor(),
      input: () => props.input(),
      ref: (r) => {
        autoRef = r
        props.setAuto(r)
      },
    }),
  }

  return <AutocompleteCtx.Provider value={value}>{props.children}</AutocompleteCtx.Provider>
}