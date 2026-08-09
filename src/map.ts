import type { PrintLine, PrintResult } from "./types.ts";

export type AcpSessionUpdate = Record<string, unknown>;

export type MappedDelta = {
  key: string;
  update: AcpSessionUpdate;
};

/**
 * Classify a Command Code tool name into an ACP tool kind.
 * Mirrors the classifier used by oz-acp.
 */
export function toolKindFromName(name: string | undefined): string {
  const lower = `${name ?? ""}`.toLowerCase();
  if (lower.includes("write") || lower.includes("edit") || lower.includes("patch")) {
    return "edit";
  }
  if (lower.includes("delete") || lower.includes("remove")) return "delete";
  if (lower.includes("move") || lower.includes("rename")) return "move";
  if (
    lower.includes("read") ||
    lower.includes("view") ||
    lower.includes("list") ||
    lower.includes("files")
  ) {
    return "read";
  }
  if (lower.includes("grep") || lower.includes("search") || lower.includes("find")) {
    return "search";
  }
  if (
    lower.includes("command") ||
    lower.includes("execute") ||
    lower.includes("terminal") ||
    lower.includes("run_command") ||
    lower === "bash" ||
    lower === "sh" ||
    lower.includes("shell")
  ) {
    return "execute";
  }
  if (
    lower.includes("think") ||
    lower.includes("reason") ||
    lower.includes("plan") ||
    lower.includes("skill")
  ) {
    return "think";
  }
  if (lower.includes("url") || lower.includes("fetch") || lower.includes("http")) {
    return "fetch";
  }
  return "other";
}

/** Map a headless event frame to an ACP session/update payload (or null). */
export function mapEventFrameToUpdate(
  event: Record<string, unknown>,
): AcpSessionUpdate | null {
  if (!event || typeof event !== "object") return null;
  const type = typeof event.type === "string" ? event.type : "";
  if (type === "tool_running") {
    const toolCallId =
      typeof event.toolCallId === "string"
        ? event.toolCallId
        : `tool-${Date.now()}`;
    const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
    const description =
      typeof event.description === "string" ? event.description : "";
    const update: AcpSessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId,
      title: toolName,
      kind: toolKindFromName(toolName),
      status: "in_progress",
    };
    if (description) {
      update.content = [
        {
          type: "content",
          content: { type: "text", text: description },
        },
      ];
    }
    return update;
  }
  // Unknown / future event types: forward-compatible, ignore.
  return null;
}

/** Stable key for a mapped event/result delta (dedup + seen tracking). */
export function keyForUpdate(update: AcpSessionUpdate): string {
  const kind = String(update.sessionUpdate ?? "update");
  const id =
    typeof update.messageId === "string"
      ? update.messageId
      : typeof update.toolCallId === "string"
        ? update.toolCallId
        : typeof update.title === "string"
          ? update.title
          : "";
  return `${kind}:${id}:${JSON.stringify(update.content ?? update.rawInput ?? update.rawOutput ?? "")}`;
}

/**
 * Convert a `cmd -p --output-format json` result line into ACP updates.
 * Returns null when the result carries no forwardable content.
 */
export function mapPrintResultToUpdates(
  result: PrintResult,
  messageId: string,
  seenKeys: ReadonlySet<string>,
): MappedDelta[] {
  const deltas: MappedDelta[] = [];

  const finalText = typeof result.finalText === "string" ? result.finalText : "";
  if (finalText.trim()) {
    const update: AcpSessionUpdate = {
      sessionUpdate: "agent_message_chunk",
      messageId,
      content: { type: "text", text: finalText },
    };
    const key = keyForUpdate(update);
    if (!seenKeys.has(key)) deltas.push({ key, update });
  }

  const usage = usageUpdateFromResult(result);
  if (usage) {
    const update = usage as unknown as AcpSessionUpdate;
    const key = keyForUpdate(update);
    if (!seenKeys.has(key)) deltas.push({ key, update });
  }

  return deltas;
}

/** Best-effort extract of ACP usage_update fields from a cmd result line. */
export function usageUpdateFromResult(result: PrintResult): {
  sessionUpdate: "usage_update";
  used: number;
  size: number;
  cost?: { amount: number; currency: string };
} | null {
  const usage =
    result.usage && typeof result.usage === "object"
      ? (result.usage as Record<string, unknown>)
      : result;

  const num = (...keys: string[]): number | null => {
    for (const key of keys) {
      const v = usage[key];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
      if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
    }
    return null;
  };

  const used = num(
    "used",
    "totalTokens",
    "total_tokens",
    "promptTokens",
    "inputTokens",
    "input_tokens",
    "tokens",
  );
  const size = num("size", "contextWindow", "context_window", "maxContextTokens");

  if (used == null || size == null || size <= 0) return null;

  const update: {
    sessionUpdate: "usage_update";
    used: number;
    size: number;
    cost?: { amount: number; currency: string };
  } = {
    sessionUpdate: "usage_update",
    used,
    size,
  };

  const amount = num("costAmount", "totalCost", "cost_amount", "total_cost");
  const currencyRaw =
    (typeof usage.currency === "string" && usage.currency) || undefined;
  if (amount != null && currencyRaw) {
    update.cost = { amount, currency: currencyRaw.toUpperCase() };
  }
  return update;
}

export type AcpStopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

function classifyFailureMessage(message: string): AcpStopReason | null {
  const lower = message.toLowerCase();
  if (
    /max[_\s-]?tokens|context length|token limit|too many tokens|maximum context/i.test(
      lower,
    )
  ) {
    return "max_tokens";
  }
  if (/max[_\s-]?turn|too many (?:requests|turns)|turn limit/i.test(lower)) {
    return "max_turn_requests";
  }
  if (/refus|content.?policy|safety|disallowed|i can'?t assist|cannot assist/i.test(lower)) {
    return "refusal";
  }
  return null;
}

export function decideStopReason(opts: {
  cancelled: boolean;
  result: PrintResult | null;
  exitCode: number;
  hadUpdates: boolean;
}): { stopReason?: AcpStopReason; error?: string } {
  const { cancelled, result, exitCode, hadUpdates } = opts;

  if (cancelled) return { stopReason: "cancelled" };
  if (exitCode === 130) return { stopReason: "cancelled" };

  if (result) {
    if (result.subtype === "success") return { stopReason: "end_turn" };
    if (result.subtype === "max_turns") return { stopReason: "max_turn_requests" };
    if (result.subtype === "error") {
      if (result.stopReason === "refusal") return { stopReason: "refusal" };
      if (result.stopReason === "max_tokens") return { stopReason: "max_tokens" };
      const msg =
        typeof result.error === "string"
          ? result.error
          : typeof result.error === "object" && result.error
            ? JSON.stringify(result.error)
            : "";
      const classified = classifyFailureMessage(msg);
      if (classified) return { stopReason: classified };
      if (hadUpdates) return { stopReason: "end_turn" };
      return { error: msg || `cmd run failed with subtype ${result.subtype}` };
    }
  }

  // No result line (child died / non-JSON output).
  if (exitCode === 8) return { stopReason: "max_turn_requests" };
  if (exitCode === 3) {
    return { error: "cmd is not authenticated — run `cmd login` first" };
  }
  if (exitCode === 4) {
    return { error: "cmd permission denied — configure permission mode or use auto-accept" };
  }
  if (hadUpdates) return { stopReason: "end_turn" };
  return { error: `cmd exited with code ${exitCode} and no result line` };
}

// ── Prompt flattening (same behavior as oz-acp) ──────────────────────

function formatResourceLink(block: Record<string, unknown>): string {
  const name =
    typeof block.name === "string" && block.name.trim()
      ? block.name.trim()
      : typeof block.title === "string" && block.title.trim()
        ? block.title.trim()
        : "resource";
  const uri = typeof block.uri === "string" ? block.uri : "";
  const mime =
    typeof block.mimeType === "string" && block.mimeType.trim()
      ? ` (${block.mimeType.trim()})`
      : "";
  const description =
    typeof block.description === "string" && block.description.trim()
      ? `\n${block.description.trim()}`
      : "";
  if (uri) return `[resource_link] ${name}${mime}: ${uri}${description}`;
  return `[resource_link] ${name}${mime}${description}`;
}

function formatEmbeddedResource(block: Record<string, unknown>): string {
  const resource =
    block.resource && typeof block.resource === "object"
      ? (block.resource as Record<string, unknown>)
      : block;
  const uri = typeof resource.uri === "string" ? resource.uri : "";
  const mime =
    typeof resource.mimeType === "string" && resource.mimeType.trim()
      ? resource.mimeType.trim()
      : typeof block.mimeType === "string" && block.mimeType.trim()
        ? block.mimeType.trim()
        : "";
  const headerParts = ["[resource]"];
  if (uri) headerParts.push(uri);
  if (mime) headerParts.push(`(${mime})`);
  const header = headerParts.join(" ");

  if (typeof resource.text === "string" && resource.text.length) {
    return `${header}\n${resource.text}`;
  }
  if (typeof block.text === "string" && block.text.length) {
    return `${header}\n${block.text}`;
  }
  if (typeof resource.blob === "string" && resource.blob.length) {
    const bytes = Math.floor((resource.blob.length * 3) / 4);
    return `${header}\n[embedded binary blob ~${bytes} bytes; content not inlined into cmd prompt]`;
  }
  return header;
}

function formatImageOrAudio(block: Record<string, unknown>, kind: "image" | "audio"): string {
  const mime =
    typeof block.mimeType === "string" && block.mimeType.trim()
      ? block.mimeType.trim()
      : kind;
  const uri = typeof block.uri === "string" && block.uri.trim() ? block.uri.trim() : "";
  const dataLen =
    typeof block.data === "string" ? Math.floor((block.data.length * 3) / 4) : 0;
  const parts = [`[${kind} omitted — not forwarded to cmd]`, mime];
  if (uri) parts.push(uri);
  if (dataLen) parts.push(`~${dataLen} bytes`);
  return parts.join(" ");
}

/**
 * Flatten ACP prompt content blocks into a single text string for `cmd -p`.
 * Baseline: text + resource_link + embedded resource text. Image/audio placeholders.
 */
export function flattenPromptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) {
    return typeof prompt === "string" ? prompt : "";
  }
  return prompt
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const b = block as Record<string, unknown>;
      const type = typeof b.type === "string" ? b.type : "";

      if (type === "text" || (!type && typeof b.text === "string")) {
        return typeof b.text === "string" ? b.text : "";
      }
      if (type === "resource_link") return formatResourceLink(b);
      if (type === "resource") return formatEmbeddedResource(b);
      if (type === "image") return formatImageOrAudio(b, "image");
      if (type === "audio") return formatImageOrAudio(b, "audio");

      if (typeof b.text === "string" && b.text.trim()) return b.text;
      return "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

/** Derive a session title from the first user prompt (fm-acp pattern). */
export function deriveSessionTitle(promptText: string): string {
  const single = promptText.replace(/\s+/g, " ").trim();
  if (!single) return "Command Code session";
  return single.length > 60 ? `${single.slice(0, 57)}…` : single;
}

/** Type guard: is this parsed NDJSON line a result or event frame? */
export function classifyPrintLine(raw: unknown): PrintLine | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const type = typeof obj.type === "string" ? obj.type : "";
  if (type === "result") {
    return { kind: "result", result: obj as unknown as PrintResult };
  }
  if (type === "event" && obj.event && typeof obj.event === "object") {
    return {
      kind: "event",
      frame: { type: "event", event: obj.event as Record<string, unknown> },
    };
  }
  return { kind: "other", raw: obj };
}
