# commandcode-acp

An [Agent Client Protocol (ACP)](https://agentclientprotocol.com) stdio adapter for [Command Code](https://commandcode.ai) (`cmd`). It bridges `cmd` into ACP hosts such as [Zed](https://zed.dev), VS Code / GitHub Copilot clients, and [Devin Desktop](https://docs.devin.ai/desktop/acp), so you can use Command Code's models and coding agent from any ACP-compatible editor.

Modeled after [`oz-acp`](https://github.com/tariqwest/oz-acp) / [`warp-acp`](https://github.com/tariqwest/warp-acp) / [`antigravity-acp`](https://github.com/shubzkothekar/antigravity-acp) / [`fm-acp`](https://github.com/tariqwest/fm-acp), implemented in TypeScript and driven by Command Code's headless mode (`cmd -p --output-format json`).

```
ACP host (Zed / VS Code / …)
   <--stdin/stdout NDJSON-->  commandcode-acp  <--subprocess-->  cmd -p --output-format json
```

## Status

**v0.1.0 released.** The adapter is installable from GitHub (npx) and from the [Homebrew tap](https://github.com/tariqwest/homebrew-tap) (`tariqwest/tap`). It is **not yet published to npm** — the `commandcode-acp` name is reserved and will be published in a future release; for now use the GitHub/npx path below.

## Features

- **Full ACP session lifecycle** — `new` / `load` / `resume` / `list` / `delete` / `close`, plus `prompt` / `cancel` and config options
- **Multi-turn continuation** — each ACP session binds to a Command Code headless session id; later turns resume via `cmd --resume` so prior context carries automatically
- **Live tool streaming** — `cmd -p` NDJSON tool frames stream to the host as `tool_call` updates while the run is in progress
- **Config options** — model (from `cmd --list-models`), reasoning `effort`, and `permission_mode` (standard / plan / auto-accept), settable via host UI or `session/set_config_option`
- **Session persistence** — bindings survive restarts at `~/.config/commandcode-acp/sessions.json`
- **Dual runtime** — runs on Bun (direct `.ts`) or Node + tsx (`npx`), no compile step

## Prerequisites

- **Bun 1.1+** and/or **Node.js 22+**
  - **Bun:** preferred for development; also supported when running the package under Bun (`bunx`, `bun run`)
  - **Node + tsx:** default package bin path for `npx` / global npm / many ACP hosts
- **`cmd`** on your `PATH` — Command Code: `npm i -g command-code`
- Auth via `cmd login` (or a provider API key configured for Command Code)

Check tools:

```bash
bun -v    # optional but recommended (>= 1.1)
node -v   # >= 22 when using npx / Node hosts
cmd --version
cmd whoami
```

If `cmd whoami` fails, run `cmd login` first.

## Setup

### Run without installing (happy path)

```bash
# from GitHub (no local clone required)
npx -y https://github.com/tariqwest/commandcode-acp

# Homebrew (requires Node; cmd on PATH — see Prerequisites)
brew tap tariqwest/tap && brew install commandcode-acp

# after the package is published on npm
npx -y commandcode-acp
```

These install/run paths use the package bin (`bin/commandcode-acp.mjs`): under **Node** it loads TypeScript via **tsx** (for `npx` compatibility); under **Bun** it imports `src/index.ts` directly.

> **npm note:** the `commandcode-acp` npm package is not published yet — the GitHub `npx` and Homebrew paths above are the current install methods.

### Install the CLI

```bash
# from GitHub
npm install -g https://github.com/tariqwest/commandcode-acp
# Homebrew tap (requires cmd on PATH — see Prerequisites)
brew tap tariqwest/tap && brew install commandcode-acp
# after npm publish
npm install -g commandcode-acp

commandcode-acp   # on PATH (Node+tsx or Bun, depending on how the bin is invoked)
```

### Contributor setup (Bun)

```bash
git clone https://github.com/tariqwest/commandcode-acp.git
cd commandcode-acp
bun install
chmod +x bin/commandcode-acp.mjs
bun test
bun run typecheck
```

Day-to-day development uses **Bun** only — see [Development](#development).

### Smoke-check (stdio JSON-RPC)

```bash
# installed / npx (Node + tsx)
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' \
  | npx -y https://github.com/tariqwest/commandcode-acp

# local Bun dev entry
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' \
  | bun src/index.ts
```

You should see a JSON-RPC result with `"agentInfo":{"name":"cmd",...}` on stdout. Diagnostic logs go to stderr only.

### Runtime split (no compile step)

| Mode | How TypeScript runs | Command |
|---|---|---|
| **Dev (Bun)** | Bun runs `.ts` directly | `bun run dev` / `bun start` / `bun test` |
| **Released under Bun** | Bin detects Bun and imports `src/index.ts` | `bunx commandcode-acp` / `bun run` of the installed bin |
| **Released under Node** | Bin spawns Node + **tsx** → `src/index.ts` | `npx commandcode-acp` / `node bin/commandcode-acp.mjs` / most ACP hosts |

There is no `tsc` emit for any path. Bun remains a first-class runtime; the Node/tsx path exists so `npx` and Node-only hosts keep working. `bun run typecheck` (`tsc --noEmit`) is optional for contributors.

## Usage

`commandcode-acp` is an **ACP agent server**. An ACP host (editor/UI) starts it as a subprocess and speaks [JSON-RPC over stdio](https://agentclientprotocol.com) (newline-delimited JSON). You normally do **not** run it interactively yourself—the host owns the transport.

### What you can do with it

| Goal | How |
|---|---|
| Use Command Code from an ACP host | Register `commandcode-acp` as a custom agent (see [Host setup](#host-setup)) |
| Resume a prior chat | Host calls `session/load` / `session/resume` with the saved `sessionId` |
| Pick model / effort / permission mode | Host config UI or `session/set_config_option` (`model`, `effort`, `permission_mode`) |
| Cancel an in-flight turn | Host sends `session/cancel` (kills the local `cmd` child) |
| Point Command Code at a project directory | Host passes `cwd` on `session/new` (cmd runs from that directory) |
| Attach files / selection context | Host sends `resource_link` or embedded `resource` content blocks in `session/prompt` |

### Typical ACP session flow

1. Host starts `commandcode-acp` and calls **`initialize`** (ACP protocol version `1`).
2. Host calls **`session/new`** with an absolute `cwd` (your project root).
3. Host sends **`session/prompt`** with content blocks (text, `resource_link`, embedded `resource`; image/audio not forwarded).
4. Adapter runs `cmd -p "<prompt>" --output-format json` (resuming the bound Command Code session when one exists), streams NDJSON events live, and emits **`session/update`** (`agent_message_chunk`, `tool_call`, `usage_update`, `session_info_update` when available).
5. When the `cmd` run finishes, **`session/prompt`** returns a `stopReason` (`end_turn`, `max_turn_requests`, `cancelled`, or classified `max_tokens` / `refusal`).
6. Later turns reuse the same ACP `sessionId`; the adapter continues the bound Command Code session via `cmd --resume <cmdSessionId>`.

Supported agent methods include: `initialize`, `session/new`, `session/load`, `session/resume`, `session/list`, `session/delete`, `session/close`, `session/prompt`, `session/cancel`, `session/set_config_option` (plus `session/set_model` aliases).

### Run the adapter manually (debug only)

```bash
# installed package bin (works on Node via tsx, or Bun directly)
commandcode-acp
npx -y https://github.com/tariqwest/commandcode-acp
bunx commandcode-acp

# local clone (Bun)
bun start
bun run dev   # watch mode
```

Smoke without a full host:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' \
  '{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"'"$(pwd)"'","mcpServers":[]}}' \
  | bun src/index.ts
```

Expect JSON-RPC responses for `initialize` and `session/new` on stdout. Keep logs on stderr only—stdout is the ACP transport.

### Session config options

On `initialize` / session setup, `commandcode-acp` loads `cmd --list-models`, then exposes ACP `configOptions`:

| `configId` | Type | Notes |
|---|---|---|
| `model` | select | One entry per model id from `cmd --list-models` |
| `effort` | select | `low` / `medium` / `high` / `xhigh` / `max` — only when the selected model supports reasoning-effort control |
| `permission_mode` | select | `standard` / `plan` / `auto-accept` → `--permission-mode` (auto-accept maps to `--auto-accept`, plan to `--plan`) |

Command Code does **not** expose a free-form `temperature` or profile config, so those are not offered.

### Extra cmd args

Pass extra CLI flags to every `cmd` invocation with `CMD_EXTRA_ARGS` in the agent `env` (or your shell):

```bash
CMD_EXTRA_ARGS='--config theme=dark' commandcode-acp
```

## Host setup

`commandcode-acp` is an **ACP agent server** (stdio JSON-RPC). Hosts spawn it as a subprocess. Auth for Command Code stays with Command Code (`cmd login` / provider keys) — not Claude / Codex / Cursor / Copilot / Devin subscriptions.

### How to launch commandcode-acp

Use one of these (no local clone required):

| Situation | `command` | `args` |
|---|---|---|
| Installed globally (`npm i -g …` / on `PATH`) | `commandcode-acp` | `[]` |
| Not installed yet (GitHub) | `npx` | `["-y", "https://github.com/tariqwest/commandcode-acp"]` |
| Published on npm | `npx` | `["-y", "commandcode-acp"]` |

GUI hosts often have a thin `PATH`; if `commandcode-acp` is not found, prefer the `npx` form.

### Generic ACP agent definition

Most ACP hosts share the same spawn shape (`command` + `args` + optional `env`). Only the **settings file / key** differs.

**Recommended (works without a prior install):**

```json
{
  "cmd": {
    "type": "custom",
    "command": "npx",
    "args": ["-y", "https://github.com/tariqwest/commandcode-acp"],
    "env": {}
  }
}
```

**If `commandcode-acp` is already on PATH:**

```json
{
  "cmd": {
    "type": "custom",
    "command": "commandcode-acp",
    "args": [],
    "env": {}
  }
}
```

**After npm publish**, you can use `"args": ["-y", "commandcode-acp"]` with `npx` instead of the GitHub URL. Until then, the GitHub URL form above is the working install path.

| Field | Required | Notes |
|---|---|---|
| `command` | yes | `commandcode-acp` or `npx` |
| `args` | no | empty for global install; `npx` args as above |
| `env` | no | `CMD_BIN_PATH`, `CMD_EXTRA_ARGS`, … |
| `type` | recommended | `"custom"` where the host distinguishes registry vs custom |
| `name` | optional | Display name when the map key is not shown |
| `cwd` | optional | Some VS Code clients support a process working directory |

### Hosts using generic `agent_servers` / `acp.agents`

These clients all take the same spawn object. Paste the generic definition under the key your host reads:

| Host | Config location | Settings key |
|---|---|---|
| **Zed** | `~/.config/zed/settings.json` (or Agent Settings → External Agents → Add Custom Agent) | `agent_servers` |
| **JetBrains** AI Assistant | `~/.jetbrains/acp.json` (AI Chat → Add Custom Agent) | `agent_servers` |
| **VS Code** [ACP Client](https://marketplace.visualstudio.com/items?itemName=formulahendry.acp-client) | User/workspace `settings.json` | `acp.agents` |
| **VS Code** [ACP plugin](https://marketplace.visualstudio.com/items?itemName=strato-space.acp-plugin) | User/workspace `settings.json` | `agent_servers` (alias: `acp.agents`) |
| **VS Code** [Multicoder](https://marketplace.visualstudio.com/items?itemName=multicoder.multicoder) | User/workspace `settings.json` | `multicoder.agentServers` |
| Other ACP clients | Host docs | Usually `agent_servers` or equivalent |

**Example (Zed / JetBrains / VS Code ACP plugin):**

```json
{
  "agent_servers": {
    "cmd": {
      "type": "custom",
      "command": "npx",
      "args": ["-y", "https://github.com/tariqwest/commandcode-acp"],
      "env": {}
    }
  }
}
```

Then open the host's agent/chat UI, select **cmd** / **Command Code**, and start a session in a project workspace (that directory becomes session `cwd`).

| Host tips |
|---|
| **Zed** — Agent Panel (`Cmd-?` on macOS). Debug: **dev: open acp logs**. Docs: [External Agents](https://zed.dev/docs/ai/external-agents). |
| **JetBrains** — AI Chat agent picker. Prefer `npx` if the IDE's `PATH` is thin. |
| **VS Code** — Install an ACP *client* extension first; stock VS Code/Copilot Chat does not host arbitrary ACP agents. |

### Devin Desktop

[Devin Desktop](https://docs.devin.ai/desktop/acp) uses an **ACP registry file**, then an enable toggle.

| Build | Registry path |
|---|---|
| Devin Desktop | `~/.windsurf/acp/registry.json` |
| Devin Desktop Next | `~/.windsurf-next/acp/registry.json` |

**Sample entry** (GitHub via `npx`; swap to `"cmd": "commandcode-acp", "args": []` if installed globally):

```json
{
  "version": "1.0.0",
  "agents": [
    {
      "id": "commandcode-acp",
      "name": "Command Code",
      "version": "0.1.0",
      "description": "Command Code ACP adapter (commandcode-acp)",
      "authors": ["local"],
      "license": "MIT",
      "distribution": {
        "binary": {
          "darwin-aarch64": {
            "archive": "",
            "cmd": "npx",
            "args": ["-y", "https://github.com/tariqwest/commandcode-acp"]
          },
          "darwin-x86_64": {
            "archive": "",
            "cmd": "npx",
            "args": ["-y", "https://github.com/tariqwest/commandcode-acp"]
          },
          "linux-aarch64": {
            "archive": "",
            "cmd": "npx",
            "args": ["-y", "https://github.com/tariqwest/commandcode-acp"]
          },
          "linux-x86_64": {
            "archive": "",
            "cmd": "npx",
            "args": ["-y", "https://github.com/tariqwest/commandcode-acp"]
          },
          "windows-aarch64": {
            "archive": "",
            "cmd": "npx",
            "args": ["-y", "https://github.com/tariqwest/commandcode-acp"]
          },
          "windows-x86_64": {
            "archive": "",
            "cmd": "npx",
            "args": ["-y", "https://github.com/tariqwest/commandcode-acp"]
          }
        }
      }
    }
  ],
  "extensions": []
}
```

Enable:

1. **Devin User Settings** → **Agents** → toggle **Command Code**
2. Restart Devin Desktop (or **Reload ACP Connections**)
3. New conversation → pick **Command Code**

Env (`CMD_BIN_PATH`, …): Agents tab **…** menu.

Docs: [Devin Desktop ACP](https://docs.devin.ai/desktop/acp), [custom agents](https://docs.devin.ai/desktop/acp-custom).

## Environment variables

| Variable | Description |
|---|---|
| `CMD_BIN_PATH` | Full path to the `cmd` binary |
| `CMD_INSTALL_PATH` | Directory containing `cmd` |
| `CMD_EXTRA_ARGS` | Shell-style extra args prepended to every `cmd` invocation |
| `XDG_CONFIG_HOME` | Config root for session persistence (`$XDG_CONFIG_HOME/commandcode-acp`) |
| `HOME` | Fallback config root when `XDG_CONFIG_HOME` is unset (`~/.config/commandcode-acp`) |

## Session persistence

Sessions are stored at `$XDG_CONFIG_HOME/commandcode-acp/sessions.json` (default `~/.config/commandcode-acp/sessions.json`) with a lock file. Bindings include the Command Code `cmdSessionId` (the `cmd --resume` key), `modelId`, `effort`, `permissionMode`, `cwd`, title, and emitted-content keys for replay/delta.

Model IDs are cached at `$XDG_CONFIG_HOME/commandcode-acp/models_cache.json` (default `~/.config/commandcode-acp/models_cache.json`).

## How a prompt turn works

1. Flatten ACP text prompt blocks
2. `cmd -p "<prompt>" --output-format json --skip-onboarding --max-turns 100 [-m <model>] [--effort <level>] [--auto-accept|--plan] [--resume <cmdSessionId>]` (run from the session `cwd`)
3. Stream NDJSON lines live (`{"type":"event",...}` tool frames) into ACP `session/update` (`tool_call`)
4. The final result line carries `sessionId` (stored for resume), `finalText` (→ `agent_message_chunk`), `usage` (→ `usage_update`), and `stopReason`/`subtype`
5. Complete `session/prompt` with `{ stopReason: "end_turn" | "max_turn_requests" | "cancelled" | … }`

Note: headless runs only emit the assistant's **final** text (plus live tool events), not token-by-token streaming — the host sees one `agent_message_chunk` per turn plus tool activity as it happens.

## What is NOT forwarded (by design)

| Capability | Why |
|---|---|
| Host `mcpServers` | Command Code manages its own MCP servers; the adapter runs `cmd` which uses its own config. `mcpCapabilities` are `false`. |
| `additionalDirectories` | `cmd` uses its own workspace scoping (the session `cwd`). |
| Image / audio prompt blocks | Headless `cmd -p` is text-only; placeholders preserve awareness. |
| Tool results (`tool_call_update`) | The headless JSON stream does not emit tool results today; the host sees the final text + live `tool_call` frames. |

## Development

This repo is **Bun-first**. Use Bun for install, run, test, release scripts, and as a supported production runtime. The package bin also supports **Node + tsx** so `npx` and Node-only ACP hosts work without Bun.

### Workflow

```bash
bun install                 # creates/updates bun.lock
bun run dev                 # bun --watch src/index.ts
bun start                   # bun src/index.ts (stdio ACP server)
bun test                    # bun test src
bun run typecheck           # tsc --noEmit (optional)
```

| Script | What it runs |
|---|---|
| `bun run dev` | Watch-mode ACP server on stdio |
| `bun start` / `bun run commandcode-acp` | One-shot Bun server (`src/index.ts`) |
| `bun test` | Unit tests under `src/` |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run formula …` | Generate Homebrew formula (preview; releases update the tap automatically) |
| `bun run release …` | Tag + GitHub release + Homebrew tap (optional `--npm`; skip tap with `--no-homebrew`) |
| `bun run start:node` | Force Node+tsx start path |
| `bun run test:node` | Node+tsx/`node:test` unit tests |
| `node bin/commandcode-acp.mjs` | Package bin under Node (tsx) |
| `bun bin/commandcode-acp.mjs` | Package bin under Bun (direct `.ts` import) |

### Bun vs Node+tsx

- **Bun** is supported for development **and** release/runtime (`bunx commandcode-acp`, `bun bin/commandcode-acp.mjs`, or running `src/index.ts` directly).
- **Node + tsx** is the compatibility entry for **`npx`**, global npm installs, Homebrew's Node dependency, and hosts that only spawn Node.
- Lockfile is `bun.lock` (`packageManager` is Bun). Do not reintroduce pnpm lockfiles.
- **`tsx` stays a runtime dependency** so the Node path works without requiring Bun on the host.

## Release

Every release **couples** a GitHub release (tag + `gh release`) with a Homebrew formula update on `tariqwest/homebrew-tap`. npm publish remains optional (and is **not yet done** for the current release).

```bash
# dry-run (no git/gh/npm/tap changes)
bun run release 0.1.1 --dry-run

# GitHub release + Homebrew formula (default)
bun run release 0.1.1

# + npm publish (requires npm login; also reserves the package name)
bun run release 0.1.1 --npm
# or: bun scripts/release.mjs 0.1.1 --npm --yes

# bump from package.json (patch|minor|major)
bun run release patch --npm --yes

# GitHub only (skip tap)
bun run release 0.1.4 --no-homebrew --yes
```

Requires a clean git worktree and `gh` auth. For `--npm` also run `npm login` first. OTP: `--otp 123456`.

> **Note:** the formula fetches the GitHub tag tarball, so the repo must be **public** for `brew install` to work for others. A private repo will fail at `--source github` with an HTTP 404.

Package publish surface: `bin/`, non-test `src/`, `README.md`, `AGENTS.md`, `LICENSE` (see `package.json` `files` + `.npmignore`). `prepublishOnly` runs `bun test` and `bun run typecheck`.

Project layout:

| Path | Purpose |
|---|---|
| `bin/commandcode-acp.mjs` | Package bin: Bun → direct `.ts`; Node → tsx (npx-compatible) |
| `src/index.ts` | ACP stdio server (Bun and Node/tsx) |
| `src/adapter.ts` | Session lifecycle + prompt orchestration |
| `src/cmd.ts` | Command Code CLI subprocess helpers (`-p` NDJSON driver) |
| `src/map.ts` | NDJSON event/result → ACP updates; prompt flatten; stop reasons |
| `src/config-options.ts` | ACP config option builders (model/effort/permission_mode) |
| `src/session-store.ts` | Persistent session store |
| `src/shell-words.ts` | `CMD_EXTRA_ARGS` splitter |
| `src/types.ts` | zod schemas (NDJSON frames, stored session) |
| `src/*.test.ts` | Unit tests (`node:test`, run under `bun test` / `bun run test:node`) |
| `scripts/release.mjs` | GitHub release + Homebrew tap (+ optional npm) |
| `scripts/generate-homebrew-formula.mjs` | Homebrew formula generator |
| `bun.lock` | Bun lockfile (dev) |
| `AGENTS.md` | Notes for coding agents |

## Troubleshooting

| Symptom | What to check |
|---|---|
| `failed to spawn cmd` | `cmd` on PATH for the **host process**, or set `CMD_BIN_PATH` / `CMD_INSTALL_PATH` in the agent `env` |
| Auth / whoami warnings | `cmd login` (or provider keys configured for Command Code) |
| Devin Desktop missing Command Code | Add registry entry under `~/.windsurf/acp/registry.json`, enable in **Agents**, restart or **Reload ACP Connections** |
| Empty model list | Network/auth; cache falls back to a built-in model list |
| Host shows no agent output | Ensure stdout is reserved for JSON-RPC (logs are on stderr only); confirm `session/update` notifications are accepted by the host |
| Host cannot start agent | Need **Node 22+** (npx path) or **Bun 1.1+**. Try `npx -y https://github.com/tariqwest/commandcode-acp`, `bunx commandcode-acp` |
| Agent missing in VS Code | Install an ACP client extension; use the settings key it documents (`agent_servers`, `acp.agents`, or `multicoder.agentServers`) |
| No model/effort UI | Host must render ACP `configOptions`; otherwise call `session/set_config_option` |
| Prompt hangs / no updates | Confirm `cmd whoami` works and the account has credits |

## License

MIT
