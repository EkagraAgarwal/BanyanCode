import type {
  ComposerInterceptResult,
  ComposerInterceptor,
  ComposerRoute,
  ComposerRouteResolver,
  ComposerSuggestion,
  ComposerSuggestionProvider,
} from "@opencode/plugin/tui/context"
import { createSignal, type Accessor } from "solid-js"
import { createSimpleContext } from "./helper"

/**
 * The composer's plugin seams. A surface that replaces the transcript (a panel
 * presented as `main`) registers what it needs while it is mounted and the
 * cleanup runs on unmount, so the plain Chat composer is exactly what it was.
 *
 * Everything the prompt reads is a signal or a body of resolvers read at use
 * time, so the prompt only re-renders when a seam actually answers.
 */
export interface ComposerState {
  /** Replaces the prompt's empty-state placeholder; undefined restores the host's rotation. */
  readonly placeholder: Accessor<string | undefined>
  readonly setPlaceholder: (text: string | undefined) => void
  intercept(handler: ComposerInterceptor): () => void
  suggest(provider: ComposerSuggestionProvider): () => void
  route(resolver: ComposerRouteResolver): () => void
  /** Runs the interceptors newest first; the first claim wins. */
  interceptSubmit(text: string): Promise<ComposerInterceptResult | undefined>
  /** Every suggestion for one `@` query, in registration order, deduplicated by display. */
  suggestions(query: string): readonly ComposerSuggestion[]
  /** Where `text` will go: the newest resolver with an answer. */
  routeOf(text: string): ComposerRoute | undefined
}

function insert<T>(list: readonly T[], value: T): readonly T[] {
  return [...list, value]
}

function remove<T>(list: readonly T[], value: T): readonly T[] {
  const index = list.indexOf(value)
  if (index === -1) return list
  return [...list.slice(0, index), ...list.slice(index + 1)]
}

export function createComposerState(): ComposerState {
  const [placeholder, setPlaceholder] = createSignal<string | undefined>(undefined)
  // Registries are signals so a provider registered while the picker is open
  // re-runs the memo that draws it.
  const [interceptors, setInterceptors] = createSignal<readonly ComposerInterceptor[]>([])
  const [suggesters, setSuggesters] = createSignal<readonly ComposerSuggestionProvider[]>([])
  const [resolvers, setResolvers] = createSignal<readonly ComposerRouteResolver[]>([])

  return {
    placeholder,
    setPlaceholder,
    intercept(handler) {
      setInterceptors((list) => insert(list, handler))
      return () => setInterceptors((list) => remove(list, handler))
    },
    suggest(provider) {
      setSuggesters((list) => insert(list, provider))
      return () => setSuggesters((list) => remove(list, provider))
    },
    route(resolver) {
      setResolvers((list) => insert(list, resolver))
      return () => setResolvers((list) => remove(list, resolver))
    },
    async interceptSubmit(text) {
      for (const handler of [...interceptors()].reverse()) {
        const result = await handler(text)
        if (result?.handled === true) return result
      }
      return undefined
    },
    suggestions(query) {
      const found: ComposerSuggestion[] = []
      const seen = new Set<string>()
      for (const provider of suggesters()) {
        for (const item of provider(query)) {
          if (seen.has(item.display)) continue
          seen.add(item.display)
          found.push(item)
        }
      }
      return found
    },
    routeOf(text) {
      for (const resolver of [...resolvers()].reverse()) {
        const answer = resolver(text)
        if (answer !== undefined) return answer
      }
      return undefined
    },
  }
}

export const { use: useComposer, provider: ComposerProvider } = createSimpleContext({
  name: "Composer",
  init: createComposerState,
})
