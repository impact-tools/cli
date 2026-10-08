# Impact CLI

Launch installed Claude Code, Codex, Cursor Desktop, Kilo Code and OpenCode clients through Impact from your current directory.

```sh
impact login --base-url https://api.impactllm.com
impact claude
impact codex
impact kilo
impact opencode
impact cursor
impact status
```

Login uses Better Auth device authorization: approve the terminal's code in your browser. The CLI stores an Impact API key in the OS configuration directory with owner-only permissions. `impact logout` removes the saved key locally; revoke it in Impact's API keys page to invalidate it.

For an existing key, use `impact login --api-key` for a hidden prompt or `impact login --key-stdin`. Native client arguments pass through unchanged, including `impact claude -p "hello"` and `impact codex exec "hello"`.

## Installation from npm

The public npm package is `@impact-relay/cli`, hosted on npmjs.com. You need Node.js 22 or later. Installation requires no npm account or token.

```sh
npm install --global @impact-relay/cli
impact --version
```

You can also download the `.tgz` artifact from a successful Actions run and install it with `npm install --global ./impact-relay-cli-0.1.0.tgz`. The archive includes the bundled CLI and requires no runtime dependencies or Bun installation.

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

## Local proxy and Cursor Tab autocomplete

```sh
# Serve the local API and native Cursor backend until Ctrl+C.
impact proxy --port 8080

# Start a scoped proxy and open Cursor Desktop from this directory.
impact cursor .
```

`impact proxy` prints a loopback capability URL and its OpenAI-compatible `/v1` base URL. Use the full printed URL, including its random path. The proxy supplies the saved Impact key for models, usage, Responses, Chat Completions, Messages and image API requests. It accepts HTTP/1.1 and cleartext HTTP/2; the URL expires when the process stops. It is a local backend endpoint, not an HTTP CONNECT proxy. Cursor's cloud-mediated OpenAI override needs the public Impact URL rather than this loopback address.

`impact cursor` supplies Cursor's native `--test-backend-url`, a dedicated persistent user-data directory and `--wait`. The backend override was found in the official macOS ARM64 Cursor 3.22.12 build. The profile defaults to `<Impact config directory>/cursor/profile`; on first launch the Desktop session database from the standard Cursor profile is copied when it exists, so an existing Cursor login is reused without moving the Impact key into Cursor storage. If no Cursor session exists, sign in once in the managed profile. Set `IMPACT_CURSOR_BIN` for another Desktop executable, `IMPACT_CURSOR_USER_DATA_DIR` for another managed profile, or `IMPACT_CURSOR_PROFILE_SOURCE` to select the source profile explicitly. Run this on the computer with Desktop installed; the remote SSH/WSL Cursor CLI cannot configure local Tab. Close the managed profile's windows before relaunching so an existing process does not retain an old backend URL.

Native `StreamCpp` requests go to Impact with Impact authorization. The gateway chooses its Cursor pool account according to the key's enabled funding sources. Other native RPCs use the editor's own Cursor login against Cursor's HTTP/1 backend. The local proxy preserves native Tab configuration while enabling the Impact-backed frontend, requesting full text, and disabling account-bound context chunks and FileSync. This avoids asking a gateway account to resolve files synced under the editor account. Tab config field numbers were checked against Cursor 3.22.12's shipped protobuf descriptors. This setup uses no custom CA or system trust changes.

For a separately launched Desktop, keep `impact proxy` open and pass its **Cursor backend** URL through `--test-backend-url=<URL>`, together with a separate `--user-data-dir` and `--wait`. Closing the waited-for files/window or stopping Impact ends the managed proxy; keep it running for ongoing suggestions.

Tests exercise the real CLI launcher, native config replies, opaque Connect streaming over HTTP/1.1 and HTTP/2, credential substitution, cancellation and cleanup. A live Desktop suggestion has not been verified in this environment. Other Cursor versions may change these internal flags or descriptors. The native gateway route remains `https://api.impactllm.com/aiserver.v1.AiService/StreamCpp`; the OpenAI base-URL setting configures chat and agent separately, and the launcher does not replace the Desktop model picker.

## Source layout

- `clients/Launch.ts` lists the clients and runs the chosen one; `clients/Client.ts` holds what they share.
- `clients/claude/` owns Claude settings, the model picker and the status line.
- `clients/cursor/` owns the native Desktop backend, Tab configuration and dedicated launch profile.
- `clients/codex/` owns Codex authentication, profiles, model catalog, loopback proxy, and TLS certificates.
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
| `IMPACT_CLAUDE_BIN`, `IMPACT_CODEX_BIN`, `IMPACT_CURSOR_BIN`, `IMPACT_KILO_BIN`, `IMPACT_OPENCODE_BIN` | Native client executable                                   |
| `IMPACT_CURSOR_USER_DATA_DIR`                                                                          | Persistent Cursor profile used by the launcher             |
| `IMPACT_CURSOR_PROFILE_SOURCE`                                                                         | Existing Cursor profile whose Desktop auth state is reused |
| `IMPACT_DISABLE_UPDATE_CHECK`                                                                          | Disable the interactive npm version check                  |
| `CODEX_HOME`                                                                                           | Existing Codex configuration and authentication directory  |

Model routing is managed in `/admin/routing`. Public names such as `gpt-6.1-sol` and `claude-sonnet-5-5` select a configured provider and upstream model. Provider-prefixed internal names are rejected; the supported Claude aliases retain the configured route, prices and upstream ID.

## Model discovery cache

Model discovery uses stale-while-revalidate: process memory plus optional Redis, with catalogs fresh for 15 minutes and cached for up to 24 hours. Refreshes are coalesced per key, with a five-second failure backoff. Keys include the owner and provider configuration. Quota refreshes run in the background after a minute; routing and financial admission continue to use Postgres and real provider refusals.
