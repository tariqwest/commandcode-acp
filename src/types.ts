import { z } from "zod";

/**
 * Headless (`cmd -p --output-format json`) NDJSON line shapes.
 *
 * Two shapes:
 *  - event frames:  {"type":"event","event":{"type":"tool_running","toolCallId":"…","toolName":"read_file","description":"…"}}
 *  - result line (always last): {"type":"result","subtype":"success|error|max_turns","sessionId"?,"stopReason"?,"usage","finalText","error"?,"durationMs"}
 */
export const PrintResultSchema = z
  .object({
    type: z.literal("result"),
    subtype: z.enum(["success", "error", "max_turns"]),
    sessionId: z.string().optional(),
    stopReason: z.string().optional(),
    usage: z.unknown().optional(),
    finalText: z.string().optional(),
    error: z.unknown().optional(),
    durationMs: z.number().optional(),
  })
  .passthrough();
export type PrintResult = z.infer<typeof PrintResultSchema>;

export type PrintEventFrame = {
  type: "event";
  event: Record<string, unknown>;
};

export type PrintLine =
  | { kind: "result"; result: PrintResult }
  | { kind: "event"; frame: PrintEventFrame }
  | { kind: "other"; raw: Record<string, unknown> };

/** Exit codes from headless mode (EXIT_* constants). */
export const CMD_EXIT = {
  SUCCESS: 0,
  ERROR: 1,
  AUTH_ERROR: 3,
  PERMISSION_DENIED: 4,
  RATE_LIMITED: 5,
  CONNECTION_ERROR: 6,
  SERVER_ERROR: 7,
  MAX_TURNS_REACHED: 8,
  NO_RESPONSE: 9,
  INSUFFICIENT_CREDITS: 10,
  INTERRUPTED: 130,
} as const;

export const EffortLevelSchema = z.enum([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type EffortLevel = z.infer<typeof EffortLevelSchema>;

export const PermissionModeSchema = z.enum([
  "standard",
  "plan",
  "auto-accept",
]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export const ModelListSchema = z.array(z.string());
export type ModelList = string[];

export const WhoamiSchema = z
  .object({
    email: z.string().optional(),
    name: z.string().optional(),
    display_name: z.string().optional(),
    uid: z.string().optional(),
  })
  .passthrough();

export const StoredSessionSchema = z.object({
  /** Command Code headless session id (resume key for `cmd --resume`). */
  cmdSessionId: z.string().nullable().optional(),
  modelId: z.string().nullable().optional(),
  effort: EffortLevelSchema.nullable().optional(),
  permissionMode: PermissionModeSchema.nullable().optional(),
  cwd: z.string().optional(),
  seenKeys: z.array(z.string()).optional(),
  title: z.string().nullable().optional(),
  updatedAt: z.string().optional(),
});
export type StoredSession = z.infer<typeof StoredSessionSchema>;

export const SessionStoreSchema = z.object({
  sessions: z.record(z.string(), StoredSessionSchema).optional(),
});
export type SessionStoreFile = z.infer<typeof SessionStoreSchema>;

export type Session = {
  cmdSessionId: string | null;
  modelId: string | null;
  effort: EffortLevel | null;
  permissionMode: PermissionMode | null;
  cwd: string;
  seenKeys: Set<string>;
  title: string | null;
  updatedAt: string;
  activeAbort: AbortController | null;
};
