import { Config } from "effect"
import type { Auth } from "../src/route/auth"
import type { ModelFactory } from "../src/route/auth-options"
import { Auth as RuntimeAuth } from "../src/route/auth"

const azureCredential = ["azure", "key"].join("-")
const anthropicCredential = ["anthropic", "key"].join("-")
import * as OpenAIChat from "../src/protocols/openai-chat"
import * as AmazonBedrock from "../src/providers/amazon-bedrock"
import * as Anthropic from "../src/providers/anthropic"
import * as Azure from "../src/providers/azure"
import * as Cloudflare from "../src/providers/cloudflare"
import * as GitHubCopilot from "../src/providers/github-copilot"
import * as Google from "../src/providers/google"
import * as OpenAI from "../src/providers/openai"
import * as OpenAICompatible from "../src/providers/openai-compatible"
import * as OpenRouter from "../src/providers/openrouter"
import * as XAI from "../src/providers/xai"

type BaseOptions = {
  readonly baseURL?: string
  readonly headers?: Record<string, string>
}

type Model = {
  readonly id: string
}

declare const auth: Auth
declare const optionalAuthModel: ModelFactory<BaseOptions, "optional", Model>
declare const requiredAuthModel: ModelFactory<BaseOptions, "required", Model>
const configApiKey = Config.redacted("OPENAI_API_KEY")
const testApiKey = ["sk", "test"].join("-")
const googleCredential = ["google", "key"].join("-")
const bedrockCredential = ["bedrock", "key"].join("-")
const openRouterCredential = ["openrouter", "key"].join("-")
const xaiCredential = ["xai", "key"].join("-")
const cloudflareCredential = ["cf", "key"].join("-")
const copilotCredential = ["copilot", "key"].join("-")

OpenAIChat.route.model({ id: "gpt-4.1-mini" })

// @ts-expect-error route model selection does not configure endpoints.
OpenAIChat.route.model({ id: "gpt-4.1-mini", baseURL: "https://gateway.example.com/v1" })

// @ts-expect-error route model selection does not configure query params.
OpenAIChat.route.model({ id: "gpt-4.1-mini", queryParams: { debug: "1" } })

// @ts-expect-error route model selection does not configure auth.
OpenAIChat.route.model({ id: "gpt-4.1-mini", auth })

// @ts-expect-error route model selection does not configure api keys.
OpenAIChat.route.model({ id: "gpt-4.1-mini", apiKey: testApiKey })

optionalAuthModel("gpt-4.1-mini")
optionalAuthModel("gpt-4.1-mini", {})
optionalAuthModel("gpt-4.1-mini", { apiKey: testApiKey })
optionalAuthModel("gpt-4.1-mini", { apiKey: configApiKey })
optionalAuthModel("gpt-4.1-mini", { auth })
optionalAuthModel("gpt-4.1-mini", { auth, baseURL: "https://gateway.example.com/v1" })
optionalAuthModel("gpt-4.1-mini", { apiKey: testApiKey, headers: { "x-source": "test" } })

// @ts-expect-error auth is an override, so apiKey cannot be supplied with it.
optionalAuthModel("gpt-4.1-mini", { apiKey: testApiKey, auth })

requiredAuthModel("custom-model", { apiKey: testApiKey })
requiredAuthModel("custom-model", { apiKey: configApiKey })
requiredAuthModel("custom-model", { auth })
requiredAuthModel("custom-model", { auth, headers: { "x-tenant-id": "tenant" } })

// @ts-expect-error providers without config fallback need apiKey or auth.
requiredAuthModel("custom-model")

// @ts-expect-error providers without config fallback need apiKey or auth.
requiredAuthModel("custom-model", {})

// @ts-expect-error auth is an override, so apiKey cannot be supplied with it.
requiredAuthModel("custom-model", { apiKey: testApiKey, auth })

OpenAI.responses("gpt-4.1-mini")
OpenAI.configure({}).responses("gpt-4.1-mini")
OpenAI.configure({ apiKey: testApiKey }).responses("gpt-4.1-mini")
OpenAI.configure({ apiKey: configApiKey }).responses("gpt-4.1-mini")
OpenAI.configure({ auth: RuntimeAuth.bearer("oauth-token") }).responses("gpt-4.1-mini")
OpenAI.configure({
  auth: RuntimeAuth.headers({ authorization: "Bearer gateway" }),
  baseURL: "https://gateway.example.com/v1",
}).responses("gpt-4.1-mini")
OpenAI.configure({
  generation: { maxTokens: 100 },
  providerOptions: { openai: { store: false } },
}).responses("gpt-4.1-mini")

// @ts-expect-error OpenAI model selectors only accept model ids.
OpenAI.configure({ apiKey: testApiKey }).responses("gpt-4.1-mini", {})

// @ts-expect-error apiKey only accepts string, Redacted<string>, or Config<string | Redacted<string>>.
OpenAI.configure({ apiKey: 123 })

// @ts-expect-error provider helpers reject unknown top-level options.
OpenAI.configure({ bogus: true })

// @ts-expect-error common generation options remain typed.
OpenAI.configure({ generation: { maxTokens: "many" } })

// @ts-expect-error provider-native options remain typed.
OpenAI.configure({ providerOptions: { openai: { store: "false" } } })

// @ts-expect-error auth is an override, so OpenAI rejects apiKey with auth.
OpenAI.configure({ apiKey: testApiKey, auth: RuntimeAuth.bearer("oauth-token") })

OpenAI.chat("gpt-4.1-mini")
OpenAI.configure({ apiKey: testApiKey }).chat("gpt-4.1-mini")
OpenAI.configure({ apiKey: configApiKey }).chat("gpt-4.1-mini")
OpenAI.configure({ auth: RuntimeAuth.bearer("oauth-token") }).chat("gpt-4.1-mini")

// @ts-expect-error OpenAI chat selectors only accept model ids.
OpenAI.configure({ apiKey: "sk-test" }).chat("gpt-4.1-mini", {})

// @ts-expect-error auth is an override, so OpenAI Chat rejects apiKey with auth.
OpenAI.configure({ apiKey: testApiKey, auth: RuntimeAuth.bearer("oauth-token") })

// @ts-expect-error Azure requires at least one of `resourceName` or `baseURL`.
Azure.configure()
Azure.configure({ apiKey: ["azure", "key"].join("-"), resourceName: "resource" }).responses("deployment")
Azure.configure({ apiKey: configApiKey, resourceName: "resource" }).responses("deployment")
Azure.configure({ auth: RuntimeAuth.header("api-key", azureCredential), resourceName: "resource" }).responses("deployment")

// @ts-expect-error Azure model selectors only accept deployment ids.
Azure.configure({ apiKey: azureCredential, resourceName: "resource" }).responses("deployment", {})

// @ts-expect-error auth is an override, so Azure rejects apiKey with auth.
Azure.configure({ resourceName: "resource", apiKey: azureCredential, auth: RuntimeAuth.header("api-key", "override") })

Azure.configure({ apiKey: azureCredential, resourceName: "resource" }).chat("deployment")
Azure.configure({ apiKey: configApiKey, resourceName: "resource" }).chat("deployment")
Azure.configure({ auth: RuntimeAuth.header("api-key", azureCredential), resourceName: "resource" }).chat("deployment")

// @ts-expect-error Azure chat model selectors only accept deployment ids.
Azure.configure({ apiKey: azureCredential, resourceName: "resource" }).chat("deployment", {})

// @ts-expect-error auth is an override, so Azure Chat rejects apiKey with auth.
Azure.configure({ resourceName: "resource", apiKey: azureCredential, auth: RuntimeAuth.header("api-key", "override") })

Anthropic.configure({ apiKey: anthropicCredential }).model("claude-haiku")
// @ts-expect-error Anthropic model selectors only accept model ids.
Anthropic.configure({ apiKey: anthropicCredential }).model("claude-haiku", {})

Google.configure({ apiKey: googleCredential }).model("gemini-2.5-flash")
// @ts-expect-error Google model selectors only accept model ids.
Google.configure({ apiKey: googleCredential }).model("gemini-2.5-flash", {})

AmazonBedrock.configure({ apiKey: bedrockCredential }).model("anthropic.claude")
// @ts-expect-error Bedrock model selectors only accept model ids.
AmazonBedrock.configure({ apiKey: bedrockCredential }).model("anthropic.claude", {})

OpenRouter.configure({ apiKey: openRouterCredential }).model("openai/gpt-4o-mini")
// @ts-expect-error OpenRouter model selectors only accept model ids.
OpenRouter.configure({ apiKey: openRouterCredential }).model("openai/gpt-4o-mini", {})

XAI.configure({ apiKey: xaiCredential }).responses("grok-4")
XAI.configure({ apiKey: xaiCredential }).chat("grok-4")
// @ts-expect-error xAI Responses selectors only accept model ids.
XAI.configure({ apiKey: xaiCredential }).responses("grok-4", {})
// @ts-expect-error xAI Chat selectors only accept model ids.
XAI.configure({ apiKey: xaiCredential }).chat("grok-4", {})

OpenAICompatible.deepseek.configure({ apiKey: ["deepseek", "key"].join("-") }).model("deepseek-chat")
// @ts-expect-error OpenAI-compatible family selectors only accept model ids.
OpenAICompatible.deepseek.configure({ apiKey: ["deepseek", "key"].join("-") }).model("deepseek-chat", {})

Cloudflare.CloudflareWorkersAI.configure({ accountId: "account", apiKey: cloudflareCredential }).model("@cf/meta/llama")
// @ts-expect-error Cloudflare Workers AI model selectors only accept model ids.
Cloudflare.CloudflareWorkersAI.configure({ accountId: "account", apiKey: cloudflareCredential }).model("@cf/meta/llama", {})

GitHubCopilot.configure({ baseURL: "https://copilot.test", apiKey: copilotCredential }).model("gpt-4.1")
// @ts-expect-error GitHub Copilot model selectors only accept model ids.
GitHubCopilot.configure({ baseURL: "https://copilot.test", apiKey: copilotCredential }).model("gpt-4.1", {})
