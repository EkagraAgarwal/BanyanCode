import { Argument, Flag, GlobalFlag } from "effect/cli"
import { Schema } from "effect"
import { Product } from "@opencode/util/product"
import { displayName } from "../brand"
import { Spec } from "../framework/spec"
import { Updater } from "../services/updater"

export const PrintLogs = GlobalFlag.Setting("print-logs")({
  flag: Flag.Boolean("print-logs").pipe(
    Flag.withDescription("Print logs to stderr (server logs require --standalone)"),
    Flag.withDefault(false),
  ),
})

export const Standalone = GlobalFlag.Setting("standalone")({
  flag: Flag.Boolean("standalone").pipe(
    Flag.withDescription("Run with a private server instead of the background service"),
    Flag.withDefault(false),
  ),
})

export const Server = GlobalFlag.Setting("server")({
  flag: Flag.String("server").pipe(
    Flag.withDescription("Connect to a server URL instead of the background service"),
    Flag.optional,
  ),
})

const ServerFlags = [Standalone, Server] as const

declare const OPENCODE_CLI_NAME: string | undefined

const ServerParams = {
  standalone: Standalone.flag,
  server: Server.flag,
}

const PermissionParams = {
  auto: Flag.Boolean("auto").pipe(
    Flag.withDescription("Auto-approve permissions that are not explicitly denied"),
    Flag.withDefault(false),
  ),
  yolo: Flag.Boolean("yolo").pipe(Flag.withDefault(false), Flag.withHidden),
  dangerouslySkipPermissions: Flag.Boolean("dangerously-skip-permissions").pipe(
    Flag.withDefault(false),
    Flag.withHidden,
  ),
}

const Root = Spec.make(typeof OPENCODE_CLI_NAME === "string" ? OPENCODE_CLI_NAME : Product.cliName, {
  description: `${displayName} command line interface`,
  params: {
    ...ServerParams,
    ...PermissionParams,
    directory: Argument.String("directory").pipe(
      Argument.withDescription(`Directory to start ${displayName} in`),
      Argument.optional,
    ),
    continue: Flag.Boolean("continue").pipe(
      Flag.withAlias("c"),
      Flag.withDescription("Continue the last session"),
      Flag.withDefault(false),
    ),
    session: Flag.String("session").pipe(
      Flag.withAlias("s"),
      Flag.withDescription("Session ID to continue, or to create if it does not exist"),
      Flag.optional,
    ),
    prompt: Flag.String("prompt").pipe(Flag.withDescription("Prompt to use"), Flag.optional),
  },
  commands: [
    Spec.make("upgrade", {
      description: `Upgrade ${displayName} to the latest or a specific version`,
      aliases: ["update"],
      params: {
        target: Argument.String("target").pipe(
          Argument.withDescription("Version to upgrade to (with or without a leading v)"),
          Argument.optional,
        ),
        method: Flag.Literals("method", Updater.methods).pipe(
          Flag.withAlias("m"),
          Flag.withDescription("Installation method to use"),
          Flag.optional,
        ),
      },
    }),
    Spec.make("uninstall", {
      description: `Uninstall ${displayName}, keeping session data, configuration, and state`,
      params: {
        dryRun: Flag.Boolean("dry-run").pipe(
          Flag.withDescription("Show what would be removed without removing"),
          Flag.withDefault(false),
        ),
        force: Flag.Boolean("force").pipe(
          Flag.withAlias("f"),
          Flag.withDescription("Skip confirmation prompts"),
          Flag.withDefault(false),
        ),
      },
    }),
    Spec.make("acp", {
      description: "Start an Agent Client Protocol server",
      params: {
        login: Flag.Boolean("login").pipe(
          Flag.withDescription("Run auth login instead of starting the server"),
          Flag.withDefault(false),
        ),
      },
    }),
    Spec.make("api", {
      description: "Make a request to the running server",
      globalFlags: ServerFlags,
      params: {
        request: Argument.String("operation | method path").pipe(
          Argument.withDescription("OpenAPI operation ID, or an HTTP method followed by a path"),
          Argument.variadic({ min: 1, max: 2 }),
        ),
        data: Flag.String("data").pipe(Flag.withAlias("d"), Flag.withDescription("Request body"), Flag.optional),
        header: Flag.String("header").pipe(
          Flag.withAlias("H"),
          Flag.withDescription("Request header in name:value form"),
          Flag.atMost(100),
        ),
        param: Flag.KeyValuePair("param").pipe(Flag.withDescription("OpenAPI path or query parameter"), Flag.optional),
      },
    }),
    Spec.make("debug", {
      description: "Debugging and troubleshooting tools",
      commands: [
        Spec.make("agents", { description: "List all agents", globalFlags: ServerFlags }),
        Spec.make("config", { description: "List configuration sources", globalFlags: ServerFlags }),
        Spec.make("heap-dump", {
          description: "Write a heap snapshot of the running server and print its path",
          globalFlags: [Server],
          params: {
            directory: Flag.String("directory").pipe(
              Flag.withDescription("Directory to write the snapshot into instead of the server's log directory"),
              Flag.optional,
            ),
          },
        }),
        Spec.make("paths", {
          description: "Show global paths (data, config, cache, state)",
          params: {
            name: Argument.Literals("name", [
              "db",
              "home",
              "data",
              "config",
              "cache",
              "state",
              "tmp",
              "bin",
              "log",
              "repos",
            ]).pipe(
              Argument.withDescription(
                "Print only one path: db, home, data, config, cache, state, tmp, bin, log, repos",
              ),
              Argument.optional,
            ),
          },
        }),
      ],
    }),
    Spec.make("auth", {
      description: "manage integrations and credentials",
      globalFlags: ServerFlags,
      commands: [
        Spec.make("list", {
          description: "list integrations and credentials",
          params: {
            format: Flag.Literals("format", ["default", "json"]).pipe(
              Flag.withDescription("Output format"),
              Flag.withDefault("default"),
            ),
          },
        }),
        Spec.make("login", {
          description: "connect an integration",
          params: {
            target: Argument.String("target").pipe(
              Argument.withDescription("Integration ID, name, or well-known provider URL"),
              Argument.optional,
            ),
            method: Flag.String("method").pipe(Flag.withDescription("Authentication method ID"), Flag.optional),
            answer: Flag.String("answer").pipe(
              Flag.withDescription("Provider form answer (key=value; repeat for multiple fields)"),
              Flag.atMost(100),
            ),
          },
        }),
        Spec.make("logout", {
          description: "log out of a saved account",
          params: {
            target: Argument.String("target").pipe(
              Argument.withDescription("Integration ID or name"),
              Argument.optional,
            ),
            credential: Argument.String("credential").pipe(
              Argument.withDescription("Credential ID or label (opens an account picker when omitted)"),
              Argument.optional,
            ),
          },
        }),
        Spec.make("export", {
          description: "print stored credentials, including secrets, as JSON",
          params: {
            target: Argument.String("target").pipe(
              Argument.withDescription("Integration ID or name (exports every integration when omitted)"),
              Argument.optional,
            ),
          },
        }),
        Spec.make("import", {
          description: "import credentials exported by auth export",
          params: {
            file: Argument.String("file").pipe(
              Argument.withDescription("JSON file to import (reads stdin when omitted)"),
              Argument.optional,
            ),
          },
        }),
        Spec.make("switch", {
          description: "switch the active account for an integration",
          params: {
            target: Argument.String("target").pipe(
              Argument.withDescription("Integration ID or name"),
              Argument.optional,
            ),
            credential: Argument.String("credential").pipe(
              Argument.withDescription("Credential ID or label (opens an account picker when omitted)"),
              Argument.optional,
            ),
          },
        }),
      ],
    }),
    Spec.make("mcp", {
      description: "Manage MCP (Model Context Protocol) servers, or serve BanyanCode over MCP",
      commands: [
        Spec.make("serve", {
          description: "Serve BanyanCode over MCP (stdio by default; --http for stateless Streamable HTTP)",
          params: {
            cwd: Flag.String("cwd").pipe(
              Flag.withDescription("Project directory to operate on (default: $CLAUDE_PROJECT_DIR or the cwd)"),
              Flag.optional,
            ),
            config: Flag.String("config").pipe(
              Flag.withDescription("banyancode.json path (default: discovery from --cwd)"),
              Flag.optional,
            ),
            attach: Flag.String("attach").pipe(
              Flag.withDescription("Reuse a running server instead of starting one (e.g. http://127.0.0.1:4096)"),
              Flag.optional,
            ),
            password: Flag.String("password").pipe(
              Flag.withDescription("Password for --attach (default: $BANYANCODE_SERVER_PASSWORD)"),
              Flag.optional,
            ),
            allowYolo: Flag.Boolean("allow-yolo").pipe(
              Flag.withDescription("Permit the yolo permission policy for delegated tasks"),
              Flag.withDefault(false),
            ),
            permission: Flag.Literals("permission", ["reject", "edits", "yolo"]).pipe(
              Flag.withDescription("Server permission policy for delegated tasks"),
              Flag.optional,
            ),
            maxTasks: Flag.Int("max-tasks").pipe(
              Flag.withDescription("Max concurrent delegated tasks (1-32)"),
              Flag.optional,
            ),
            tools: Flag.String("tools").pipe(
              Flag.withDescription('Comma-separated tool groups (default: all; "task", "code")'),
              Flag.optional,
            ),
            http: Flag.Boolean("http").pipe(
              Flag.withDescription("Serve over stateless Streamable HTTP instead of stdio"),
              Flag.withDefault(false),
            ),
            port: Flag.Int("port").pipe(Flag.withDescription("HTTP port (default: ephemeral)"), Flag.optional),
            hostname: Flag.String("hostname").pipe(
              Flag.withDescription("HTTP bind address (default 127.0.0.1; non-loopback needs --token)"),
              Flag.optional,
            ),
            token: Flag.String("token").pipe(
              Flag.withDescription("HTTP bearer token (default: $BANYANCODE_MCP_TOKEN, else generated)"),
              Flag.optional,
            ),
            noStart: Flag.Boolean("no-start").pipe(
              Flag.withDescription("Never spawn the background service"),
              Flag.withDefault(false),
            ),
            noRehydrate: Flag.Boolean("no-rehydrate").pipe(
              Flag.withDescription("Skip rebuilding task handles from sessions at startup"),
              Flag.withDefault(false),
            ),
          },
        }),
        Spec.make("doctor", {
          description: "Check the MCP configuration, background service and delegated task state",
          params: {
            cwd: Flag.String("cwd").pipe(Flag.withDescription("Project directory to inspect"), Flag.optional),
            config: Flag.String("config").pipe(
              Flag.withDescription("banyancode.json path (default: discovery from --cwd)"),
              Flag.optional,
            ),
          },
        }),
        Spec.make("profiles", {
          description: "List the autonomy profiles available to delegated tasks",
          params: {
            cwd: Flag.String("cwd").pipe(Flag.withDescription("Project directory to inspect"), Flag.optional),
            config: Flag.String("config").pipe(Flag.withDescription("banyancode.json path"), Flag.optional),
            permission: Flag.Literals("permission", ["reject", "edits", "yolo"]).pipe(
              Flag.withDescription("Server permission policy override"),
              Flag.optional,
            ),
          },
        }),
        Spec.make("install", {
          description: "Write the MCP client config (claude-code, codex, or cursor) after showing the change",
          params: {
            client: Argument.String("client").pipe(
              Argument.withDescription("Client to configure: claude-code, codex, or cursor"),
            ),
            cwd: Flag.String("cwd").pipe(Flag.withDescription("Project directory to configure"), Flag.optional),
            yes: Flag.Boolean("yes").pipe(
              Flag.withDescription("Write without asking for confirmation (the change is still printed)"),
              Flag.withDefault(false),
            ),
            permission: Flag.String("permission").pipe(
              Flag.withDescription("Write this permission policy into the client config: edits"),
              Flag.optional,
            ),
          },
        }),
        Spec.make("list", {
          description: "List configured MCP servers and their status",
          globalFlags: ServerFlags,
        }),
        Spec.make("add", {
          description: "Add an MCP server to your configuration",
          params: {
            name: Argument.String("name").pipe(Argument.withDescription("Name of the MCP server")),
            command: Argument.String("command").pipe(
              Argument.withDescription("Command and arguments for a local server, passed after --"),
              Argument.variadic({ min: 0 }),
            ),
            url: Flag.String("url").pipe(Flag.withDescription("URL for a remote MCP server"), Flag.optional),
            header: Flag.KeyValuePair("header").pipe(
              Flag.withDescription("HTTP header for a remote server, as name=value"),
              Flag.optional,
            ),
            env: Flag.KeyValuePair("env").pipe(
              Flag.withDescription("Environment variable for a local server, as name=value"),
              Flag.optional,
            ),
            global: Flag.Boolean("global").pipe(
              Flag.withDescription("Write to the global config instead of the project config"),
              Flag.withDefault(false),
            ),
          },
        }),
        Spec.make("auth", {
          description: "Authenticate with an OAuth-capable remote MCP server",
          globalFlags: ServerFlags,
          params: {
            name: Argument.String("name").pipe(Argument.withDescription("Name of the MCP server"), Argument.optional),
          },
        }),
        Spec.make("logout", {
          description: "Remove stored OAuth credentials for an MCP server",
          globalFlags: ServerFlags,
          params: { name: Argument.String("name").pipe(Argument.withDescription("Name of the MCP server")) },
        }),
      ],
    }),
    Spec.make("plugin", {
      description: "Manage plugins",
      commands: [
        Spec.make("list", {
          description: "List plugins",
          globalFlags: ServerFlags,
          params: {
            builtin: Flag.Boolean("builtin").pipe(
              Flag.withDescription("Include built-in server plugins"),
              Flag.withDefault(false),
            ),
          },
        }),
        Spec.make("add", {
          description: "Install a plugin and add it to the global configuration",
          params: {
            package: Argument.String("package").pipe(Argument.withDescription("npm registry or Git package specifier")),
          },
        }),
        Spec.make("check", {
          description: "Check package plugins for updates",
          globalFlags: ServerFlags,
          params: {
            target: Argument.String("target").pipe(
              Argument.withDescription("Configured package target"),
              Argument.optional,
            ),
          },
        }),
        Spec.make("update", {
          description: "Update package plugins",
          globalFlags: ServerFlags,
          params: {
            target: Argument.String("target").pipe(
              Argument.withDescription("Configured package target; omit to update all outdated plugins"),
              Argument.optional,
            ),
          },
        }),
        Spec.make("remove", {
          description: "Remove a plugin from global configuration",
          params: {
            package: Argument.String("package").pipe(Argument.withDescription("configured package specifier")),
          },
        }),
      ],
    }),
    Spec.make("models", {
      description: "List all available models",
      globalFlags: ServerFlags,
    }),
    Spec.make("stats", {
      description: "Show shareable usage statistics",
      globalFlags: ServerFlags,
      params: {
        days: Flag.Int("days").pipe(
          Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
          Flag.withDescription("Show the last N days; 0 means today"),
          Flag.optional,
        ),
        year: Flag.Int("year").pipe(
          Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1970, maximum: 9_999 }))),
          Flag.withDescription("Show a calendar year"),
          Flag.optional,
        ),
        all: Flag.Boolean("all").pipe(Flag.withDescription("Show lifetime statistics"), Flag.withDefault(false)),
        project: Flag.String("project").pipe(
          Flag.withDescription('Filter by project ID, or use "." for the current project'),
          Flag.optional,
        ),
        models: Flag.Boolean("models").pipe(Flag.withDescription("Show model usage"), Flag.withDefault(false)),
        tools: Flag.Boolean("tools").pipe(Flag.withDescription("Show tool reliability"), Flag.withDefault(false)),
        cost: Flag.Boolean("cost").pipe(Flag.withDescription("Show cost and token details"), Flag.withDefault(false)),
        full: Flag.Boolean("full").pipe(Flag.withDescription("Show every detailed section"), Flag.withDefault(false)),
        limit: Flag.Int("limit").pipe(
          Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
          Flag.withDescription("Number of rows in detailed sections"),
          Flag.withDefault(5),
        ),
        json: Flag.Boolean("json").pipe(Flag.withDescription("Output statistics as JSON"), Flag.withDefault(false)),
        heatmap: Flag.Boolean("heatmap").pipe(
          Flag.withDescription(
            "Render per-day activity as an ASCII heatmap (last 365 days, or the --days window)",
          ),
          Flag.withDefault(false),
        ),
      },
    }),
    Spec.make("mini", {
      description: "Start the minimal interactive interface",
      globalFlags: ServerFlags,
      params: {
        continue: Flag.Boolean("continue").pipe(
          Flag.withAlias("c"),
          Flag.withDescription("Continue the last session"),
          Flag.withDefault(false),
        ),
        session: Flag.String("session").pipe(
          Flag.withAlias("s"),
          Flag.withDescription("Session ID to continue, or to create if it does not exist"),
          Flag.optional,
        ),
        fork: Flag.Boolean("fork").pipe(
          Flag.withDescription("Fork the session when continuing"),
          Flag.withDefault(false),
        ),
        replay: Flag.Boolean("replay").pipe(
          Flag.withDescription("Restore session history on resume and resize (disable with --no-replay)"),
          Flag.optional,
        ),
        replayLimit: Flag.Int("replay-limit").pipe(
          Flag.withDescription("Limit replay to the newest N messages (default: 200)"),
          Flag.optional,
        ),
        model: Flag.String("model").pipe(
          Flag.withAlias("m"),
          Flag.withDescription("Model to use in the format provider/model"),
          Flag.optional,
        ),
        agent: Flag.String("agent").pipe(Flag.withDescription("Agent to use"), Flag.optional),
        prompt: Flag.String("prompt").pipe(Flag.withDescription("Prompt to use"), Flag.optional),
        demo: Flag.Boolean("demo").pipe(Flag.withDefault(false), Flag.withHidden),
      },
    }),
    Spec.make("run", {
      description: `Run ${displayName} with a message`,
      globalFlags: ServerFlags,
      params: {
        message: Argument.String("message").pipe(
          Argument.withDescription("Message to send"),
          Argument.variadic({ min: 0 }),
        ),
        continue: Flag.Boolean("continue").pipe(
          Flag.withAlias("c"),
          Flag.withDescription("Continue the last session"),
          Flag.withDefault(false),
        ),
        session: Flag.String("session").pipe(
          Flag.withAlias("s"),
          Flag.withDescription("Session ID to continue, or to create if it does not exist"),
          Flag.optional,
        ),
        fork: Flag.Boolean("fork").pipe(
          Flag.withDescription("Fork the session before continuing"),
          Flag.withDefault(false),
        ),
        model: Flag.String("model").pipe(
          Flag.withAlias("m"),
          Flag.withDescription("Model to use in the format provider/model#variant"),
          Flag.optional,
        ),
        agent: Flag.String("agent").pipe(Flag.withDescription("Agent to use"), Flag.optional),
        format: Flag.Literals("format", ["default", "json"]).pipe(
          Flag.withDescription("Output format"),
          Flag.withDefault("default"),
        ),
        file: Flag.String("file").pipe(
          Flag.withAlias("f"),
          Flag.withDescription("File to attach to the message"),
          Flag.atMost(100),
        ),
        title: Flag.String("title").pipe(Flag.withDescription("Session title"), Flag.optional),
        thinking: Flag.Boolean("thinking").pipe(Flag.withDescription("Show thinking blocks"), Flag.withDefault(false)),
        ...PermissionParams,
      },
    }),
    Spec.make("session", {
      description: "Manage sessions",
      globalFlags: ServerFlags,
      commands: [
        Spec.make("list", {
          description: "List top-level sessions in the current project, newest first",
          params: {
            maxCount: Flag.Int("max-count").pipe(
              Flag.withAlias("n"),
              Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
              Flag.withDescription("Limit to N most recent sessions (default: 100)"),
              Flag.optional,
            ),
            format: Flag.Literals("format", ["table", "json"]).pipe(
              Flag.withDescription("Output format"),
              Flag.withDefault("table"),
            ),
          },
        }),
        Spec.make("delete", {
          description: "Delete a session and its child sessions",
          params: {
            sessionID: Argument.String("sessionID").pipe(Argument.withDescription("Session ID to delete")),
          },
        }),
        Spec.make("export", {
          description: "Export session data as JSON",
          params: {
            session: Argument.String("session").pipe(
              Argument.withDescription("Session ID to export"),
              Argument.optional,
            ),
            sanitize: Flag.Boolean("sanitize").pipe(
              Flag.withDescription("Redact sensitive transcript and file data"),
              Flag.withDefault(false),
            ),
          },
        }),
        Spec.make("import", {
          description: "Import session data from a JSON file or URL",
          params: {
            file: Argument.String("file").pipe(Argument.withDescription("JSON file or URL to import")),
            directory: Flag.String("directory").pipe(
              Flag.withDescription("Directory in which to import the session"),
              Flag.optional,
            ),
          },
        }),
      ],
    }),
    Spec.make("service", {
      description: "Manage the background server",
      commands: [
        Spec.make("start", { description: "Start the background server" }),
        Spec.make("restart", { description: "Restart the background server" }),
        Spec.make("status", { description: "Show background server status" }),
        Spec.make("stop", { description: "Stop the background server" }),
        Spec.make("get", {
          description: "Get service configuration",
          params: {
            key: Argument.String("key").pipe(Argument.withDescription("Service setting or env"), Argument.optional),
            name: Argument.String("name").pipe(
              Argument.withDescription("Environment variable name"),
              Argument.optional,
            ),
          },
        }),
        Spec.make("set", {
          description: "Set service configuration",
          params: {
            key: Argument.String("key").pipe(Argument.withDescription("Service setting or env")),
            value: Argument.String("value").pipe(
              Argument.withDescription("Setting value or environment variable name"),
            ),
            nestedValue: Argument.String("env-value").pipe(
              Argument.withDescription("Environment variable value"),
              Argument.optional,
            ),
          },
        }),
        Spec.make("unset", {
          description: "Unset service configuration",
          params: {
            key: Argument.String("key").pipe(Argument.withDescription("Service setting or env")),
            name: Argument.String("name").pipe(
              Argument.withDescription("Environment variable name"),
              Argument.optional,
            ),
          },
        }),
      ],
    }),
    Spec.make("reload", {
      description: "Reload configuration",
      globalFlags: ServerFlags,
    }),
    Spec.make("pair", {
      description: "Print one-time links to connect a browser or app",
      params: {
        url: Flag.String("url").pipe(
          Flag.withDescription("Use an external HTTP(S) server URL in pairing links"),
          Flag.mapTryCatch(
            (value) => {
              const url = new URL(value)
              if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
                throw new Error("Invalid pairing URL")
              return url.href.replace(/\/+$/, "")
            },
            () => "Expected an HTTP(S) server URL without credentials, query parameters, or a fragment",
          ),
          Flag.optional,
        ),
        remote: Flag.Boolean("remote").pipe(
          Flag.withDescription(
            "Pair through the OpenTunnel remote address, enabling remote access if needed (exposes the server to the internet)",
          ),
          Flag.withDefault(false),
        ),
        yes: Flag.Boolean("yes").pipe(
          Flag.withAlias("y"),
          Flag.withDescription(
            "Accept exposing the server to the internet when --remote enables remote access for the first time (required without an interactive terminal)",
          ),
          Flag.withDefault(false),
        ),
      },
    }),
    Spec.make("serve", {
      description: "Start the v2 API and web server",
      params: {
        hostname: Flag.String("hostname").pipe(Flag.optional),
        port: Flag.Int("port").pipe(Flag.optional),
        cors: Flag.String("cors").pipe(
          Flag.withSchema(Schema.NonEmptyString),
          Flag.withDescription("Additional allowed CORS origin (repeat for multiple origins)"),
          Flag.atLeast(0),
        ),
        service: Flag.Boolean("service").pipe(Flag.withDefault(false)),
        stdio: Flag.Boolean("stdio").pipe(Flag.withDefault(false)),
      },
    }),
    // BanyanCode subcommands (v1 parity section 8a). Every command reaches the
    // plugin over its RPC namespaces; the handlers live in
    // `handlers/banyancode/**`.
    Spec.make("codegraph", {
      description: "Build and inspect the BanyanCode codegraph",
      globalFlags: ServerFlags,
      commands: [
        Spec.make("build", {
          description: "Build the codegraph for the current workspace",
          params: {
            root: Flag.String("root").pipe(
              Flag.withDescription("Directory to index (defaults to the current working directory)"),
              Flag.optional,
            ),
            force: Flag.Boolean("force").pipe(
              Flag.withDescription("Rebuild even if the codegraph is already up to date"),
              Flag.withDefault(false),
            ),
            watch: Flag.Boolean("watch").pipe(
              Flag.withDescription("Stream progress events until the build finishes (default: true in a TTY)"),
              Flag.withDefault(false),
            ),
            timeout: Flag.Int("timeout").pipe(
              Flag.withDescription("Fail after N seconds; 0 = no timeout"),
              Flag.withDefault(0),
            ),
          },
        }),
        Spec.make("status", {
          description: "Print the current codegraph build status",
          params: {
            root: Flag.String("root").pipe(
              Flag.withDescription("Directory whose graph should be inspected (defaults to the current directory)"),
              Flag.optional,
            ),
          },
        }),
        Spec.make("cancel", { description: "Cancel an in-flight codegraph build" }),
        Spec.make("remove", {
          description:
            "Remove the codegraph index (preserves banyancode.db by default; pass --drop-file to also delete the file)",
          params: {
            dropFile: Flag.Boolean("drop-file").pipe(
              Flag.withDescription("Also delete the database file (DANGEROUS: shared with sessions)"),
              Flag.withDefault(false),
            ),
          },
        }),
        Spec.make("force-kill", { description: "Force-kill a stuck codegraph build" }),
        Spec.make("path", { description: "Print the BanyanCode database path" }),
        Spec.make("trace", {
          description: "Print recent tool-call traces for a session",
          params: {
            session: Flag.String("session").pipe(
              Flag.withDescription("Session id whose trace file should be read"),
            ),
            limit: Flag.Int("limit").pipe(
              Flag.withDescription("Number of most-recent events to print (default: 50)"),
              Flag.withDefault(50),
            ),
            worktree: Flag.String("worktree").pipe(
              Flag.withDescription("Project worktree to locate the trace file (defaults to the current directory)"),
              Flag.optional,
            ),
          },
        }),
      ],
    }),
    Spec.make("goal", {
      description: "Manage /goal loop goals (set/status/list/cancel)",
      globalFlags: ServerFlags,
      commands: [
        Spec.make("set", {
          description: "Create a new active goal for the current session",
          params: {
            condition: Argument.String("condition").pipe(
              Argument.withDescription("Goal condition (free-text)"),
            ),
            plan: Flag.String("plan").pipe(
              Flag.withDescription("Path to plan.md (v2 native goal mode stores no plan)"),
              Flag.optional,
            ),
            priority: Flag.Literals("priority", ["low", "normal", "high"]).pipe(
              Flag.withDescription("Goal priority (v2 native goal mode stores no priority)"),
              Flag.withDefault("normal"),
            ),
            session: Flag.String("session").pipe(Flag.withDescription("Session id")),
          },
        }),
        Spec.make("status", {
          description: "Print the active goal for a session",
          params: { session: Flag.String("session").pipe(Flag.withDescription("Session id")) },
        }),
        Spec.make("list", {
          description: "List all goals (active + terminal) for a session",
          params: { session: Flag.String("session").pipe(Flag.withDescription("Session id")) },
        }),
        Spec.make("cancel", {
          description: "Cancel the active goal for a session",
          params: { session: Flag.String("session").pipe(Flag.withDescription("Session id")) },
        }),
      ],
    }),
    Spec.make("repository", {
      description: "BanyanCode repository intelligence subcommands",
      globalFlags: ServerFlags,
      commands: [
        Spec.make("query", {
          description: "Run a unified repository query (symbols, tests, docs, configs)",
          params: {
            query: Argument.String("query").pipe(
              Argument.withDescription("Function name, file path, or feature phrase"),
            ),
            limit: Flag.Int("limit").pipe(
              Flag.withDescription("Max recent commits to include"),
              Flag.withDefault(10),
            ),
          },
        }),
        Spec.make("explain", {
          description: "Explain a symbol by name",
          params: { symbol: Argument.String("symbol").pipe(Argument.withDescription("Symbol name")) },
        }),
        Spec.make("trace", {
          description: "Trace a symbol to its downstream dependents",
          params: {
            symbol: Argument.String("symbol").pipe(Argument.withDescription("Symbol name")),
            depth: Flag.Int("depth").pipe(Flag.withDescription("Graph walk depth"), Flag.withDefault(2)),
          },
        }),
        Spec.make("impact", {
          description: "Analyze the impact of changing a file by path",
          params: {
            path: Argument.String("path").pipe(
              Argument.withDescription("Repository-relative file path"),
            ),
          },
        }),
        Spec.make("tests", {
          description: "Find tests that reference a symbol",
          params: { symbol: Argument.String("symbol").pipe(Argument.withDescription("Symbol name")) },
        }),
        Spec.make("relationships", {
          description: "Walk the graph from a nodeID",
          params: {
            nodeID: Argument.String("nodeID").pipe(Argument.withDescription("Codegraph node id")),
            depth: Flag.Int("depth").pipe(Flag.withDescription("Graph walk depth"), Flag.withDefault(2)),
          },
        }),
        Spec.make("ownership", {
          description: "Find the most active author for a file by path",
          params: {
            path: Argument.String("path").pipe(
              Argument.withDescription("Repository-relative file path"),
            ),
          },
        }),
      ],
    }),
    Spec.make("websearch-free", {
      description: "Search the web via DuckDuckGo HTML (free, no API key)",
      globalFlags: ServerFlags,
      params: {
        query: Argument.String("query").pipe(Argument.withDescription("Search query")),
        num: Flag.Int("num").pipe(
          Flag.withDescription("Max results (default 8, max 20; the provider returns at most 8)"),
          Flag.withDefault(8),
        ),
      },
    }),
    Spec.make("tools", {
      description: "Print the canonical tool catalog: registered / materialized / visible to the LLM",
      globalFlags: ServerFlags,
      params: {
        category: Flag.String("category").pipe(
          Flag.withDescription("Filter to a single category (e.g. Repository, Mesh, Primitive)"),
          Flag.optional,
        ),
      },
    }),
    Spec.make("telemetry", {
      description: "Telemetry subcommands (status/on/off/agent-report/agent-export)",
      globalFlags: ServerFlags,
      commands: [
        Spec.make("status", { description: "Show install telemetry status" }),
        Spec.make("on", { description: "Enable install telemetry (default)" }),
        Spec.make("off", { description: "Disable install telemetry" }),
        Spec.make("agent-report", {
          description: "Show local agent-efficiency telemetry",
          params: {
            runId: Flag.String("run-id").pipe(Flag.withDescription("Filter by run id"), Flag.optional),
            sessionId: Flag.String("session-id").pipe(
              Flag.withDescription("Filter by session id"),
              Flag.optional,
            ),
            since: Flag.Int("since").pipe(
              Flag.withDescription("Only include events after this epoch millisecond"),
              Flag.optional,
            ),
            json: Flag.Boolean("json").pipe(
              Flag.withDescription("Print the report as JSON"),
              Flag.withDefault(false),
            ),
          },
        }),
        Spec.make("agent-export", {
          description: "Export sanitized local agent telemetry as JSONL",
          params: {
            runId: Flag.String("run-id").pipe(Flag.withDescription("Filter by run id"), Flag.optional),
            sessionId: Flag.String("session-id").pipe(
              Flag.withDescription("Filter by session id"),
              Flag.optional,
            ),
            since: Flag.Int("since").pipe(
              Flag.withDescription("Only include events after this epoch millisecond"),
              Flag.optional,
            ),
          },
        }),
      ],
    }),
    Spec.make("db", {
      description: "Database tools",
      globalFlags: ServerFlags,
      commands: [
        Spec.make("gc", {
          description:
            "List orphaned BanyanCode project databases and delete them only with --yes (dry-run by default)",
          params: {
            yes: Flag.Boolean("yes").pipe(
              Flag.withDescription("Actually delete orphaned databases (without this flag nothing is deleted)"),
              Flag.withDefault(false),
            ),
            dryRun: Flag.Boolean("dry-run").pipe(
              Flag.withDescription("List what would be deleted without deleting, even with --yes"),
              Flag.optional,
            ),
            root: Flag.String("root").pipe(
              Flag.withDescription(
                "Project root whose worktree hash identifies current databases (defaults to cwd)",
              ),
              Flag.optional,
            ),
          },
        }),
      ],
    }),
  ],
})

export const Commands = Root
