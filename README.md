# Impact CLI

Launch installed Claude Code, Codex, Cursor Desktop, Antigravity Agents or IDE, Kilo Code and OpenCode clients through Impact from your current directory.

```sh
impact login --base-url https://api.impact-relay.com
impact claude
impact codex
impact kilo
impact opencode
impact cursor
impact antigravity
impact status
```

Login uses Better Auth device authorization: approve the terminal's code in your browser. The CLI stores an Impact API key in the OS configuration directory with owner-only permissions. Browser-created keys are revoked when a later login replaces them or when `impact logout` removes them; imported keys are never revoked by the CLI.

For an existing key, use `impact login --api-key` for a hidden prompt or `impact login --key-stdin`. Native client arguments pass through unchanged, including `impact claude -p "hello"` and `impact codex exec "hello"`.

## Installation from npm

The public npm package is `@impact-relay/cli`, hosted on npmjs.com. You need Node.js 22.13 or later for the native SQLite profile API. Installation requires no npm account or token.

```sh
npm install --global @impact-relay/cli
impact --version
```

You can also download the `.tgz` artifact from a successful Actions run and install it with `npm install --global ./impact-relay-cli-0.2.1.tgz`. The archive includes the bundled CLI and requires no runtime dependencies or Bun installation.

## Build and release

The `Build and release` workflow (`.github/workflows/publish.yml`) runs on pull requests, pushes to `main` and manual dispatch. It installs locked dependencies, checks types, runs tests, builds the Node.js bundle, packs a `.tgz`, installs that archive and runs it, then uploads it as the `npm-package` artifact.

Releases are cut by [release-please](https://github.com/googleapis/release-please) from [Conventional Commits](https://www.conventionalcommits.org/): on every push to `main` it opens or updates a release PR that bumps the version in `package.json`, `.release-please-manifest.json` and `CHANGELOG.md`. Before 1.0, `feat` bumps the minor version and `fix` the patch. Merging the PR tags the release `v<version>`, creates the GitHub Release and publishes that commit's archive publicly to npmjs.com through [npm trusted publishing](https://docs.npmjs.com/trusted-publishers): the package trusts `publish.yml` in this repository, so no npm token is stored. The repository must allow GitHub Actions to create pull requests (Settings → Actions → General).

## Development

This repository builds independently with Bun 1.4.2:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run dev login
bun run dev claude
bun run dev codex
bun run dev kilo
bun run dev opencode
bun run dev status
```

The development script selects `http://impactllm.localhost:4420` and preserves the caller's working directory. HTTP is accepted only for loopback hosts. `IMPACT_BASE_URL` selects another endpoint when running `src/main.ts` directly or the built CLI.

Interactive launches check the public npm registry for a newer CLI version and show a one-line update hint when one is available. The check is skipped for help, version, completions, non-TTY output and CI. Set `IMPACT_DISABLE_UPDATE_CHECK=1` to disable it explicitly.

```sh
bun run build
node dist/impact.js --help
bun run build:bin
dist/impact --help
```

## Claude Code configuration

Claude Code merges the launch settings with its user, project, and local settings. Explicit `--settings` JSON or files are merged into the same launch overlay. Impact supplies the gateway endpoint and credential helper; model choices, role overrides, permissions, hooks, and MCP configuration keep their native precedence. `IMPACT_MODEL` changes the model only when you set it explicitly.

The `/model` picker lists each enabled canonical Impact model once, with readable display names and the original model IDs sent to the gateway. Claude aliases are accepted internally for `--model` and existing configurations, but are not listed as duplicate picker models. Spellings with dots, without the `claude-` prefix, and with `[1m]` resolve to the canonical route; for example `opus-5.5` and `claude-opus-5.5[1m]`. The context suffix is accepted only for routes with a million-token window. Replacing the built-in picker requires Claude Code 2.1.242 or later.

For a custom model selected at launch, Impact declares its context size through `CLAUDE_CODE_MAX_CONTEXT_TOKENS`. GPT's default window is 272,000 tokens, matching the live Codex catalog. Claude Code 2.1.288 or later also receives compaction budgets per custom model; smaller budgets you saved are preserved. Claude currently exposes the declared window as one environment variable for the session. Switching custom models inside the session keeps that declaration; restart with `--model <id>` to update it. Compaction budgets still cap smaller models. The native warning that GPT is not a recognized Claude model may remain.

The status line displays `Impact · account email · $balance USD`. The wallet balance includes funds held for active requests; older servers without a total balance fall back to available credits. It updates every 30 seconds and appends to your existing status line, preserving its session input and display options. Settings files are preserved; the temporary status snapshot is removed on exit. Claude Code's built-in `/status` shows the gateway address and credential source; the wallet appears under the prompt.

## Codex configuration

Run `impact proxy setup` once and `impact proxy start` before launching Codex. Each launch reads the existing `CODEX_HOME/config.toml` (default `~/.codex/config.toml`), merges Impact settings into a temporary native profile, and runs Codex with `--no-daemon --profile <name>`. The original file is preserved byte for byte. The profile and downloaded model catalog are removed when the process exits. User MCP servers and other settings are retained; the built-in OpenAI apps integration is disabled in the Impact profile because its MCP backend is outside Impact's gateway.

Codex loads Impact's native model names and Fast capabilities. Fast pricing is configured per model route by the Impact administrator. Each launch obtains the Impact key owner's identity from `/v1/usage` and creates a temporary, isolated Codex authentication file for the account UI. The original ChatGPT login is preserved. Codex settings, skills, plugins, sessions and history remain available. After exit, the launch home retains only links to sessions, archived sessions and shell snapshots: Codex's SQLite index stores absolute paths through that home, so these aliases must remain for resume. Authentication, profiles and model catalogs are removed. Codex talks to the background proxy (see [Cursor Desktop](#cursor-desktop) for `impact proxy setup` and `start`): a loopback HTTPS endpoint under a secret path that supplies the actual Impact key upstream, including for HTTP development backends. Its certificate has its own CA, trusted only by the launched Codex through a per-launch `CODEX_CA_CERTIFICATE` bundle that adds it to the usual roots. `impact codex` prints the command to run when the proxy is not set up or not running.

Inside Codex, `/status` identifies the account as `Impact · <email>` and shows available funds in its `Credits` row. Codex 0.160.0 rounds that USD amount to an integer and displays `Unknown` for the plan, because an Impact wallet is not a ChatGPT subscription. `impact status` shows the full wallet balance, including active reservations, with `Held` and `Available` listed separately. It also shows total spending and a per-model breakdown for the dashboard's last-seven-days period. Spending is fetched only for this command; an unavailable breakdown does not hide the balance. An existing ChatGPT login is not required.

The launcher configures a named `impact` Responses provider instead of overriding `openai_base_url`. This avoids Codex's base-URL warning and loads every enabled public model, including Claude, Gemini and GLM. The provider uses HTTP because Codex's WebSocket setting applies to the whole provider and the other families use the HTTP translation routes. GPT HTTP Responses still preserves its native payload and SSE. In Codex 0.160.0, remote compaction is restricted to built-in OpenAI/Azure providers; the custom provider uses local compaction. Account and usage polling remain enabled through the isolated authentication profile. The temporary account has no ChatGPT workspace ID: workspace discovery would otherwise overwrite its email with a plan-only account display.

Before launching, the launcher restores missing session aliases referenced by Codex's SQLite index, including aliases deleted by older launcher versions. The index and rollout files are preserved.

The `app-server` subcommand lacks the native `--profile` option. Its isolated launch home receives the merged `config.toml`, keeping the proxy's secret path out of process arguments. Interactive launches select embedded mode explicitly and do not produce the shared-server configuration warning.

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

## Cursor Desktop

```sh
impact proxy setup   # once: certificates, port and proxy login
impact proxy start   # background proxy; also stop, restart, status
impact cursor .
```

Cursor, Codex and Antigravity run through one background proxy. `impact proxy setup` creates its files in `<Impact config directory>/proxy` and prints each path: for Cursor, a CA certificate and a server certificate for Cursor's hosts with its key; for Codex and Antigravity, a CA certificate and a `127.0.0.1` server certificate with its key; and `config.json` with both ports, the proxy login, Codex's secret path and the key that signs local client sessions. Each CA private key is discarded after it signs its server certificate, so nothing else can be issued from it. Secret files are readable only by the owner. Ports are the first free ones in 17420–17439; `--port` selects Cursor's. In a terminal, setup then asks whether to start the proxy (default no). `--force` replaces everything; reopen Impact desktop clients afterwards. Running setup again on a setup from an earlier version adds the Codex endpoint without changing Cursor's certificate.

`impact proxy start` runs `impact proxy run` in the background and writes its output to `proxy/proxy.log`; `impact proxy` and `impact proxy status` show the process, ports and account. Starting checks nothing beyond the proxy's own files: no login, Impact connection or installed client is required. Every request reads the current Impact login, so `impact login` and `impact logout` apply without a restart. Cursor's protocol descriptors, account and model catalog load on Cursor's first request and again when the login or the installed Cursor changes; run `impact proxy restart` to reload the model catalog. Clients never start the proxy: without a setup or a running proxy, or when the proxy reads a different login than the launching shell, they print the command to run and exit.

`impact cursor` launches the unchanged installed Cursor with a dedicated persistent profile and returns; the editor's output goes to `impact-cursor.log` in that profile. When the Impact instance already runs, the arguments open a new window in it. Your normal Cursor window and login remain available. The managed profile defaults to `<Impact config directory>/cursor/profile`. Cursor allows one running instance per profile directory, and this profile holds the local Impact sign-in and model state, so it stays separate from your normal profile. Each fresh launch copies your Cursor configuration into it: settings, keybindings, user tasks, snippets, named profiles with their folder associations, and disabled extensions. Extensions are shared through Cursor's extension directory, and a named profile's extension list is linked, so neither instance removes extensions only the other knows. Settings you change in the Impact window are kept on later launches; other settings follow your normal Cursor. Your normal profile is only read. Conversations and history stay separate. No Cursor account is required: the proxy reads the Impact identity and enabled model catalog and issues a local session, which stays valid across proxy restarts. The real Impact key stays in the proxy and is substituted only on requests to Impact.

Node transports receive the proxy CA through `NODE_EXTRA_CA_CERTS`, added to any roots you already set there. Chromium is explicitly routed with `--proxy-server` and receives the server certificate's SPKI through `--ignore-certificate-errors-spki-list`. No system trust or application files are changed. The launcher sets `--disable-http2` and Cursor's native HTTP/1.1 SSE settings because its custom HTTP/2 transport can bypass environment proxies. The local listener also supports HTTP/2. Native requests must supply the local bearer or use the authenticated CONNECT login; an explicitly invalid bearer is always rejected. This also supports Cursor's extension-host SSE transport when origin headers are absent.

The adapter reads protobuf descriptors from the installed editor without executing its bundle. Native model and account RPCs are answered locally. Chat and agent requests use Impact Chat Completions; native read, write, edit, shell, directory, grep and MCP execution requests are sent back to Cursor, which retains its approval UI. Conversation checkpoints are stored through Cursor's native KV protocol. Cursor's server-side agent prompt is replaced with Impact's own prompt. Always-applied rules, user rules, hook context and MCP instructions are sent in full. Agent-requested rules, file-pattern rules and skills are listed once with their descriptions and paths; the model reads a file when it needs it. Rules, skills and commands the user attaches to a message are sent in full. Tab's `StreamCpp` bytes go to Impact's existing native endpoint; full-text context is enabled and account-bound FileSync and indexing are disabled.

Normal Agent and Ask turns, read-only planning discussions and cancellation are supported. Dedicated plan execution, resume, summarization, cloud/background agents, server-side indexing and native web/search/subagent tools are not implemented. Unsupported actions return explicit errors. This integration was verified with Cursor 3.16.17; other releases can change internal protocols.

Protocol tests cover text generation, history, native tools, HTTP/1.1 SSE/poll fallback, cancellation, credentials and cleanup. Live Desktop checks against a mock Impact backend verified account/model display, an agent response, native file reads and writes with review controls, shell execution and Tab suggestion display and acceptance. Tab relays the native protocol and requires an enabled Cursor funding source in the real Impact backend; these checks do not establish the availability of that funding source.

Run the commands on the computer with Cursor Desktop installed. `IMPACT_CURSOR_BIN` selects another executable and `IMPACT_CURSOR_APP_DIR` its descriptor directory; set them for `impact proxy start` too, since the proxy reads the editor's protocol descriptors. `IMPACT_CURSOR_USER_DATA_DIR` selects another managed profile. Stopping the proxy leaves open Impact windows and Codex sessions without AI until it starts again.

## Antigravity Agents and IDE

```sh
impact proxy setup       # once; prints certificate paths and offers to start
impact proxy start       # or restart after updating the CLI
impact antigravity
```

The launcher detects the installed Antigravity IDE first (`Antigravity IDE.app`, verified with IDE 2.5.5) and falls back to the Antigravity Agents hub (verified with Desktop 2.21.1). `IMPACT_ANTIGRAVITY_BIN` selects another executable. Agents must retain `resources/app.asar` and `resources/bin/language_server`; IDE must retain its `app/product.json` and `app/extensions/antigravity` files. Linux and Windows paths are supported but have not been verified with their native applications.

The launcher uses the installed application unchanged and keeps its normal profile, projects, settings and conversation storage. Quit an already running Antigravity before the first Impact launch so Electron receives the launch environment. No Google login is needed: the stock language server runs in enterprise gateway mode and Impact authenticates generation requests. Account balance remains available through `impact status`.

For Agents, the proxy serves the application's own interface, adapts its gRPC-Web model selection, and translates the native Gemini streaming protocol into Impact Chat Completions. For IDE, the same daemon terminates only the enumerated Google Cloud Code hosts and translates `/v1internal:streamGenerateContent` into Impact Chat Completions. Both model pickers use Impact display names; `IMPACT_MODEL` selects the initial model. Text and reasoning stream as they arrive; tool arguments are assembled before delivery. Native IDE and Agents tools continue using their normal local execution and permission controls. System instructions are passed once, and opaque thought signatures are excluded from replay. Image attachments depend on the selected model's advertised vision capability.

Agents shares Codex's loopback HTTPS listener and certificate. IDE uses the shared Cursor HTTP CONNECT proxy with a dedicated Antigravity CA; the launcher supplies `HTTP_PROXY`, `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, the SPKI pin and a local refresh token. The actual Impact key stays in the daemon. The stock IDE profile, settings, extensions and conversation storage are used unchanged. `proxy/antigravity-session.json` stores the Agents registration; `proxy/antigravity-ide-session.json` stores only the selected IDE model and login hash. The daemon does not restart the remote gateway. Interrupted generations may need to be retried.

Logs are in `proxy/antigravity.log` (language server) and `proxy/antigravity-desktop.log` (Electron). Native logs can include conversation context. After `impact login` switches accounts, quit and relaunch Antigravity to obtain a new local session. After `proxy setup --force`, relaunch desktop clients to load the new certificate.

Supported flows include single-model conversations, model switching, streaming responses and native tool calls with results in Agents and IDE. IDE's Tab/Supercomplete requests use the same Cloud Code stream adapter when the installed language server requests them. Model comparison (Battle Mode), Google-hosted tools and file IDs, image generation, and Google account or marketplace services are not implemented by this adapter. Their availability must not be inferred from the stock interface. The linked [regional bypass project](https://github.com/vezlin1/antigravity-bypass-russia) modifies application files to route Google's service traffic; this integration connects generation to Impact through the CLI proxy.

## Source layout

- `clients/Launch.ts` lists the clients and runs the chosen one; `clients/Client.ts` holds what they share.
- `clients/claude/` owns Claude settings, the model picker and the status line.
- `clients/cursor/` owns the native Desktop backend, HTTPS interception and dedicated launch profile.
- `proxy/` owns the background proxy for Cursor, Codex and Antigravity: its persistent files, the process and its control requests.
- `clients/antigravity/` owns the stock Agents and IDE launch, Cloud Code interception, model selection and Gemini streaming translation.
- `clients/codex/` owns Codex authentication, profiles, model catalog, the loopback endpoint and its certificates.
- `clients/opencode/` owns the launch overlay and model definitions, prices and reasoning variants shared by OpenCode and Kilo.
- `commands/` defines the CLI commands; `Command.ts` assembles them. `impact helper token` and `impact helper status-line` are unlisted commands that clients call during a launch.
- `auth/` handles Impact device authorization and API key input.
- `config/` validates connections and stores credentials.
- `api/` calls Impact: `Http.ts` makes authenticated JSON requests, the other modules read models and usage.
- `schemas/` contains the API contract and model catalog copied from the gateway's shared schemas for independent builds. Keep these contracts in sync when changing the gateway's API. The CLI RPC group includes only API key creation.
- `process/` builds the command lines clients use to call back into this CLI.

Expected failures are `CliError`s with a one-line message; `main.ts` prints it and exits with code 1. Effect handles argument parsing, HTTP and scoped cleanup of processes, profiles, sockets, and temporary certificates. The process spawner uses the Node platform implementation, so both the Node JavaScript bundle and compiled Bun executable are supported.

## Overrides

| Variable                                                                                               | Purpose                                                    |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `IMPACT_BASE_URL`                                                                                      | Impact origin, without `/v1`                               |
| `IMPACT_API_KEY`                                                                                       | Key for this invocation; no need to save it                |
| `IMPACT_MODEL`                                                                                         | Initial model from the enabled catalog                     |
| `IMPACT_CONFIG_DIR`                                                                                    | CLI credential directory                                   |
| `IMPACT_CLAUDE_BIN`, `IMPACT_CODEX_BIN`, `IMPACT_CURSOR_BIN`, `IMPACT_ANTIGRAVITY_BIN`, `IMPACT_KILO_BIN`, `IMPACT_OPENCODE_BIN` | Native client executable                                   |
| `IMPACT_CURSOR_USER_DATA_DIR`                                                                          | Persistent Cursor profile used by the launcher             |
| `IMPACT_CURSOR_APP_DIR`                                                                                | Installed Cursor application or resources directory for descriptors |
| `IMPACT_CURSOR_DEBUG`                                                                                  | Set to `1` for local route and transport diagnostics        |
| `IMPACT_DISABLE_UPDATE_CHECK`                                                                          | Disable the interactive npm version check                  |
| `CODEX_HOME`                                                                                           | Existing Codex configuration and authentication directory  |

Model routing is managed in `/admin/routing`. Public names such as `gpt-6.1-sol` and `claude-sonnet-5-5` select a configured provider and upstream model. Provider-prefixed internal names are rejected; the supported Claude aliases retain the configured route, prices and upstream ID.

## Model discovery cache

Model discovery uses stale-while-revalidate: process memory plus optional Redis, with catalogs fresh for 15 minutes and cached for up to 24 hours. Refreshes are coalesced per key, with a five-second failure backoff. Keys include the owner and provider configuration. Quota refreshes run in the background after a minute; routing and financial admission continue to use Postgres and real provider refusals.
