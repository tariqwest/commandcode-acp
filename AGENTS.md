# commandcode-acp

TypeScript ACP stdio adapter for the Command Code CLI (`cmd`).

- **Primary runtime / dev:** Bun (install, run, test, scripts, `bunx`)
- **Node compatibility entry:** `bin/commandcode-acp.mjs` uses tsx under Node so `npx` / npm global / Node-only hosts work without Bun
- **No emit step** for either path

## Setup

```bash
bun install
chmod +x bin/commandcode-acp.mjs
bun test
bun run typecheck
```

| Entry | Command |
|---|---|
| Dev | `bun src/index.ts` / `bun run dev` |
| Package bin under Bun | `bun bin/commandcode-acp.mjs` / `bunx commandcode-acp` |
| Package bin under Node (npx) | `node bin/commandcode-acp.mjs` / `npx commandcode-acp` |

## Commands

```bash
bun install
bun run dev                # bun --watch src/index.ts
bun start                  # bun src/index.ts (stdio ACP server)
bun test                   # bun test src
bun run typecheck          # tsc --noEmit
bun run start:node         # force Node+tsx start
bun run test:node          # Node+tsx/`node:test` parity
bun bin/commandcode-acp.mjs   # package bin on Bun
node bin/commandcode-acp.mjs  # package bin on Node (tsx; npx path)
bun run formula <ver>      # print Homebrew formula (preview)
bun run release <ver>      # GitHub release + Homebrew tap (default); add --npm; --no-homebrew to skip tap
```

Lockfile: `bun.lock` (do not reintroduce pnpm lockfiles).

## Architecture

- `src/index.ts` — ACP SDK `ndJsonStream` + request handlers on stdio
- `src/adapter.ts` — session lifecycle, models/config options, prompt orchestration
- `src/cmd.ts` — spawn/parse `cmd -p --output-format json` NDJSON headless stream
- `src/map.ts` — NDJSON event/result → ACP `session/update` payloads; prompt flatten; stop reasons
- `src/config-options.ts` — ACP config option builders (model/effort/permission_mode)
- `src/session-store.ts` — `$XDG_CONFIG_HOME/commandcode-acp` persistence (default `~/.config/commandcode-acp`)
- `src/shell-words.ts` — `CMD_EXTRA_ARGS` splitter
- `src/types.ts` — zod schemas
- `bin/commandcode-acp.mjs` — package bin; Bun imports `src/index.ts` directly, Node spawns tsx (npx-compatible)
- `scripts/release.mjs` — GitHub release + Homebrew tap update (coupled by default; optional npm); checks via Bun
- `scripts/generate-homebrew-formula.mjs` — Homebrew formula generator (used by release; local preview via `bun run formula`)

## Key paths

| Path | Purpose |
|---|---|
| `$XDG_CONFIG_HOME/commandcode-acp/sessions.json` (default `~/.config/commandcode-acp/sessions.json`) | ACP session → cmd session/model/effort/mode bindings |
| `$XDG_CONFIG_HOME/commandcode-acp/models_cache.json` (default `~/.config/commandcode-acp/models_cache.json`) | cached `cmd --list-models` ids |

## Command Code CLI surface used

- `cmd --version`
- `cmd --list-models` (one id per line, or JSON array)
- `cmd whoami` (auth check)
- `cmd -p <prompt> --output-format json [--resume <id>] [-m <model>] [--effort <level>] [--auto-accept|--plan] [--skip-onboarding] [--max-turns N]` (NDJSON headless stream)
- Exit codes: 0 ok, 3 auth, 4 permission, 8 max-turns, 130 interrupted, etc.

## Notes

- ACP protocol version 1 (Zed-compatible): `session/prompt` returns `stopReason` (`end_turn` | `max_turn_requests` | `cancelled` | `max_tokens` | `refusal` when classifiable).
- Prompt content: text + `resource_link` + embedded `resource` (text inlined; blobs placeholder). Image/audio not forwarded (capability flags false; placeholders only).
- Host `mcpServers` are **not** forwarded — Command Code manages its own MCP servers. `mcpCapabilities` are false. `additionalDirectories` is also not forwarded.
- `cmd -p` stdout is NDJSON: `{"type":"event","event":{...}}` tool frames + one final `{"type":"result",...}` line (`subtype`, `sessionId`, `stopReason`, `usage`, `finalText`, `error`, `durationMs`). Parse line by line; never `JSON.parse` the whole stdout as one object.
- The result line's `sessionId` is stored as the session's `cmdSessionId` — multi-turn continuation uses `cmd --resume <cmdSessionId>` so prior context carries automatically.
- Headless output is the assistant's **final** text plus live tool frames (no token-by-token streaming).
- Cancellation: abort in-flight CLI children via `AbortSignal` (SIGTERM then SIGKILL). No remote cancel needed (local process only).
- Keep stderr logging only — stdout is the ACP transport.
- `model` config values come from `cmd --list-models`; `effort` availability per model comes from the built-in catalog map in `src/config-options.ts`.
