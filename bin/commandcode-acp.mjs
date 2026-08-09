#!/usr/bin/env node
/**
 * Package bin entry for commandcode-acp.
 *
 * - Under Bun (`bunx commandcode-acp`, `bun run` of the bin): load TypeScript directly.
 * - Under Node (`npx commandcode-acp`, global npm/Homebrew install): spawn Node with tsx.
 *
 * Dev clone still prefers `bun src/index.ts` / `bun run dev`.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "../src/index.ts");

const isBun = typeof globalThis.Bun !== "undefined";

if (isBun) {
  // Bun can import .ts directly — no tsx child process.
  await import(pathToFileURL(entry).href);
} else {
  const tsxImport = require.resolve("tsx/esm");
  const child = spawn(
    process.execPath,
    ["--import", tsxImport, entry, ...process.argv.slice(2)],
    {
      stdio: "inherit",
      env: process.env,
    },
  );

  child.on("error", (err) => {
    console.error("[commandcode-acp] failed to start:", err);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}
