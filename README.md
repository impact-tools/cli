# Impact CLI

Launch installed Claude Code, Codex, Kilo Code and OpenCode clients through Impact from your current directory.

```sh
impact login --base-url https://api.impactllm.com
impact claude
impact codex
impact kilo
impact opencode
impact status
```

Login uses Better Auth device authorization: approve the terminal's code in your browser. The CLI stores an Impact API key in the OS configuration directory with owner-only permissions. `impact logout` removes the saved key locally; revoke it in Impact's API keys page to invalidate it.

For an existing key, use `impact login --api-key` for a hidden prompt or `impact login --key-stdin`. Native client arguments pass through unchanged, including `impact claude -p "hello"` and `impact codex exec "hello"`.

## Development

From the repository root:

```sh
bun run cli:dev login
bun run cli:dev claude
bun run cli:dev codex
bun run cli:dev kilo
bun run cli:dev opencode
bun run cli:dev status
```

The development script selects `http://impactllm.localhost:4420` and preserves the caller's working directory. HTTP is accepted only for loopback hosts. `IMPACT_BASE_URL` selects another endpoint when running `src/main.ts` directly or the built CLI.

```sh
bun run cli:build
node cli/dist/impact.js --help
bun run cli:build:bin
cli/dist/impact --help
```

## Claude Code configuration

Claude Code merges the launch settings with its user, project, and local settings. Explicit `--settings` JSON or files are merged into the same launch overlay. Impact supplies the gateway endpoint and credential helper; model choices, role overrides, permissions, hooks, and MCP configuration keep their native precedence. `IMPACT_MODEL` changes the model only when you set it explicitly.

The `/model` picker lists each enabled canonical Impact model once, with readable display names and the original model IDs sent to the gateway. Claude aliases are accepted internally for `--model` and existing configurations, but are not listed as duplicate picker models. Spellings with dots, without the `claude-` prefix, and with `[1m]` resolve to the canonical route; for example `opus-5.5` and `claude-opus-5.5[1m]`. The context suffix is accepted only for routes with a million-token window. Replacing the built-in picker requires Claude Code 2.1.242 or later.

For a custom model selected at launch, Impact declares its context size through `CLAUDE_CODE_MAX_CONTEXT_TOKENS`. GPT's default window is 272,000 tokens, matching the live Codex catalog. Claude Code 2.1.288 or later also receives compaction budgets per custom model; smaller budgets you saved are preserved. Claude currently exposes the declared window as one environment variable for the session. Switching custom models inside the session keeps that declaration; restart with `--model <id>` to update it. Compaction budgets still cap smaller models. The native warning that GPT is not a recognized Claude model may remain.

The status line displays `Impact · account email · $balance USD`. The wallet balance includes funds held for active requests; older servers without a total balance fall back to available credits. It updates every 30 seconds and appends to your existing status line, preserving its session input and display options. Settings files are preserved; the temporary status snapshot is removed on exit. Claude Code's built-in `/status` shows the gateway address and credential source; the wallet appears under the prompt.

## Codex configuration

Each launch reads the existing `CODEX_HOME/config.toml` (default `~/.codex/config.toml`), merges Impact settings into a temporary native profile, and runs Codex with `--no-daemon --profile <name>`. The original file is preserved byte for byte. The profile and downloaded model catalog are removed when the process exits. User MCP servers and other settings are retained; the built-in OpenAI apps integration is disabled in the Impact profile because its MCP backend is outside Impact's gateway.

Codex loads Impact's native model names and Fast capabilities. Fast pricing is configured per model route by the Impact administrator. Each launch obtains the Impact key owner's identity from `/v1/usage` and creates a temporary, isolated Codex authentication file for the account UI. The original ChatGPT login is preserved. Codex settings, skills, plugins, sessions and history remain available. A loopback proxy supplies the actual Impact key upstream and uses a temporary TLS certificate trusted by the child process, including for HTTP development backends.

Inside Codex, `/status` identifies the account as `Impact · <email>` and shows available funds in its `Credits` row. Codex 0.160.0 rounds that USD amount to an integer and displays `Unknown` for the plan, because an Impact wallet is not a ChatGPT subscription. `impact status` shows the full wallet balance, including active reservations, with `Held` and `Available` listed separately. It also shows total spending and a per-model breakdown for the dashboard's last-seven-days period. Spending is fetched only for this command; an unavailable breakdown does not hide the balance. An existing ChatGPT login is not required.

The launcher configures a named `impact` Responses provider instead of overriding `openai_base_url`. This avoids Codex's base-URL warning and loads every enabled public model, including Claude, Gemini and GLM. The provider uses HTTP because Codex's WebSocket setting applies to the whole provider and the other families use the HTTP translation routes. GPT HTTP Responses still preserves its native payload and SSE. In Codex 0.160.0, remote compaction is restricted to built-in OpenAI/Azure providers; the custom provider uses local compaction. Account and usage polling remain enabled through the isolated authentication profile. The temporary account has no ChatGPT workspace ID: workspace discovery would otherwise overwrite its email with a plan-only account display.

The `app-server` subcommand lacks the native `--profile` option. It receives equivalent scoped configuration overrides instead. Interactive launches select embedded mode explicitly and do not produce the shared-server configuration warning.

## Kilo Code configuration

Install Kilo with `npm install -g @kilocode/cli`, then launch it with `impact kilo`. Impact provides a temporary `KILO_CONFIG_CONTENT` overlay; Kilo continues loading your user and project settings, MCP servers, agents, skills, sessions and history. Configuration files are preserved. Existing inline JSON settings are retained, with the Impact provider and model defaults supplied by the launcher.

Each launch reads `/v1/models` and registers every enabled model under the `impact` provider, with its context window, output limit, capabilities and current input, output and cache prices. Only Impact models are enabled during the launch. The provider uses OpenAI-compatible Chat Completions and reads the Impact key from the child environment. The key is absent from command arguments and generated settings.

The initial model defaults to `gpt-6.1-sol` when available, otherwise the first enabled model. `IMPACT_MODEL` changes this default; Kilo's explicit `--model impact/<model-id>` takes precedence. Auxiliary requests use `gpt-5.6-luna` when available, otherwise the initial model, through the same gateway.

```sh
impact kilo models impact
impact kilo run --model impact/claude-opus-5-5 --variant xhigh "Review this change"
IMPACT_MODEL=claude-opus-5-5 impact kilo
```

Reasoning variants come from the gateway's `reasoning_efforts`, including `xhigh` and `max` where advertised, and are sent as `reasoning_effort`. All native arguments and stdin pass through unchanged, and the launcher returns Kilo's exit code. Standalone `--help` and `--version` work without an Impact login. This integration was checked with Kilo 7.8.3; the [Kilo provider documentation](https://kilo.ai/docs/ai-providers/openai-compatible) describes the underlying configuration format.

## OpenCode configuration

Install OpenCode with `npm install -g opencode-ai` or its install script, then launch it with `impact opencode`. Kilo is an OpenCode fork, and OpenCode receives the same overlay through `OPENCODE_CONFIG_CONTENT`: the full Impact catalog, the same default and auxiliary models, `IMPACT_MODEL`, and the key read from the child environment. Configuration files, existing inline JSON settings, MCP servers, agents and sessions are preserved.

```sh
impact opencode models impact --verbose
impact opencode run --model impact/claude-opus-5-5 --variant max "Review this change"
```

OpenCode adds its own `low`, `medium` and `high` variants to every reasoning model. The launcher disables each effort the gateway does not advertise, so the variant list matches `reasoning_efforts`; for example, a model advertising only `none` and `high` offers exactly those two. Requests carry OpenCode's own `User-Agent`, which Impact identifies as OpenCode. This integration was checked with OpenCode 1.18.31 and 1.18.34.

## Cursor Tab autocomplete

The gateway supports native Cursor `StreamCpp` requests, but a Cursor Desktop Tab launcher or settings generator is not implemented in this CLI. Cursor's OpenAI key/base-URL override configures chat and agent, not Tab. Shell `--completions` scripts are unrelated to editor autocomplete.

The first desktop validation target is macOS; no desktop platform is verified yet. A persistent proxy and reversible Cursor setup are being evaluated for native Tab plus an Impact-only model picker. Editor proxy settings, local-provider discovery and Tab traffic need separate validation; changing the model list alone does not prove inference works. System proxy/PAC or trusted-CA changes must be explicit and reversible, with TLS verification retained. The Codex proxy is not a drop-in adapter: it uses a temporary native provider URL and child-scoped certificate setting.

Static inspection of the official macOS ARM64 Cursor 3.22.12 distribution found its bundled local HTTP-provider mode disabled by a build flag. That mode also disables Tab when active, so it is not a verified solution for an Impact-only picker together with native Tab. Environment variables do not activate it.

See the [Cursor guide](../packages/web/content/docs/clients/cursor.mdx) for the native endpoint, account requirements and current integration status. Do not add guessed Tab backend fields to `settings.json` or disable certificate verification to connect it.

## Source layout

- `clients/Launch.ts` lists the clients and runs the chosen one; `clients/Client.ts` holds what they share.
- `clients/claude/` owns Claude settings, the model picker and the status line.
- `clients/codex/` owns Codex authentication, profiles, model catalog, loopback proxy, and TLS certificates.
- `clients/opencode/` owns the launch overlay and model definitions, prices and reasoning variants shared by OpenCode and Kilo.
- `commands/` defines the CLI commands; `Command.ts` assembles them. `impact helper token` and `impact helper status-line` are unlisted commands that clients call during a launch.
- `auth/` handles Impact device authorization and API key input.
- `config/` validates connections and stores credentials.
- `api/` calls Impact: `Http.ts` makes authenticated JSON requests, the other modules read models and usage.
- `process/` builds the command lines clients use to call back into this CLI.

Expected failures are `CliError`s with a one-line message; `main.ts` prints it and exits with code 1. Effect handles argument parsing, HTTP and scoped cleanup of processes, profiles, sockets, and temporary certificates. The process spawner uses the Node platform implementation, so both the Node JavaScript bundle and compiled Bun executable are supported.

## Overrides

| Variable                                                                          | Purpose                                                   |
| --------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `IMPACT_BASE_URL`                                                                 | Impact origin, without `/v1`                              |
| `IMPACT_API_KEY`                                                                  | Key for this invocation; no need to save it               |
| `IMPACT_MODEL`                                                                    | Initial model from the enabled catalog                    |
| `IMPACT_CONFIG_DIR`                                                               | CLI credential directory                                  |
| `IMPACT_CLAUDE_BIN`, `IMPACT_CODEX_BIN`, `IMPACT_KILO_BIN`, `IMPACT_OPENCODE_BIN` | Native client executable                                  |
| `CODEX_HOME`                                                                      | Existing Codex configuration and authentication directory |

Model routing is managed in `/admin/routing`. Public names such as `gpt-6.1-sol` and `claude-sonnet-5-5` select a configured provider and upstream model. Provider-prefixed internal names are rejected; the supported Claude aliases retain the configured route, prices and upstream ID.

## Model discovery cache

Model discovery uses stale-while-revalidate: process memory plus optional Redis, with catalogs fresh for 15 minutes and cached for up to 24 hours. Refreshes are coalesced per key, with a five-second failure backoff. Keys include the owner and provider configuration. Quota refreshes run in the background after a minute; routing and financial admission continue to use Postgres and real provider refusals.
