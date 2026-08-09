import { spawn } from "node:child_process";
import { split as splitShellWords } from "./shell-words.ts";
import {
  classifyPrintLine,
  type AcpSessionUpdate,
} from "./map.ts";
import {
  CMD_EXIT,
  ModelListSchema,
  WhoamiSchema,
  type ModelList,
  type PrintLine,
  type PrintResult,
} from "./types.ts";

export class CmdCliError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;

  constructor(
    message: string,
    opts: { exitCode?: number | null; stderr?: string; stdout?: string } = {},
  ) {
    super(message);
    this.name = "CmdCliError";
    this.exitCode = opts.exitCode ?? null;
    this.stderr = opts.stderr ?? "";
    this.stdout = opts.stdout ?? "";
  }
}

export function resolveCmdBin(): string {
  const binPath = process.env.CMD_BIN_PATH?.trim();
  if (binPath) return binPath;
  const installPath = process.env.CMD_INSTALL_PATH?.trim();
  if (installPath) {
    return `${installPath.replace(/\/$/, "")}/cmd`;
  }
  return "cmd";
}

function extraArgs(): string[] {
  const raw = process.env.CMD_EXTRA_ARGS?.trim();
  if (!raw) return [];
  try {
    return splitShellWords(raw);
  } catch (err) {
    console.error("[commandcode-acp] WARN: failed to parse CMD_EXTRA_ARGS, ignoring:", err);
    return [];
  }
}

export type CmdExecOptions = {
  args: string[];
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type CmdExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export async function runCmd(opts: CmdExecOptions): Promise<CmdExecResult> {
  const bin = resolveCmdBin();
  const args = [...extraArgs(), ...opts.args];

  return await new Promise<CmdExecResult>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const onAbort = () => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 1500).unref();
    };

    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs);
      timer.unref();
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      timer && clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(
        new CmdCliError(`failed to spawn cmd (${bin}): ${err.message}`, {
          stderr,
          stdout,
        }),
      );
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      timer && clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 0,
      });
    });
  });
}

async function runCmdJson<T>(
  args: string[],
  parse: (value: unknown) => T,
  opts: { cwd?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const result = await runCmd({
    args,
    cwd: opts.cwd,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
  });

  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new CmdCliError(
      detail
        ? `cmd ${args.join(" ")} failed: ${detail}`
        : `cmd ${args.join(" ")} exited with code ${result.exitCode}`,
      result,
    );
  }

  const text = result.stdout.trim();
  if (!text) {
    throw new CmdCliError(`cmd ${args.join(" ")} returned empty stdout`, result);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new CmdCliError(
      `cmd ${args.join(" ")} returned invalid JSON: ${(err as Error).message}`,
      result,
    );
  }

  return parse(parsed);
}

export async function cmdWhoami(signal?: AbortSignal) {
  return runCmdJson(["whoami"], (v) => WhoamiSchema.parse(v), {
    signal,
    timeoutMs: 15_000,
  });
}

export async function cmdVersion(signal?: AbortSignal): Promise<string> {
  const result = await runCmd({
    args: ["--version"],
    signal,
    timeoutMs: 10_000,
  });
  return result.stdout.trim() || "unknown";
}

export async function cmdModelList(signal?: AbortSignal): Promise<ModelList> {
  const result = await runCmd({
    args: ["--list-models"],
    signal,
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new CmdCliError(
      detail
        ? `cmd --list-models failed: ${detail}`
        : `cmd --list-models exited with code ${result.exitCode}`,
      result,
    );
  }
  const text = result.stdout.trim();
  if (!text) return [];
  // --list-models may print one id per line, or a JSON array.
  if (text.startsWith("[")) {
    try {
      return ModelListSchema.parse(JSON.parse(text));
    } catch {
      // fall through to line parse
    }
  }
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export type CmdPrintRunInput = {
  prompt: string;
  cwd: string;
  cmdSessionId?: string | null;
  modelId?: string | null;
  effort?: string | null;
  permissionMode?: string | null;
  maxTurns?: number;
  signal?: AbortSignal;
  /** Called for each parsed NDJSON line as it arrives. */
  onLine?: (line: PrintLine) => void | Promise<void>;
};

export type CmdPrintRunResult = {
  lines: PrintLine[];
  result: PrintResult | null;
  stdout: string;
  stderr: string;
  exitCode: number;
};

/**
 * Run `cmd -p <prompt> --output-format json` and consume its NDJSON stream.
 *
 * stdout = NDJSON: event frames + one final result line. Parsed line-by-line so
 * the host can stream `session/update` notifications live.
 */
export async function cmdPrintRun(input: CmdPrintRunInput): Promise<CmdPrintRunResult> {
  const args = [
    "-p",
    input.prompt,
    "--output-format",
    "json",
    // Automation: never trigger taste onboarding prompts.
    "--skip-onboarding",
    "--max-turns",
    String(input.maxTurns ?? 100),
  ];
  if (input.cmdSessionId) {
    args.push("--resume", input.cmdSessionId);
  }
  if (input.modelId) {
    args.push("--model", input.modelId);
  }
  if (input.effort) {
    args.push("--effort", input.effort);
  }
  if (input.permissionMode === "auto-accept") {
    args.push("--auto-accept");
  } else if (input.permissionMode === "plan") {
    args.push("--plan");
  } else if (input.permissionMode === "standard") {
    // Standard is the headless default; no flag needed.
  }

  const bin = resolveCmdBin();
  const fullArgs = [...extraArgs(), ...args];
  const lines: PrintLine[] = [];
  let stdout = "";
  let stderr = "";

  const result = await new Promise<CmdExecResult>((resolve, reject) => {
    const child = spawn(bin, fullArgs, {
      cwd: input.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    let lineBuf = "";
    const pending: Promise<void>[] = [];

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return; // non-JSON line: not part of the NDJSON stream
      }
      const classified = classifyPrintLine(parsed);
      if (!classified) return;
      lines.push(classified);
      if (input.onLine) {
        pending.push(
          Promise.resolve(input.onLine(classified)).catch((err) => {
            console.error(
              "[commandcode-acp] WARN: onLine handler failed:",
              (err as Error).message,
            );
          }),
        );
      }
    };

    const onAbort = () => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 1500).unref();
    };

    if (input.signal) {
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      lineBuf += chunk;
      let idx: number;
      while ((idx = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, idx);
        lineBuf = lineBuf.slice(idx + 1);
        handleLine(line);
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener("abort", onAbort);
      reject(
        new CmdCliError(`failed to spawn cmd (${bin}): ${err.message}`, {
          stderr,
          stdout,
        }),
      );
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener("abort", onAbort);
      if (lineBuf.trim()) handleLine(lineBuf);
      void Promise.all(pending).finally(() => {
        resolve({ stdout, stderr, exitCode: code ?? 0 });
      });
    });
  });

  const lastResult =
    [...lines].reverse().find((l): l is Extract<PrintLine, { kind: "result" }> => l.kind === "result")
      ?.result ?? null;

  return {
    lines,
    result: lastResult,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}

/** Map a cmd exit code to a stop reason (for streams with no result line). */
export function stopReasonFromExitCode(code: number): string | null {
  switch (code) {
    case CMD_EXIT.SUCCESS:
      return "end_turn";
    case CMD_EXIT.MAX_TURNS_REACHED:
      return "max_turn_requests";
    case CMD_EXIT.INTERRUPTED:
      return "cancelled";
    default:
      return null;
  }
}

/** Map an ACP session/update to a stable dedup key (reused in adapter). */
export function updateKey(update: AcpSessionUpdate): string {
  const kind = String(update.sessionUpdate ?? "update");
  const id =
    typeof update.messageId === "string"
      ? update.messageId
      : typeof update.toolCallId === "string"
        ? update.toolCallId
        : "";
  return `${kind}:${id}:${JSON.stringify(update.content ?? "")}`;
}
